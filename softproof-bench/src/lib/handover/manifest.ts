/**
 * Manifest schema for the verifiable project handover package (.spbpkg).
 *
 * A package carries everything another *offline* browser needs to reproduce the
 * exact source basis and target condition of a soft-proofing project:
 *
 *  - the ORIGINAL image bytes (never a converted export),
 *  - source-configuration evidence: either the ICC embedded in the image or the
 *    operator's documented manual assumption (with the assumed ICC attached),
 *  - every required ICC binary (source when assumed + target), each with a
 *    SHA-256 fingerprint,
 *  - the target condition (press profile, intent, BPC),
 *  - project metadata and an explicit format version.
 *
 * All binaries live in the same container as `entries`, content-addressed by
 * SHA-256; the manifest only references fingerprints, never offsets, so every
 * reference can be checked independently.
 */
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';
import { APP_NAME, HANDOVER_FORMAT, HANDOVER_FORMAT_VERSION } from '../version';

export type EntryRole = 'image' | 'icc-embedded' | 'icc-source-assumed' | 'icc-target';

export interface HandoverEntryMeta {
  role: EntryRole;
  sha256: string;
  byteLength: number;
  /** Original file name, for display only. */
  name: string;
}

export interface HandoverImageMeta {
  name: string;
  width?: number;
  height?: number;
  bitDepth: 8 | 16;
  container: string;
  contentId: string;
  /** Must be false: handover packages carry originals, never conversions. */
  hadProvenanceMarker: boolean;
}

export interface HandoverIccEvidence {
  /** ICC header profile id (md5) when the profile carries one. */
  iccProfileId?: string;
  description: string;
  colorSpace: ColorSpaceKind;
  channels: number;
  byteLength: number;
  sha256: string;
}

export interface HandoverAssumption {
  note: string;
  /** Local library id on the exporting machine; provenance only, never trusted as an id on import. */
  exportedFromProfileId: string;
}

export interface HandoverManifest {
  packageFormat: typeof HANDOVER_FORMAT;
  packageFormatVersion: number;
  app: { name: typeof APP_NAME; version: string };
  createdAt: string;
  project: {
    name: string;
    savedAt: string;
  };
  image: HandoverImageMeta;
  source: {
    /**
     * - embedded: image.content carries an ICC and `embedded` evidence must
     *   byte-match what is actually embedded in the image entry;
     * - assumed:  image has no usable embedded ICC and a human-recorded
     *   assumption + the assumed ICC binary is included.
     */
    kind: 'embedded' | 'assumed';
    embedded?: HandoverIccEvidence;
    assumed?: HandoverIccEvidence & HandoverAssumption;
  };
  target: {
    profile: HandoverIccEvidence;
  };
  condition: {
    intent: RenderingIntent;
    blackPointCompensation: boolean;
    proofIntent: RenderingIntent;
  };
  entries: HandoverEntryMeta[];
}

export { HANDOVER_FORMAT, HANDOVER_FORMAT_VERSION };
