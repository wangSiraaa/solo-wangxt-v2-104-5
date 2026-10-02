/**
 * Cryptographic content fingerprints for handover packages.
 *
 * Uses Web Crypto (SubtleCrypto.digest SHA-256), available in both secure
 * browser contexts and Node 20+ globalThis.crypto. Unlike the FNV-1a helper in
 * color/hash.ts (which only detects accidental changes in the settings record),
 * SHA-256 makes a tampered or truncated package computationally infeasible to
 * repair byte-for-byte: any edit changes both the blob fingerprint and the
 * outer package digest.
 */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}
