/**
 * Semantic validation of a structurally parsed handover package.
 *
 * The container layer (format.ts) proves "bytes untouched". This module proves
 * "the content is a legal, coherent soft-proofing project":
 *
 *  - format/version markers are supported;
 *  - exactly one image, one target ICC and one source-evidence ICC are present,
 *    nothing orphaned;
 *  - the image is a supported container, its content fingerprint matches, and
 *    it is NOT itself a converted export (provenance marker -> hard reject);
 *  - embedded-source packages: the ICC evidence byte-matches what is ACTUALLY
 *    embedded in the image (re-extracted, not trusted from the manifest);
 *  - assumed-source packages: the image genuinely has no embedded ICC and the
 *    operator assumption text + assumed ICC are present;
 *  - every referenced fingerprint resolves to an included, valid ICC binary;
 *  - target condition enums are legal.
 *
 * Nothing here touches IndexedDB. Any failure rejects the whole import before
 * the single atomic write is ever considered.
 */
import { detectContainer, extractEmbeddedICC } from '../icc/extractEmbedded';
import { detectProvenance } from '../icc/provenance';
import { readProfileInfo, type ColorSpaceKind } from '../icc/profileInfo';
import { isSha256Hex } from '../color/sha256';
import { APP_NAME, HANDOVER_FORMAT, HANDOVER_FORMAT_VERSION } from '../version';
import { entryKey, type PackageEntry, type ParsedPackage } from './format';
import type { HandoverIccEvidence, HandoverManifest } from './manifest';
import type { RenderingIntent } from '../color/lcms';

export class PackageValidationError extends Error {}

export interface ResolvedIcc {
  evidence: HandoverIccEvidence;
  data: Uint8Array;
  entry: PackageEntry;
}

export interface ValidatedPackage {
  manifest: HandoverManifest;
  image: {
    data: Uint8Array;
    container: string;
    name: string;
    sha256: string;
  };
  source:
    | { kind: 'embedded'; icc: ResolvedIcc }
    | { kind: 'assumed'; icc: ResolvedIcc; note: string; exportedFromProfileId: string };
  target: ResolvedIcc;
}

const INTENTS: RenderingIntent[] = ['perceptual', 'relative-colorimetric', 'saturation', 'absolute-colorimetric'];

function requireStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new PackageValidationError(`清单缺少字段：${field}`);
  return v;
}

/** Check an ICC evidence block against its included binary. */
function checkIcc(
  manifest: HandoverManifest,
  role: 'icc-embedded' | 'icc-source-assumed' | 'icc-target',
  ev: HandoverIccEvidence | undefined,
  entries: ParsedPackage['entries'],
  allowedSpaces: ColorSpaceKind[],
): ResolvedIcc {
  if (!ev) throw new PackageValidationError(`清单缺少 ${role} 配置证据`);
  requireStr(ev.description, `${role}.description`);
  if (!isSha256Hex(ev.sha256)) throw new PackageValidationError(`${role} 指纹不是合法 SHA-256`);
  if (typeof ev.byteLength !== 'number' || ev.byteLength <= 0) {
    throw new PackageValidationError(`${role} 字节长度非法`);
  }
  const entry = entries.get(entryKey(role, ev.sha256));
  if (!entry) throw new PackageValidationError(`清单引用的 ${role} 内容不在包内：${ev.sha256.slice(0, 12)}`);
  if (entry.data.byteLength !== ev.byteLength) {
    throw new PackageValidationError(`${role} 声明大小与实际不符`);
  }
  const info = readProfileInfo(entry.data);
  if (!info.valid) throw new PackageValidationError(`${role} 不是合法 ICC 配置`);
  if (!allowedSpaces.includes(info.colorSpace)) {
    throw new PackageValidationError(`${role} 色彩空间不允许：${info.colorSpace}`);
  }
  if (info.channels !== ev.channels || info.colorSpace !== ev.colorSpace) {
    throw new PackageValidationError(`${role} 清单声明的空间/通道与实际配置不符`);
  }
  if (ev.iccProfileId !== undefined && ev.iccProfileId !== info.profileId) {
    throw new PackageValidationError(`${role} ICC 头 profile id 与清单不符`);
  }
  // Descriptions are advisory, but a mismatch means the evidence was relabelled.
  if (ev.description && info.description && ev.description !== info.description) {
    throw new PackageValidationError(`${role} 配置描述被改写：清单「${ev.description}」实际「${info.description}」`);
  }
  void manifest;
  return { evidence: ev, data: entry.data, entry };
}

