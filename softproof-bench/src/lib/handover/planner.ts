/**
 * Import planning: compare a fully validated package against THIS browser's
 * IndexedDB snapshots and decide exactly what the single atomic write must do.
 *
 * Pure function - no IndexedDB access - so the reuse/isolation/idempotency
 * rules are unit-testable and the write step stays trivial.
 *
 * Rules:
 *  - Profiles are addressed by SHA-256 content fingerprint. A profile with the
 *    same bytes is REUSED (never duplicated), regardless of its local id or
 *    origin (builtin / user / another package).
 *  - Same description but DIFFERENT bytes is a conflict: never merged. The
 *    package profile is stored under a content-derived id (`sha256:<hex>`) with
 *    its package provenance attached, and the collision is reported visibly.
 *  - Project identity is the package content key (stable across machines):
 *      * exact project already present      -> idempotent no-op (or reference
 *                                              repair if profiles went missing);
 *      * different content, same local name -> renamed with an import suffix;
 *      * otherwise                          -> imported fresh.
 */
import { sha256 } from '../color/sha256';
import type { StoredProfile, StoredProject } from '../db/db';
import type { ValidatedPackage, ResolvedIcc } from './validate';

export interface ProfilePlan {
  key: 'source' | 'target';
  fingerprint: string;
  packageDescription: string;
  /** 'reuse' -> point at the existing record; 'add' -> store `record`. */
  action: 'reuse' | 'add';
  existing?: StoredProfile;
  record?: StoredProfile;
  /** Another local profile shares the description but has different bytes. */
  nameCollision: { id: string; description: string; fingerprint?: string }[];
  reusedFromBuiltin: boolean;
}

export type ImportOutcome =
  | 'imported'
  | 'idempotent-skip'
  | 'reference-repaired'
  | 'name-conflict-renamed';

export interface ProjectPlan {
  outcome: ImportOutcome;
  /** Present for imported / name-conflict-renamed / reference-repaired. */
  record?: StoredProject;
  existing?: StoredProject;
  finalName: string;
  /** ids of projects sharing the display name but with different content. */
  nameConflicts: { id: string; name: string }[];
}

export interface ImportPlan {
  profiles: ProfilePlan[];
  project: ProjectPlan;
}

export const profileFingerprintId = (hex: string) => `sha256:${hex}`;

/**
 * Canonical content key of a handover project. It depends only on the actual
 * image/profile bytes and target condition, so re-importing the SAME package on
 * any machine yields the SAME key (stable idempotency), while any content edit
 * yields a different key (unambiguous branch).
 */
export async function projectContentKey(v: ValidatedPackage): Promise<string> {
  const parts = [
    v.manifest.project.savedAt,
    v.image.sha256,
    v.source.kind,
    v.source.icc.evidence.sha256,
    v.target.evidence.sha256,
    v.manifest.condition.intent,
    v.manifest.condition.blackPointCompensation ? '1' : '0',
    v.manifest.condition.proofIntent,
  ];
  return sha256(new TextEncoder().encode(parts.join('')));
}

function findByFingerprint(profiles: StoredProfile[], hex: string): StoredProfile | undefined {
  return profiles.find((p) => p.sha256 === hex);
}

function planProfile(
  key: ProfilePlan['key'],
  resolved: ResolvedIcc,
  localProfiles: StoredProfile[],
  nowIso: string,
  projectName: string,
  exportedAt: string,
  role: 'source-assumed' | 'target',
): ProfilePlan {
  const hex = resolved.evidence.sha256;
  const existing = findByFingerprint(localProfiles, hex);
  // Same display name but different bytes is always surfaced - whether the
  // package profile is reused (same bytes elsewhere) or freshly added - so a
  // collision can never silently shadow a distinct local profile.
  const collisions = localProfiles
    .filter((p) => p.description === resolved.evidence.description && p.sha256 !== hex)
    .map((p) => ({ id: p.id, description: p.description, fingerprint: p.sha256 }));
  if (existing) {
    return {
      key,
      fingerprint: hex,
      packageDescription: resolved.evidence.description,
      action: 'reuse',
      existing,
      nameCollision: collisions,
      reusedFromBuiltin: existing.origin === 'builtin-open',
    };
  }
  const info = resolved.evidence;
  const record: StoredProfile = {
    id: profileFingerprintId(hex),
    bytes: resolved.data,
    description: info.description,
    colorSpace: info.colorSpace,
    channels: info.channels,
    origin: 'user-imported',
    addedAt: nowIso,
    size: info.byteLength,
    sha256: hex,
    packageSource: {
      packageFormat: 'softproof-bench-handover',
      formatVersion: 1,
      projectName,
      exportedAt,
      role: role === 'source-assumed' ? 'source-assumed' : 'target',
    },
  };
  return {
    key,
    fingerprint: hex,
    packageDescription: info.description,
    action: 'add',
    record,
    nameCollision: collisions,
    reusedFromBuiltin: false,
  };
}

