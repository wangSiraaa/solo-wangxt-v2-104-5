/**
 * Build and parse/verify handoff packages. Pure (no IndexedDB, no DOM) so the
 * same code runs in the browser, in the Web Worker era of the app, and in
 * Node unit tests.
 *
 * Import discipline: `parseHandoffPackage` performs the COMPLETE validation
 * (structure, fingerprints, manifest↔content association) before returning
 * anything. Callers must treat a throw as "write nothing".
 */
import { sha256Hex } from '../color/hash';
import { detectContainer, extractEmbeddedICC } from '../icc/extractEmbedded';
import { detectProvenance } from '../icc/provenance';
import { readProfileInfo } from '../icc/profileInfo';
import { RENDERING_INTENTS, type RenderingIntent } from '../color/intents';
import { DISCLAIMER } from '../color/record';
import {
  HANDOFF_FORMAT,
  HANDOFF_MAGIC,
  HEADER_BYTES,
  type HandoffBlobRef,
  type HandoffManifest,
  type HandoffProfileEntry,
  type ParsedHandoff,
} from './format';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class HandoffValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`交接包校验失败（${issues.length} 项）：${issues.join('；')}`);
    this.name = 'HandoffValidationError';
    this.issues = issues;
  }
}

export interface HandoffBuildInput {
  projectName: string;
  imageName: string;
  imageBytes: Uint8Array;
  /** Embedded source ICC when the image carries one (else null). */
  embeddedICC: Uint8Array | null;
  /** How the source side was decided. */
  source:
    | { kind: 'embedded' }
    | {
        kind: 'assumed';
        profile: { bytes: Uint8Array; description: string; fileName?: string; origin: 'builtin-open' | 'user-imported' };
        note: string;
      };
  targetProfile: { bytes: Uint8Array; description: string; fileName?: string; origin: 'builtin-open' | 'user-imported' };
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
  /** Provenance marker state of the image bytes (converted exports stay marked). */
  provenance: { converted: boolean; detail?: string };
  appVersion: string;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function profileEntry(
  bytes: Uint8Array,
  fileName: string,
  origin: HandoffProfileEntry['origin'],
  offset: number,
): Promise<HandoffProfileEntry> {
  const info = readProfileInfo(bytes);
  if (!info.valid) throw new Error(`无法打包：${fileName} 不是有效的 ICC 配置`);
  const sha256 = await sha256Hex(bytes);
  return {
    // Refs are namespaced by origin so identical bytes can appear once as
    // embedded evidence AND once as a library profile without role confusion;
    // both entries then share a single blob in the blob area.
    ref: `${origin === 'embedded' ? 'embedded' : 'sha256'}:${sha256}`,
    offset,
    length: bytes.byteLength,
    sha256,
    description: info.description || fileName,
    colorSpace: info.colorSpace,
    channels: info.channels,
    headerProfileId: info.profileId,
    fileName,
    origin,
  };
}

/** Assemble a handoff package: header + manifest + blob area. */
export async function buildHandoffPackage(input: HandoffBuildInput): Promise<Uint8Array> {
  // ---- gather blobs (deduplicated by content fingerprint) ----
  const blobs: Uint8Array[] = [];
  const refByHash = new Map<string, HandoffBlobRef>();
  const addBlob = async (bytes: Uint8Array): Promise<HandoffBlobRef> => {
    const sha256 = await sha256Hex(bytes);
    const existing = refByHash.get(sha256);
    if (existing) return existing;
    const offset = blobs.reduce((a, b) => a + b.byteLength, 0);
    const ref: HandoffBlobRef = { offset, length: bytes.byteLength, sha256 };
    refByHash.set(sha256, ref);
    blobs.push(bytes);
    return ref;
  };

  const imageRef = await addBlob(input.imageBytes);
  const embeddedRef = input.embeddedICC ? await addBlob(input.embeddedICC) : null;

  const profiles: HandoffProfileEntry[] = [];
  const profileRefSet = new Set<string>();
  const addProfile = async (
    bytes: Uint8Array,
    fileName: string,
    origin: HandoffProfileEntry['origin'],
  ): Promise<string> => {
    const blob = await addBlob(bytes);
    const tentative = `${origin === 'embedded' ? 'embedded' : 'sha256'}:${blob.sha256}`;
    if (profileRefSet.has(tentative)) return tentative;
    const entry = await profileEntry(bytes, fileName, origin, blob.offset);
    profiles.push(entry);
    profileRefSet.add(entry.ref);
    return entry.ref;
  };

  let source: HandoffManifest['project']['source'];
  if (input.source.kind === 'embedded') {
    if (!input.embeddedICC) throw new Error('无法打包：声明了嵌入源配置但图片没有嵌入 ICC');
    const ref = await addProfile(input.embeddedICC, `embedded:${input.imageName}`, 'embedded');
    source = { kind: 'embedded', profileRef: ref };
  } else {
    const p = input.source.profile;
    const ref = await addProfile(p.bytes, p.fileName ?? `${p.description}.icc`, p.origin);
    source = { kind: 'assumed', profileRef: ref, note: input.source.note };
  }
  const t = input.targetProfile;
  const targetProfileRef = await addProfile(t.bytes, t.fileName ?? `${t.description}.icc`, t.origin);

  const manifest: HandoffManifest = {
    format: HANDOFF_FORMAT,
    createdAt: new Date().toISOString(),
    application: { name: 'softproof-bench', version: input.appVersion },
    project: {
      name: input.projectName,
      imageName: input.imageName,
      image: imageRef,
      embeddedICC: embeddedRef,
      source,
      targetProfileRef,
      intent: input.intent,
      blackPointCompensation: input.blackPointCompensation,
      proofIntent: input.proofIntent,
      imageProvenance: input.provenance,
    },
    profiles,
    disclaimer: DISCLAIMER,
  };

  const manifestBytes = enc.encode(JSON.stringify(manifest));
  const manifestHash = await sha256Hex(manifestBytes);
  const total = HEADER_BYTES + manifestBytes.byteLength + blobs.reduce((a, b) => a + b.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(enc.encode(HANDOFF_MAGIC), 0);
  out.set(u32le(manifestBytes.byteLength), 8);
  out.set(hexToBytes(manifestHash), 12);
  out.set(manifestBytes, HEADER_BYTES);
  let p = HEADER_BYTES + manifestBytes.byteLength;
  for (const b of blobs) {
    out.set(b, p);
    p += b.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing & full verification
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const INTENTS = new Set<string>(RENDERING_INTENTS);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkBlobRef(v: unknown, label: string, blobArea: number, issues: string[]): HandoffBlobRef | null {
  if (!isObj(v)) {
    issues.push(`清单字段 ${label} 缺失或不是对象`);
    return null;
  }
  const before = issues.length;
  const { offset, length, sha256 } = v as Record<string, unknown>;
  if (!Number.isInteger(offset) || (offset as number) < 0) issues.push(`清单字段 ${label}.offset 非法`);
  if (!Number.isInteger(length) || (length as number) <= 0) issues.push(`清单字段 ${label}.length 非法`);
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) issues.push(`清单字段 ${label}.sha256 不是 64 位十六进制指纹`);
  if (issues.length !== before) return null;
  const ref = v as unknown as HandoffBlobRef;
  if (ref.offset + ref.length > blobArea) {
    issues.push(`清单字段 ${label} 指向包体之外（包可能被截断）`);
    return null;
  }
  return ref;
}

/**
 * Parse and FULLY verify a handoff package. Throws HandoffValidationError
 * listing every problem found; returns the verified content only when the
 * manifest, all fingerprints and all content associations check out.
 */
export async function parseHandoffPackage(bytes: Uint8Array): Promise<ParsedHandoff> {
  const issues: string[] = [];

  // ---- header ----
  if (bytes.byteLength < HEADER_BYTES) {
    throw new HandoffValidationError([`文件太小（${bytes.byteLength} B），不是有效的交接包`]);
  }
  if (dec.decode(bytes.subarray(0, 8)) !== HANDOFF_MAGIC) {
    throw new HandoffValidationError(['文件头标识不符：不是 softproof-bench 交接包']);
  }
  const manifestLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (manifestLen === 0 || HEADER_BYTES + manifestLen > bytes.byteLength) {
    throw new HandoffValidationError(['清单长度字段越界：包被截断或长度字段被篡改']);
  }
  const manifestBytes = bytes.subarray(HEADER_BYTES, HEADER_BYTES + manifestLen);
  const declaredHash = [...bytes.subarray(12, 44)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const manifestHash = await sha256Hex(manifestBytes);
  if (manifestHash !== declaredHash) {
    throw new HandoffValidationError(['清单指纹不匹配：包内容被篡改或已损坏']);
  }

  let manifest: HandoffManifest;
  try {
    manifest = JSON.parse(dec.decode(manifestBytes)) as HandoffManifest;
  } catch {
    throw new HandoffValidationError(['清单 JSON 无法解析']);
  }

  // ---- manifest structure ----
  if (manifest?.format !== HANDOFF_FORMAT) {
    const f = typeof manifest?.format === 'string' ? manifest.format : String(manifest?.format);
    issues.push(
      f.startsWith('softproof-bench-handoff/')
        ? `不支持的交接包格式版本：${f}（本机支持 ${HANDOFF_FORMAT}）`
        : `清单 format 字段非法：${f}`,
    );
  }
  if (!isObj(manifest?.application) || manifest.application.name !== 'softproof-bench') {
    issues.push('清单 application 字段非法');
  }
  if (typeof manifest?.createdAt !== 'string' || !manifest.createdAt) issues.push('清单缺少 createdAt');
  const proj = manifest?.project;
  if (!isObj(proj)) {
    issues.push('清单缺少 project 段');
    throw new HandoffValidationError(issues);
  }
  if (typeof proj.name !== 'string' || !proj.name.trim()) issues.push('工程名为空');
  if (typeof proj.imageName !== 'string' || !proj.imageName.trim()) issues.push('图片文件名为空');
  if (!INTENTS.has(proj.intent as string)) issues.push(`渲染意图非法：${String(proj.intent)}`);
  if (!INTENTS.has(proj.proofIntent as string)) issues.push(`软打样模拟意图非法：${String(proj.proofIntent)}`);
  if (typeof proj.blackPointCompensation !== 'boolean') issues.push('blackPointCompensation 字段非法');
  if (!isObj(proj.imageProvenance) || typeof proj.imageProvenance.converted !== 'boolean') {
    issues.push('imageProvenance 字段非法');
  }
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0) {
    issues.push('清单 profiles 列表为空：交接包必须携带所需 ICC 二进制');
  }

  const blobArea = bytes.byteLength - HEADER_BYTES - manifestLen;
  const imageRef = checkBlobRef(proj.image, 'project.image', blobArea, issues);
  const embeddedRef =
    proj.embeddedICC === null ? null : checkBlobRef(proj.embeddedICC, 'project.embeddedICC', blobArea, issues);

  const entries: HandoffProfileEntry[] = [];
  const seenRefs = new Set<string>();
  if (Array.isArray(manifest.profiles)) {
    manifest.profiles.forEach((e, i) => {
      const label = `profiles[${i}]`;
      const ref = checkBlobRef(e, label, blobArea, issues);
      if (!ref) return;
      if (!['embedded', 'builtin-open', 'user-imported'].includes(e.origin as string)) {
        issues.push(`${label}.origin 非法：${String(e.origin)}`);
      }
      const expectedRef = `${e.origin === 'embedded' ? 'embedded' : 'sha256'}:${e.sha256}`;
      if (typeof e.ref !== 'string' || e.ref !== expectedRef) {
        issues.push(`${label}.ref 与其指纹/来源不一致`);
      }
      if (seenRefs.has(e.ref)) issues.push(`${label} 引用标识重复：${e.ref}`);
      seenRefs.add(e.ref);
      if (typeof e.description !== 'string' || !e.description) issues.push(`${label}.description 缺失`);
      if (typeof e.fileName !== 'string' || !e.fileName) issues.push(`${label}.fileName 缺失`);
      entries.push(e);
    });
  }

  const source = proj.source;
  let sourceRef: string | null = null;
  if (!isObj(source) || (source.kind !== 'embedded' && source.kind !== 'assumed')) {
    issues.push('project.source 必须声明 embedded 或 assumed 来源');
  } else {
    if (typeof source.profileRef !== 'string' || !seenRefs.has(source.profileRef)) {
      issues.push('project.source.profileRef 未指向清单中的配置');
    } else {
      sourceRef = source.profileRef;
    }
    if (source.kind === 'assumed' && typeof source.note !== 'string') {
      issues.push('project.source.note 缺失：人工假设必须携带说明');
    }
    if (source.kind === 'embedded' && embeddedRef === null) {
      issues.push('project.source 声明为嵌入配置，但清单没有内嵌 ICC 数据');
    }
  }
  if (typeof proj.targetProfileRef !== 'string' || !seenRefs.has(proj.targetProfileRef)) {
    issues.push('project.targetProfileRef 未指向清单中的配置');
  }
  // every shipped profile must be referenced (no unaccounted binaries)
  const referenced = new Set<string>();
  if (sourceRef) referenced.add(sourceRef);
  if (typeof proj.targetProfileRef === 'string') referenced.add(proj.targetProfileRef);
  for (const e of entries) {
    if (!referenced.has(e.ref)) issues.push(`配置 ${e.description} 在清单中未被工程引用`);
  }
  if (issues.length) throw new HandoffValidationError(issues);

  // ---- blob fingerprints ----
  const blobBase = HEADER_BYTES + manifestLen;
  const blobAt = (ref: HandoffBlobRef) => bytes.subarray(blobBase + ref.offset, blobBase + ref.offset + ref.length);
  const verifyBlob = async (ref: HandoffBlobRef, label: string): Promise<void> => {
    const actual = await sha256Hex(blobAt(ref));
    if (actual !== ref.sha256) issues.push(`${label} 内容指纹不匹配（期望 ${ref.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
  };
  await verifyBlob(imageRef!, '图片');
  if (embeddedRef) await verifyBlob(embeddedRef, '内嵌 ICC');
  for (const e of entries) await verifyBlob(e, `配置 ${e.description}`);
  if (issues.length) throw new HandoffValidationError(issues);

  // ---- manifest ↔ content association ----
  const imageBytes = blobAt(imageRef!);
  const container = detectContainer(imageBytes);
  if (container === 'unknown') issues.push('包内图片不是支持的 PNG/JPEG/WebP 格式');

  const extracted = container === 'unknown' ? null : extractEmbeddedICC(imageBytes);
  if (embeddedRef === null && extracted !== null) {
    issues.push('清单声明图片无嵌入配置，但包内图片实际含有嵌入 ICC');
  }
  if (embeddedRef !== null) {
    if (extracted === null) {
      issues.push('清单声明了嵌入配置，但包内图片实际不含嵌入 ICC');
    } else {
      const extractedHash = await sha256Hex(extracted);
      if (extractedHash !== embeddedRef.sha256) {
        issues.push('清单中的嵌入配置指纹与图片实际嵌入的 ICC 不一致');
      }
    }
  }

  const provenance = detectProvenance(imageBytes);
  if (provenance.converted !== proj.imageProvenance.converted) {
    issues.push(
      `清单声明的转换标记状态（${proj.imageProvenance.converted ? '已转换' : '未转换'}）与图片实际内容不符`,
    );
  }

  const profiles: ParsedHandoff['profiles'] = [];
  for (const e of entries) {
    const bytes2 = blobAt(e);
    const info = readProfileInfo(bytes2);
    if (!info.valid) {
      issues.push(`配置 ${e.description} 不是有效的 ICC 文件`);
      continue;
    }
    if (info.colorSpace !== e.colorSpace) issues.push(`配置 ${e.description} 色彩空间与清单声明不符`);
    if (info.channels !== e.channels) issues.push(`配置 ${e.description} 通道数与清单声明不符`);
    if (e.headerProfileId && info.profileId && e.headerProfileId !== info.profileId) {
      issues.push(`配置 ${e.description} 头部 profile id 与清单声明不符`);
    }
    profiles.push({ entry: e, bytes: bytes2 });
  }

  // source/target role consistency
  const byRef = new Map(profiles.map((p) => [p.entry.ref, p]));
  if (sourceRef) {
    const sp = byRef.get(sourceRef);
    if (sp) {
      if (source.kind === 'embedded') {
        if (sp.entry.origin !== 'embedded') issues.push('源配置声明为嵌入，但对应配置条目的 origin 不是 embedded');
        if (embeddedRef && sp.entry.sha256 !== embeddedRef.sha256) {
          issues.push('源配置条目与嵌入 ICC 不是同一份数据');
        }
      } else if (sp.entry.origin === 'embedded') {
        issues.push('源配置声明为人工假设，但对应配置条目标记为嵌入');
      }
    }
  }
  const targetEntry = byRef.get(proj.targetProfileRef);
  if (targetEntry?.entry.origin === 'embedded') issues.push('目标配置不能使用图片内嵌条目');

  if (issues.length) throw new HandoffValidationError(issues);

  return {
    manifest,
    manifestHash,
    imageBytes,
    embeddedICC: embeddedRef ? blobAt(embeddedRef) : null,
    profiles,
  };
}
