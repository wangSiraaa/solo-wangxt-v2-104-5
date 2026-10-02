/**
 * Handover import orchestration:
 *
 *   file bytes
 *     -> parsePackage   (container + outer/inner hashes)
 *     -> validatePackage(manifest coherence, original-only, evidence linkage)
 *     -> planImport     (fingerprint reuse vs same-name isolation; project
 *                        idempotency / rename branches)   [pure]
 *     -> ONE readwrite transaction across (profiles, projects)
 *
 * The transaction is the ONLY place data is written, so a rejection at any
 * earlier stage leaves both stores byte-for-byte unchanged - no half project
 * and no orphan ICC can persist.
 */
import { idbAll, idbAtomic, STORE_PROFILES, STORE_PROJECTS, type StoredProfile, type StoredProject } from '../db/db';
import { parsePackage } from './format';
import { validatePackage, type ValidatedPackage } from './validate';
import { planImport, type ImportPlan } from './planner';
import { sha256 } from '../color/sha256';

export interface ProfileImportResult {
  key: 'source' | 'target';
  description: string;
  fingerprint: string;
  action: 'reused' | 'added';
  reusedFromBuiltin: boolean;
  nameCollision: { id: string; description: string; fingerprint?: string }[];
  storedId: string;
}

export interface ProjectImportResult {
  outcome: ImportPlan['project']['outcome'];
  projectId?: string;
  name: string;
  nameConflicts: { id: string; name: string }[];
}

export interface HandoverImportReport {
  ok: boolean;
  error?: string;
  rejectedStage?: 'parse' | 'validate' | 'commit';
  packageName: string;
  formatVersion: number | null;
  exportedAt?: string;
  project: ProjectImportResult;
  profiles: ProfileImportResult[];
  /** True when the identical project already existed and nothing was written. */
  idempotent: boolean;
}

export async function importHandoverPackage(fileBytes: Uint8Array, packageName: string): Promise<HandoverImportReport> {
  const base: HandoverImportReport = {
    ok: false,
    packageName,
    formatVersion: null,
    project: { outcome: 'imported', name: '', nameConflicts: [] },
    profiles: [],
    idempotent: false,
  };

  // Stages 1-2: structural + semantic verification. No writes possible here.
  let parsed: Awaited<ReturnType<typeof parsePackage>>;
  let validated: ValidatedPackage;
  try {
    parsed = await parsePackage(fileBytes);
    base.formatVersion = parsed.manifest.packageFormatVersion;
    base.exportedAt = parsed.manifest.createdAt;
  } catch (err) {
    return { ...base, rejectedStage: 'parse', error: human(err) };
  }
  try {
    validated = await validatePackage(parsed);
  } catch (err) {
    return { ...base, rejectedStage: 'validate', error: human(err) };
  }

  const nowIso = new Date().toISOString();
  const localProfiles = await idbAll<StoredProfile>(STORE_PROFILES);
  const localProjects = await idbAll<StoredProject>(STORE_PROJECTS);
  const plan = await planImport(validated, localProfiles, localProjects, nowIso);

  // Stage 3: single atomic commit.
  try {
    const toAdd = plan.profiles.filter((p) => p.action === 'add');
    // Defence in depth: recompute every binary fingerprint BEFORE opening the
    // transaction so the synchronous commit path only stores pre-verified rows.
    await Promise.all(
      toAdd.map(async (p) => {
        const rec = p.record!;
        const got = await sha256(rec.bytes);
        if (got !== p.fingerprint || rec.id !== `sha256:${got}`) {
          throw new Error(`提交前复核失败：${p.packageDescription} 指纹不一致`);
        }
      }),
    );
    if (plan.project.record) {
      const imgGot = await sha256(plan.project.record.imageBytes);
      if (imgGot !== validated.image.sha256) throw new Error('提交前复核失败：原图指纹不一致');
    }
    if (toAdd.length > 0 || plan.project.record) {
      await idbAtomic([STORE_PROFILES, STORE_PROJECTS], ([profileStore, projectStore]) => {
        for (const p of toAdd) {
          profileStore.put(p.record!);
        }
        if (plan.project.record) projectStore.put(plan.project.record);
      });
    }

    const profileResults: ProfileImportResult[] = plan.profiles.map((p) => ({
      key: p.key,
      description: p.packageDescription,
      fingerprint: p.fingerprint,
      action: p.action === 'reuse' ? 'reused' : 'added',
      reusedFromBuiltin: p.reusedFromBuiltin,
      nameCollision: p.nameCollision.map((c) => ({ ...c })),
      storedId: p.action === 'reuse' ? p.existing!.id : p.record!.id,
    }));

    const proj = plan.project;
    return {
      ...base,
      ok: true,
      profiles: profileResults,
      project: {
        outcome: proj.outcome,
        projectId: proj.record?.id ?? proj.existing?.id,
        name: proj.finalName,
        nameConflicts: proj.nameConflicts,
      },
      idempotent: proj.outcome === 'idempotent-skip',
    };
  } catch (err) {
    // Transaction abort => IndexedDB guarantees neither store changed.
    return { ...base, rejectedStage: 'commit', error: `落库失败（已整体回滚，无任何残留）：${human(err)}` };
  }
}

function human(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Verify the image/ICC fingerprints attached to a stored project (load-time check). */
export async function verifyStoredProject(p: StoredProject, profiles: StoredProfile[]) {
  const issues: string[] = [];
  if (p.recordVersion === undefined) {
    return { legacy: true as const, issues: ['旧格式工程（无指纹），按原记录直接载入'] };
  }
  if (p.imageSha256) {
    const got = await sha256(p.imageBytes);
    if (got !== p.imageSha256) issues.push('原图指纹与保存时不一致（字节可能已损坏/被替换）');
  }
  const checkProfile = (id: string | null, want: string | null | undefined, label: string) => {
    if (!want) return;
    if (!id) {
      issues.push(`${label}配置引用缺失`);
      return;
    }
    const rec = profiles.find((x) => x.id === id);
    if (!rec) {
      issues.push(`${label}配置不在本机库中（id=${id}），无法复现该条件`);
      return;
    }
    if (rec.sha256 && rec.sha256 !== want) {
      issues.push(`${label}配置指纹与工程记录不一致`);
    }
  };
  if (p.sourceIsEmbedded && p.embeddedICC && p.sourceSha256) {
    const got = await sha256(p.embeddedICC);
    if (got !== p.sourceSha256) issues.push('嵌入源配置指纹与保存时不一致');
  } else if (!p.sourceIsEmbedded) {
    checkProfile(p.sourceProfileId, p.sourceSha256, '源');
  }
  checkProfile(p.targetProfileId, p.targetSha256, '目标');
  return { legacy: false as const, issues };
}
