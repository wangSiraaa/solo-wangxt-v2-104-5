/**
 * Binary container for handover packages.
 *
 *   offset  size  field
 *   0       8     magic            "SPBPKG01"
 *   8       4     manifestLength   u32 BE
 *   12      4     entryCount       u32 BE
 *   16      N     manifest JSON    UTF-8 (N = manifestLength)
 *   ...           entries:
 *                   u16 BE roleLength, role ASCII
 *                   32 bytes raw SHA-256
 *                   u16 BE nameLength, name UTF-8
 *                   u32 BE dataLength, data
 *   end-40  8     footer magic     "SPBEND01"
 *   end-32  32    SHA-256 over every byte preceding the footer
 *
 * Two independent integrity layers:
 *  - the outer footer digest fails on ANY edit, truncation or append;
 *  - per-entry SHA-256 fingerprints (also referenced by the manifest) let the
 *    importer pin each binary and report which exact content was tampered with.
 *
 * Parsing never trusts header-derived offsets without bounds checking and never
 * allocates from claimed lengths beyond the actual buffer.
 */
import type { EntryRole, HandoverEntryMeta, HandoverManifest } from './manifest';

export const PKG_MAGIC = new TextEncoder().encode('SPBPKG01');
export const END_MAGIC = new TextEncoder().encode('SPBEND01');
const FOOTER_LEN = 8 + 32;

export interface PackageEntry {
  role: EntryRole;
  name: string;
  sha256Hex: string;
  data: Uint8Array;
}

export class PackageFormatError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Serialise a manifest + entries. The manifest's `entries` table is regenerated
 * from the actual binaries, so it can never disagree with the payload.
 */
