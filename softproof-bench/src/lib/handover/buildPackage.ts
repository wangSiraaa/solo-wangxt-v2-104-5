/**
 * Build a verifiable handover package from the current working project.
 *
 * The export refuses anything that would make the package non-reproducible:
 *  - an image carrying the converted-file marker (must be an original);
 *  - a "manual assumption" source without the assumed ICC bytes and note;
 *  - an "embedded" source whose ICC cannot be re-extracted from the image.
 *
 * Every binary is fingerprinted at build time and the same content appears once
 * even if the assumed source equals the target.
 */
import { encodePackage, type PackageEntry } from './format';
import type { HandoverIccEvidence, HandoverManifest } from './manifest';
import { sha256 } from '../color/sha256';
import { detectContainer, extractEmbeddedICC } from '../icc/extractEmbedded';
import { detectProvenance } from '../icc/provenance';
import { readProfileInfo } from '../icc/profileInfo';
import { APP_NAME, APP_VERSION, HANDOVER_FORMAT, HANDOVER_FORMAT_VERSION } from '../version';
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';
import type { StoredProfile } from '../db/db';

export interface BuildPackageInput {
  projectName: string;
  savedAt: string;
  imageBytes: Uint8Array;
  imageName: string;
  bitDepth: 8 | 16;
  /** Effective source: embedded bytes or the chosen library profile. */
  sourceKind: 'embedded' | 'assumed';
  /** Required when sourceKind === 'assumed'. */
  assumedProfile?: StoredProfile;
  assumptionNote?: string;
  targetProfile: StoredProfile;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
}

export class PackageBuildError extends Error {}

function iccEvidence(colorSpace: ColorSpaceKind, channels: number,
  description: string, byteLength: number, sha256Hex: string, iccProfileId?: string): HandoverIccEvidence {
  return { iccProfileId, description, colorSpace, channels, byteLength, sha256: sha256Hex };
}

export async function buildHandoverPackage(input: BuildPackageInput): Promise<{ bytes: Uint8Array; manifest: HandoverManifest }> {
  const nowIso = input.savedAt;

  // ---- image legitimacy ---------------------------------------------------
  const container = detectContainer(input.imageBytes);
  if (container === 'unknown') throw new PackageBuildError('原图不是支持的 PNG/JPEG/WebP，无法交接');
  if (detectProvenance(input.imageBytes).converted) {
    throw new PackageBuildError('该图像带“已转换”标记，只能作为转换结果，不能作为原图交接');
  }
  const embedded = extractEmbeddedICC(input.imageBytes);
  if (input.sourceKind === 'embedded') {
    if (!embedded) throw new PackageBuildError('源依据为嵌入配置，但图片中提取不到嵌入 ICC');
  } else {
    if (embedded) {
      throw new PackageBuildError('图片实际带嵌入 ICC，不能再以“人工假设”作为源依据交接');
    }
    if (!input.assumedProfile) throw new PackageBuildError('人工假设源缺少配置二进制，无法携带来源依据');
    if (!input.assumptionNote || input.assumptionNote.trim().length === 0) {
      throw new PackageBuildError('人工假设源缺少说明文字');
    }
  }

  // ---- fingerprints -------------------------------------------------------
  const imageSha = await sha256(input.imageBytes);
  const entries: PackageEntry[] = [{ role: 'image', name: input.imageName, sha256Hex: imageSha, data: input.imageBytes }];

  let sourceBlock: HandoverManifest['source'];
  if (input.sourceKind === 'embedded') {
    const data = embedded!;
    const hex = await sha256(data);
    const info = readProfileInfo(data);
    if (!info.valid) throw new PackageBuildError('图片嵌入的 ICC 不合法');
    entries.push({ role: 'icc-embedded', name: `embedded-${hex.slice(0, 12)}.icc`, sha256Hex: hex, data });
    sourceBlock = {
      kind: 'embedded',
      embedded: iccEvidence(info.colorSpace, info.channels,
        info.description || '嵌入配置', data.byteLength, hex, info.profileId || undefined),
    };
  } else {
    const p = input.assumedProfile!;
    const hex = p.sha256 ?? (await sha256(p.bytes));
    const info = readProfileInfo(p.bytes);
    if (!info.valid) throw new PackageBuildError('人工假设源 ICC 不合法');
    if (info.colorSpace !== 'RGB' && info.colorSpace !== 'GRAY') {
      throw new PackageBuildError('源假设配置必须是 RGB 或灰阶');
    }
    const srcEntry: PackageEntry = { role: 'icc-source-assumed', name: `${sanitize(p.description)}.icc`, sha256Hex: hex, data: p.bytes };
    entries.push(srcEntry);
    sourceBlock = {
      kind: 'assumed',
      assumed: {
        ...iccEvidence(info.colorSpace, info.channels, p.description, p.bytes.byteLength, hex, info.profileId || undefined),
        note: input.assumptionNote!,
        exportedFromProfileId: p.id,
      },
    };
  }

  // target: always a distinct role entry even when its bytes happen to equal
  // the assumed source (entries are keyed by `${role}:${sha256}`).
  const t = input.targetProfile;
  const targetHex = t.sha256 ?? (await sha256(t.bytes));
  const tInfo = readProfileInfo(t.bytes);
  if (!tInfo.valid) throw new PackageBuildError('目标 ICC 不合法');
  if (tInfo.colorSpace !== 'RGB' && tInfo.colorSpace !== 'CMYK' && tInfo.colorSpace !== 'GRAY') {
    throw new PackageBuildError('目标配置必须是 RGB/CMYK/灰阶');
  }
  const targetEntry: PackageEntry = { role: 'icc-target', name: `${sanitize(t.description)}.icc`, sha256Hex: targetHex, data: t.bytes };
  entries.push(targetEntry);

  const manifest: HandoverManifest = {
    packageFormat: HANDOVER_FORMAT,
    packageFormatVersion: HANDOVER_FORMAT_VERSION,
    app: { name: APP_NAME, version: APP_VERSION },
    createdAt: new Date().toISOString(),
    project: { name: input.projectName, savedAt: nowIso },
    image: {
      name: input.imageName,
      bitDepth: input.bitDepth,
      container,
      contentId: imageSha,
      hadProvenanceMarker: false,
    },
    source: sourceBlock,
    target: {
      profile: iccEvidence(
        tInfo.colorSpace, tInfo.channels, t.description, t.bytes.byteLength, targetHex, tInfo.profileId || undefined,
      ),
    },
    condition: {
      intent: input.intent,
      blackPointCompensation: input.blackPointCompensation,
      proofIntent: input.proofIntent,
    },
    // encodePackage regenerates this from the actual entries.
    entries: [],
  };

  const bytes = await encodePackage(manifest, entries);
  return { bytes, manifest };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'profile';
}