function uniqueProjectName(desired: string, projects: StoredProject[]): string {
  const taken = new Set(projects.map((p) => p.name));
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired}（交接导入 ${i}）`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired}（交接导入 ${Date.now()}）`;
}

export async function planImport(
  v: ValidatedPackage,
  localProfiles: StoredProfile[],
  localProjects: StoredProject[],
  nowIso: string,
): Promise<ImportPlan> {
  const exportedAt = v.manifest.createdAt;
  const projectName = v.manifest.project.name;

  const sourcePlan = planProfile(
    'source',
    v.source.icc,
    localProfiles,
    nowIso,
    projectName,
    exportedAt,
    'source-assumed',
  );
  const targetPlan = planProfile('target', v.target, localProfiles, nowIso, projectName, exportedAt, 'target');

  // The embedded-source profile never enters the library; only an assumed
  // source ICC can need adding. Drop the source plan for embedded kind.
  const profiles: ProfilePlan[] = [];
  if (v.source.kind === 'assumed') profiles.push(sourcePlan);
  // Same bytes for assumed source and target -> one profile, two references.
  if (targetPlan.fingerprint !== sourcePlan.fingerprint) profiles.push(targetPlan);

  const resolveId = (p: ProfilePlan) => (p.action === 'reuse' ? p.existing!.id : p.record!.id);
  const sourceId = v.source.kind === 'assumed' ? resolveId(sourcePlan) : null;
  const targetId = resolveId(targetPlan);

  const contentKey = await projectContentKey(v);
  const stableId = `handover:${contentKey.slice(0, 32)}`;
  const existingExact = localProjects.find((p) => p.id === stableId);

  let outcome: ImportOutcome;
  let record: StoredProject | undefined;
  let finalName = projectName;
  const nameConflicts = localProjects
    .filter((p) => p.name === projectName && p.id !== stableId)
    .map((p) => ({ id: p.id, name: p.name }));

  const profilesToAdd = profiles.filter((p) => p.action === 'add');

  if (existingExact) {
    // Same package content already here: project write is skipped entirely.
    // If its referenced profiles are missing, repair ONLY those (still atomic).
    const missing =
      (v.source.kind === 'assumed' && !findByFingerprint(localProfiles, v.source.icc.evidence.sha256)) ||
      !findByFingerprint(localProfiles, v.target.evidence.sha256);
    outcome = missing && profilesToAdd.length > 0 ? 'reference-repaired' : 'idempotent-skip';
  } else {
    if (nameConflicts.length > 0) {
      outcome = 'name-conflict-renamed';
      finalName = uniqueProjectName(projectName, localProjects);
    } else {
      outcome = 'imported';
    }
    record = {
      id: stableId,
      name: finalName,
      updatedAt: nowIso,
      imageBytes: v.image.data,
      imageName: v.image.name,
      embeddedICC: v.source.kind === 'embedded' ? v.source.icc.data : undefined,
      sourceProfileId: sourceId,
      sourceIsEmbedded: v.source.kind === 'embedded',
      sourceAssumptionNote:
        v.source.kind === 'assumed'
          ? v.source.note
          : undefined,
      targetProfileId: targetId,
      intent: v.manifest.condition.intent,
      blackPointCompensation: v.manifest.condition.blackPointCompensation,
      proofIntent: v.manifest.condition.proofIntent,
      provenanceSeen: false,
      recordVersion: 1,
      imageSha256: v.image.sha256,
      sourceSha256: v.source.icc.evidence.sha256,
      targetSha256: v.target.evidence.sha256,
      handover: {
        packageFormat: 'softproof-bench-handover',
        packageFormatVersion: 1,
        importedAt: nowIso,
        exportedAt,
        sourceKind: v.source.kind,
      },
    };
    void profilesToAdd;
  }

  return { profiles, project: { outcome, record, existing: existingExact, finalName, nameConflicts } };
}