export async function validatePackage(parsed: ParsedPackage): Promise<ValidatedPackage> {
  const m = parsed.manifest;

  // ---- format markers -----------------------------------------------------
  if (m.packageFormat !== HANDOVER_FORMAT) {
    throw new PackageValidationError(`不支持的包格式：${String(m.packageFormat)}`);
  }
  if (m.packageFormatVersion !== HANDOVER_FORMAT_VERSION) {
    throw new PackageValidationError(
      `交接包格式版本 ${String(m.packageFormatVersion)} 与本机支持的 v${HANDOVER_FORMAT_VERSION} 不兼容`,
    );
  }
  if (m.app?.name !== APP_NAME) throw new PackageValidationError('包不是由 softproof-bench 生成');
  requireStr(m.app?.version, 'app.version');
  requireStr(m.createdAt, 'createdAt');
  requireStr(m.project?.name, 'project.name');
  requireStr(m.project?.savedAt, 'project.savedAt');

  // ---- condition enums ----------------------------------------------------
  if (!INTENTS.includes(m.condition?.intent)) throw new PackageValidationError('渲染意图非法');
  if (!INTENTS.includes(m.condition?.proofIntent)) throw new PackageValidationError('软打样意图非法');
  if (typeof m.condition?.blackPointCompensation !== 'boolean') {
    throw new PackageValidationError('黑点补偿标记非法');
  }

  // ---- entry role census (exact set, nothing missing/orphaned) ------------
  const census = new Map<string, number>();
  for (const e of parsed.entries.values()) census.set(e.role, (census.get(e.role) ?? 0) + 1);
  const sourceKind = m.source?.kind;
  if (sourceKind !== 'embedded' && sourceKind !== 'assumed') {
    throw new PackageValidationError('源依据类型必须是 embedded 或 assumed');
  }
  const expected: Record<string, number> = { image: 1, 'icc-target': 1 };
  if (sourceKind === 'embedded') expected['icc-embedded'] = 1;
  else expected['icc-source-assumed'] = 1;
  for (const role of ['image', 'icc-embedded', 'icc-source-assumed', 'icc-target'] as const) {
    const got = census.get(role) ?? 0;
    const want = expected[role] ?? 0;
    if (got !== want) {
      throw new PackageValidationError(`包内 ${role} 条目数量错误（需要 ${want}，实际 ${got}）`);
    }
  }

  // ---- image --------------------------------------------------------------
  const imgMeta = m.image;
  if (!imgMeta || !isSha256Hex(imgMeta.contentId)) throw new PackageValidationError('原图指纹缺失');
  const imgEntry = parsed.entries.get(entryKey('image', imgMeta.contentId));
  if (!imgEntry) throw new PackageValidationError('清单引用的原图不在包内');
  if (imgEntry.name !== imgMeta.name) throw new PackageValidationError('原图文件名与条目不一致');
  const container = detectContainer(imgEntry.data);
  if (container === 'unknown') throw new PackageValidationError('原图不是支持的 PNG/JPEG/WebP 容器');
  if (imgMeta.container !== container) throw new PackageValidationError('原图容器声明与实际不符');
  if (imgMeta.bitDepth !== 8 && imgMeta.bitDepth !== 16) throw new PackageValidationError('原图位深非法');
  if (imgMeta.hadProvenanceMarker) {
    throw new PackageValidationError('包内图片带“已转换”标记：交接包必须携带原图，不能用转换结果冒充母版');
  }
  // Re-run the actual marker detector; a manifest claiming "false" cannot
  // launder a converted file through the handover path.
  const prov = detectProvenance(imgEntry.data);
  if (prov.converted) {
    throw new PackageValidationError('检出图片实际带有“已转换”标记：拒绝作为原图导入（防止二次转换）');
  }

  // ---- source evidence ----------------------------------------------------
  let source: ValidatedPackage['source'];
  const embeddedHere = extractEmbeddedICC(imgEntry.data);
  if (sourceKind === 'embedded') {
    const icc = checkIcc(m, 'icc-embedded', m.source.embedded, parsed.entries, ['RGB', 'CMYK', 'GRAY']);
    if (!embeddedHere) {
      throw new PackageValidationError('源依据声明为嵌入，但原图中实际提取不到嵌入 ICC');
    }
    if (embeddedHere.byteLength !== icc.data.byteLength) {
      throw new PackageValidationError('嵌入源配置证据与图片实际嵌入的字节数不一致');
    }
    let same = true;
    for (let i = 0; i < embeddedHere.length; i++) {
      if (embeddedHere[i] !== icc.data[i]) {
        same = false;
        break;
      }
    }
    if (!same) throw new PackageValidationError('嵌入源配置证据与图片实际嵌入的 ICC 字节不一致');
    if (m.source.assumed) throw new PackageValidationError('embedded 源依据不应携带人工假设块');
    source = { kind: 'embedded', icc };
  } else {
    const icc = checkIcc(m, 'icc-source-assumed', m.source.assumed, parsed.entries, ['RGB', 'GRAY']);
    if (embeddedHere) {
      throw new PackageValidationError('源依据声明为人工假设，但原图实际带嵌入 ICC（依据不成立）');
    }
    const note = m.source.assumed!.note;
    const exportedFromProfileId = m.source.assumed!.exportedFromProfileId;
    if (typeof note !== 'string' || note.trim().length === 0) {
      throw new PackageValidationError('人工源假设缺少说明文字（来源依据不完整）');
    }
    if (typeof exportedFromProfileId !== 'string' || exportedFromProfileId.length === 0) {
      throw new PackageValidationError('人工源假设缺少来源配置标识');
    }
    if (m.source.embedded) throw new PackageValidationError('assumed 源依据不应携带嵌入证据块');
    source = { kind: 'assumed', icc, note, exportedFromProfileId };
  }

  // ---- target -------------------------------------------------------------
  const target = checkIcc(m, 'icc-target', m.target?.profile, parsed.entries, ['RGB', 'CMYK', 'GRAY']);

  return {
    manifest: m,
    image: { data: imgEntry.data, container, name: imgMeta.name, sha256: imgMeta.contentId },
    source,
    target,
  };
}