export async function encodePackage(manifest: HandoverManifest, entries: PackageEntry[]): Promise<Uint8Array> {
  // Rebuild the entry table from actual content; caller-provided table is
  // informational and must match (buildPackage is the normal producer).
  const rebuilt: HandoverEntryMeta[] = [];
  for (const e of entries) {
    rebuilt.push({ role: e.role, sha256: e.sha256Hex, byteLength: e.data.byteLength, name: e.name });
  }
  const manifestOut: HandoverManifest = { ...manifest, entries: rebuilt };
  const manifestBytes = enc.encode(JSON.stringify(manifestOut));

  const parts: Uint8Array[] = [];
  const header = new Uint8Array(16);
  header.set(PKG_MAGIC, 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(8, manifestBytes.length);
  dv.setUint32(12, entries.length);
  parts.push(header, manifestBytes);

  for (const e of entries) {
    const roleB = enc.encode(e.role);
    const nameB = enc.encode(e.name);
    if (roleB.length > 0xffff || nameB.length > 0xffff || e.data.byteLength > 0xffffffff) {
      throw new PackageFormatError('交接包条目过大');
    }
    const head = new Uint8Array(2 + roleB.length + 32 + 2 + nameB.length + 4);
    const hv = new DataView(head.buffer);
    let o = 0;
    hv.setUint16(o, roleB.length);
    o += 2;
    head.set(roleB, o);
    o += roleB.length;
    const digest = await crypto.subtle.digest('SHA-256', e.data as BufferSource);
    head.set(new Uint8Array(digest), o);
    o += 32;
    hv.setUint16(o, nameB.length);
    o += 2;
    head.set(nameB, o);
    o += nameB.length;
    hv.setUint32(o, e.data.byteLength);
    parts.push(head, e.data);
  }

  const body = concat(parts);
  const bodyDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', body as BufferSource));
  const footer = new Uint8Array(FOOTER_LEN);
  footer.set(END_MAGIC, 0);
  footer.set(bodyDigest, 8);
  return concat([body, footer]);
}

export interface ParsedPackage {
  manifest: HandoverManifest;
  /** Keyed by `${role}:${sha256}` - every role/fingerprint is unique. */
  entries: Map<string, PackageEntry>;
}

export function entryKey(role: EntryRole, sha256Hex: string): string {
  return `${role}:${sha256Hex}`;
}

const KNOWN_ROLES: EntryRole[] = ['image', 'icc-embedded', 'icc-source-assumed', 'icc-target'];

/**
 * Parse AND fully verify the container: outer digest, per-entry fingerprints,
 * and structural agreement with the manifest's entry table.
 *
 * Throws PackageFormatError on the FIRST problem. Nothing IndexedDB-related
 * happens here; callers reject the import when this throws, which alone
 * guarantees no half project can ever be persisted.
 */
export async function parsePackage(file: Uint8Array): Promise<ParsedPackage> {
  const b = file;
  if (b.byteLength < 16 + FOOTER_LEN) throw new PackageFormatError('交接包过短或已截断');
  if (!bytesEqual(b.subarray(0, 8), PKG_MAGIC)) throw new PackageFormatError('不是 softproof-bench 交接包（魔数不匹配）');
  if (!bytesEqual(b.subarray(b.length - FOOTER_LEN, b.length - 32), END_MAGIC)) {
    throw new PackageFormatError('交接包尾部缺失或已截断');
  }

  // 1. Outer digest over everything except the footer. Any byte edit/truncation
  //    fails here before a single structure is trusted.
  const body = b.subarray(0, b.length - FOOTER_LEN);
  const wantDigest = b.subarray(b.length - 32);
  const gotDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', body as BufferSource));
  if (!bytesEqual(wantDigest, gotDigest)) {
    throw new PackageFormatError('交接包整体校验失败：内容被篡改或传输不完整');
  }

  const manifestLen = u32(b, 8);
  const entryCount = u32(b, 12);
  if (16 + manifestLen > body.length) throw new PackageFormatError('清单长度越界（包损坏）');
  if (entryCount > 1024) throw new PackageFormatError('条目数量异常');

  let manifest: HandoverManifest;
  try {
    manifest = JSON.parse(dec.decode(b.subarray(16, 16 + manifestLen))) as HandoverManifest;
  } catch {
    throw new PackageFormatError('清单不是合法 JSON');
  }
  if (!manifest || typeof manifest !== 'object') throw new PackageFormatError('清单结构缺失');
  if (!Array.isArray(manifest.entries)) throw new PackageFormatError('清单缺少条目表');

  // 2. Walk entries using ONLY header-derived offsets, bounds-checking each.
  const entries = new Map<string, PackageEntry>();
  let off = 16 + manifestLen;
  for (let i = 0; i < entryCount; i++) {
    if (off + 2 > body.length) throw new PackageFormatError(`条目 ${i} 头部越界（截断）`);
    const roleLen = u16(b, off);
    off += 2;
    if (off + roleLen + 32 + 2 > body.length) throw new PackageFormatError(`条目 ${i} 不完整（截断）`);
    const role = dec.decode(b.subarray(off, off + roleLen));
    off += roleLen;
    if (!KNOWN_ROLES.includes(role as EntryRole)) throw new PackageFormatError(`未知条目类型：${role}`);
    const digest = b.subarray(off, off + 32);
    off += 32;
    const nameLen = u16(b, off);
    off += 2;
    if (off + nameLen + 4 > body.length) throw new PackageFormatError(`条目 ${i} 名称越界（截断）`);
    const name = dec.decode(b.subarray(off, off + nameLen));
    off += nameLen;
    const dataLen = u32(b, off);
    off += 4;
    if (off + dataLen > body.length) throw new PackageFormatError(`条目 ${i} 数据越界（截断）`);
    const data = b.slice(off, off + dataLen); // copy: caller may outlive the file buffer
    off += dataLen;

    // 3. Per-entry fingerprint. A tampered single binary is identified exactly.
    const got = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
    if (!bytesEqual(digest, got)) {
      throw new PackageFormatError(`条目「${name}」(${role}) 指纹不匹配：内容被篡改`);
    }
    const sha256Hex = [...digest].map((x) => x.toString(16).padStart(2, '0')).join('');
    const key = entryKey(role as EntryRole, sha256Hex);
    if (entries.has(key)) throw new PackageFormatError(`重复条目：${key}`);
    entries.set(key, { role: role as EntryRole, name, sha256Hex, data });
  }
  if (off !== body.length) throw new PackageFormatError('包尾部存在未声明的多余字节（可能被追加篡改）');

  // 4. Structural agreement: manifest entry table == actual entries exactly.
  if (manifest.entries.length !== entryCount) {
    throw new PackageFormatError('清单条目数与实际内容不一致');
  }
  for (const meta of manifest.entries) {
    const e = entries.get(entryKey(meta.role, meta.sha256));
    if (!e) throw new PackageFormatError(`清单引用了缺失的内容：${meta.role} ${meta.sha256.slice(0, 12)}`);
    if (e.name !== meta.name) throw new PackageFormatError(`条目名称与清单不一致：${meta.role}`);
    if (e.data.byteLength !== meta.byteLength) {
      throw new PackageFormatError(`条目大小与清单不一致：${meta.role} ${meta.sha256.slice(0, 12)}`);
    }
  }

  return { manifest, entries };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
