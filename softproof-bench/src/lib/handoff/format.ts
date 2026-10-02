/**
 * Handoff package ("工程交接包") format: constants and manifest types.
 *
 * A handoff package is a single binary file that carries everything another
 * offline browser needs to continue soft-proofing a project with evidence:
 *
 *   - the ORIGINAL image bytes (never a converted export),
 *   - the source-profile evidence (embedded ICC, or the operator's recorded
 *     assumption with the exact profile bytes),
 *   - every required ICC binary plus its SHA-256 fingerprint,
 *   - the target conditions (target profile, rendering intent, BPC, proof
 *     intent) and project metadata,
 *   - a format version so future readers can reject/migrate explicitly.
 *
 * Binary layout (all integers little-endian):
 *
 *   offset 0   8 bytes   magic "SPBPKG01"
 *   offset 8   4 bytes   manifest length N (bytes)
 *   offset 12  32 bytes  SHA-256 of the manifest bytes
 *   offset 44  N bytes   manifest JSON (UTF-8)
 *   offset 44+N  ...     blob area; every blob is referenced from the manifest
 *                        by {offset, length, sha256} relative to its start
 *
 * Verification chain: header hash pins the manifest; the manifest pins every
 * blob. Truncation and tampering are therefore always detected before any
 * byte reaches IndexedDB.
 */
import type { RenderingIntent } from '../color/intents';
import type { ColorSpaceKind } from '../icc/profileInfo';

export const HANDOFF_FORMAT = 'softproof-bench-handoff/1';
export const HANDOFF_MAGIC = 'SPBPKG01';
export const HANDOFF_FILE_EXT = '.spkg';
export const HANDOFF_MIME = 'application/x.softproof-bench-handoff';

/** magic(8) + manifest length(4) + manifest SHA-256(32) */
export const HEADER_BYTES = 44;

/** Reference to a blob inside the package blob area. */
export interface HandoffBlobRef {
  /** Offset relative to the start of the blob area. */
  offset: number;
  length: number;
  /** Lower-case hex SHA-256 of the blob bytes — the content fingerprint. */
  sha256: string;
}

export type HandoffProfileOrigin = 'embedded' | 'builtin-open' | 'user-imported';

export interface HandoffProfileEntry extends HandoffBlobRef {
  /**
   * Content identity of the profile, namespaced by role:
   * "sha256:<hex>" for library profiles, "embedded:<hex>" for the embedded
   * source evidence. Identical bytes may therefore appear in both roles
   * (sharing one blob) without confusing source and target.
   */
  ref: string;
  description: string;
  colorSpace: ColorSpaceKind;
  channels: number;
  /** md5 id from the ICC header ('' when the header id is zeroed). */
  headerProfileId: string;
  /** File name the exporter knew this profile by (evidence, not identity). */
  fileName: string;
  origin: HandoffProfileOrigin;
}

/** How the source profile was determined — mirrors the in-app discipline. */
export type HandoffSource =
  | { kind: 'embedded'; profileRef: string }
  | { kind: 'assumed'; profileRef: string; note: string };

export interface HandoffManifest {
  format: typeof HANDOFF_FORMAT;
  createdAt: string;
  application: { name: 'softproof-bench'; version: string };
  project: {
    name: string;
    imageName: string;
    image: HandoffBlobRef;
    /** Embedded source ICC evidence; null when the image has none. */
    embeddedICC: HandoffBlobRef | null;
    source: HandoffSource;
    targetProfileRef: string;
    intent: RenderingIntent;
    blackPointCompensation: boolean;
    proofIntent: RenderingIntent;
    /**
     * What the exporter detected inside the image bytes. Re-derived from the
     * actual bytes on import; a mismatch means manifest and content disagree
     * and the package is rejected.
     */
    imageProvenance: { converted: boolean; detail?: string };
  };
  profiles: HandoffProfileEntry[];
  disclaimer: string;
}

/** A fully verified package: manifest plus resolved blob bytes. */
export interface ParsedHandoff {
  manifest: HandoffManifest;
  /** SHA-256 of the manifest bytes — the package identity. */
  manifestHash: string;
  imageBytes: Uint8Array;
  embeddedICC: Uint8Array | null;
  /** Profiles in manifest order, bytes already hash-verified. */
  profiles: { entry: HandoffProfileEntry; bytes: Uint8Array }[];
}
