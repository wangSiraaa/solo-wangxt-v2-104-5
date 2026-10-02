/** Non-cryptographic FNV-1a 64 content hash (hex) for the settings record. */
const MASK = (1n << 64n) - 1n;
const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;

export function fnv1a64(bytes: Uint8Array): string {
  let h = OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * SHA-256 content fingerprint (lower-case hex). This is the identity used by
 * handoff packages: profiles are deduplicated/verified by it and the package
 * manifest chains every blob to the header with it. Available in browsers and
 * Node >= 20 via WebCrypto.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // slice() normalizes the view to a fresh Uint8Array<ArrayBuffer> for WebCrypto.
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
