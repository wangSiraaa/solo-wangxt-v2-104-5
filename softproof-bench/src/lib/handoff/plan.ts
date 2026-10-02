/**
 * Handoff import planning. Pure decision logic, separated from persistence so
 * it can be unit-tested in Node: given a verified package and the current
 * IndexedDB content, decide EXACTLY what to write (and what not to touch).
 *
 * Rules implemented here:
 *
 *  - Profile identity is the SHA-256 fingerprint of its bytes. A local profile
 *    with the same fingerprint is REUSED, never duplicated; legacy records
 *    missing a stored fingerprint get it backfilled (reported as a migration).
 *  - Same description but different bytes => a separate, isolated profile
 *    record that keeps the package's provenance. Never merged.
 *  - Project identity is derived from the package manifest hash, so importing
 *    the same package twice is an idempotent no-op. If the previously imported
 *    project was locally modified, the import forks to a new "-rN" id instead
 *    of overwriting — an explicit, reported branch.
 *  - Images carrying the conversion marker keep their protection: the flag is
 *    re-derived from the bytes and stored on the project.
 */
import type { StoredProfile, StoredProject } from '../db/db';
import { STORE_PROFILES, STORE_PROJECTS } from '../db/db';
import { sha256Hex } from '../color/hash';
import { HANDOFF_FORMAT, type ParsedHandoff } from './format';

export interface PlanExisting {
  profiles: StoredProfile[];
  /** Full records: the live content hash is recomputed to detect local edits. */
  projects: StoredProject[];
}

export interface HandoffPlan {
  /** Id of the project after import (new or existing). */
  projectId: string;
  projectName: string;
  /** Project record to write; null on an idempotent no-op. */
  projectWrite: StoredProject | null;
  /** New profile records to add. */
  profileWrites: StoredProfile[];
  /** Legacy profile records re-written only to add their fingerprint. */
  profileBackfills: StoredProfile[];
  reused: { ref: string; localId: string; description: string }[];
  added: { ref: string; localId: string; description: string }[];
  conflicts: string[];
  migrations: string[];
  branch: 'fresh' | 'idempotent' | 'fork';
  branchNote: string;
  provenanceWarning: string | null;
}

/** All writes of the plan as one atomic-commit list. */
export function planToWrites(plan: HandoffPlan): { store: string; value: object }[] {
  const writes: { store: string; value: object }[] = [];
  for (const p of plan.profileBackfills) writes.push({ store: STORE_PROFILES, value: p });
  for (const p of plan.profileWrites) writes.push({ store: STORE_PROFILES, value: p });
  if (plan.projectWrite) writes.push({ store: STORE_PROJECTS, value: plan.projectWrite });
  return writes;
}

/** Canonical content hash of a stored project (excludes id/timestamps/handoff). */
async function projectContentHash(p: {
  name: string;
  imageName: string;
  imageBytes: Uint8Array;
  embeddedICC?: Uint8Array;
  sourceProfileId: string | null;
  sourceIsEmbedded: boolean;
  sourceAssumptionNote?: string;
  targetProfileId: string | null;
  intent: string;
  blackPointCompensation: boolean;
  proofIntent?: string;
  provenanceSeen?: boolean;
}): Promise<string> {
  const canon = {
    name: p.name,
    imageName: p.imageName,
    imageSha256: await sha256Hex(p.imageBytes),
    embeddedSha256: p.embeddedICC ? await sha256Hex(p.embeddedICC) : null,
    sourceProfileId: p.sourceProfileId,
    sourceIsEmbedded: p.sourceIsEmbedded,
    sourceAssumptionNote: p.sourceAssumptionNote ?? null,
    targetProfileId: p.targetProfileId,
    intent: p.intent,
    blackPointCompensation: p.blackPointCompensation,
    proofIntent: p.proofIntent ?? null,
    provenanceSeen: !!p.provenanceSeen,
    schemaVersion: 2,
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify(canon)));
}

export async function planHandoffImport(parsed: ParsedHandoff, existing: PlanExisting): Promise<HandoffPlan> {
  const now = new Date().toISOString();
  const conflicts: string[] = [];
  const migrations: string[] = [];
  const reused: HandoffPlan['reused'] = [];
  const added: HandoffPlan['added'] = [];
  const profileWrites: StoredProfile[] = [];
  const profileBackfills: StoredProfile[] = [];

  // ---- fingerprint the local library (backfilling legacy records) ----
  const localByHash = new Map<string, StoredProfile>();
  const localDescriptions = new Map<string, StoredProfile[]>();
  for (const p of existing.profiles) {
    let fp = p.sha256;
    if (!fp || !/^[0-9a-f]{64}$/.test(fp)) {
      fp = await sha256Hex(p.bytes);
      const backfilled: StoredProfile = { ...p, sha256: fp };
      profileBackfills.push(backfilled);
      migrations.push(`为旧配置“${p.description}”补充内容指纹（sha256:${fp.slice(0, 12)}…）`);
      localByHash.set(fp, backfilled);
    } else {
      localByHash.set(fp, p);
    }
    const list = localDescriptions.get(p.description) ?? [];
    list.push(p);
    localDescriptions.set(p.description, list);
  }

  // ---- resolve each shipped profile: reuse by fingerprint or add isolated ----
  const localIdByRef = new Map<string, string>();
  for (const { entry, bytes } of parsed.profiles) {
    if (entry.origin === 'embedded') continue; // embedded ICC stays inside the project record
    const hit = localByHash.get(entry.sha256);
    if (hit) {
      localIdByRef.set(entry.ref, hit.id);
      reused.push({ ref: entry.ref, localId: hit.id, description: entry.description });
      continue;
    }
    // New to this machine. Deterministic id => re-importing the same package
    // converges on the same record instead of piling up copies.
    const localId = `pkg-icc-${entry.sha256.slice(0, 16)}`;
    const sameName = (localDescriptions.get(entry.description) ?? []).filter((p) => p.sha256 !== entry.sha256);
    if (sameName.length > 0) {
      conflicts.push(
        `配置“${entry.description}”与本机已有配置同名但字节不同，已隔离为新条目（保留包内来源，未合并）`,
      );
    }
    const record: StoredProfile = {
      id: localId,
      bytes,
      description: entry.description,
      colorSpace: entry.colorSpace,
      channels: entry.channels,
      origin: 'handoff-imported',
      addedAt: now,
      size: bytes.byteLength,
      sha256: entry.sha256,
      fileName: entry.fileName,
      handoff: { packageHash: parsed.manifestHash, importedAt: now, bundleFileName: entry.fileName },
    };
    profileWrites.push(record);
    localByHash.set(entry.sha256, record);
    const list = localDescriptions.get(entry.description) ?? [];
    list.push(record);
    localDescriptions.set(entry.description, list);
    localIdByRef.set(entry.ref, localId);
    added.push({ ref: entry.ref, localId, description: entry.description });
  }

  // ---- build the project record ----
  const proj = parsed.manifest.project;
  const sourceIsEmbedded = proj.source.kind === 'embedded';
  const sourceProfileId = sourceIsEmbedded ? null : (localIdByRef.get(proj.source.profileRef) ?? null);
  const targetProfileId = localIdByRef.get(proj.targetProfileRef) ?? null;
  if (!sourceIsEmbedded && !sourceProfileId) throw new Error('内部错误：假设源配置未能解析到本机配置');
  if (!targetProfileId) throw new Error('内部错误：目标配置未能解析到本机配置');

  const base: Omit<StoredProject, 'id' | 'updatedAt' | 'handoff'> = {
    name: proj.name,
    imageName: proj.imageName,
    imageBytes: parsed.imageBytes,
    embeddedICC: parsed.embeddedICC ?? undefined,
    sourceProfileId,
    sourceIsEmbedded,
    sourceAssumptionNote: sourceIsEmbedded
      ? undefined
      : proj.source.kind === 'assumed' && proj.source.note
        ? proj.source.note
        : '原图缺少嵌入配置，操作员手动选择源配置（假设已记录，随交接包传递）',
    targetProfileId,
    intent: proj.intent,
    blackPointCompensation: proj.blackPointCompensation,
    proofIntent: proj.proofIntent,
    provenanceSeen: proj.imageProvenance.converted,
    schemaVersion: 2,
  };
  const contentHash = await projectContentHash(base);

  // ---- project id + idempotency / fork branch ----
  // A candidate id is free to claim when no record exists there. When a
  // record exists, compare the LIVE record's content hash with the package's:
  // identical => idempotent no-op; different => the local record diverged
  // (locally edited or an unrelated collision) => fork to the next "-rN" id
  // instead of overwriting. Re-importing the same package therefore always
  // converges: fresh -> idempotent, edited -> fork -> idempotent at the fork.
  const baseId = `pkg-${parsed.manifestHash.slice(0, 24)}`;
  const byId = new Map(existing.projects.map((p) => [p.id, p]));
  let projectId = '';
  let branch: HandoffPlan['branch'] = 'fresh';
  let projectWrite: StoredProject | null = null;
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? baseId : `${baseId}-r${n}`;
    const prev = byId.get(candidate);
    if (!prev) {
      projectId = candidate;
      branch = n === 1 ? 'fresh' : 'fork';
      projectWrite = {
        ...base,
        id: candidate,
        updatedAt: now,
        handoff: { packageHash: parsed.manifestHash, contentHash, importedAt: now, format: HANDOFF_FORMAT },
      };
      break;
    }
    const liveHash = await projectContentHash(prev);
    if (liveHash === contentHash) {
      projectId = candidate;
      branch = 'idempotent';
      break;
    }
  }
  if (!projectId) throw new Error('无法为交接工程分配 id（分支过多）');

  const branchNote =
    branch === 'fresh'
      ? `新建工程 ${projectId}`
      : branch === 'idempotent'
        ? `工程 ${projectId} 已存在且内容一致：幂等跳过，未重复写入（配置引用仍可验证）`
        : `本机已存在同一交接包的工程但内容被本地修改过，已作为新副本 ${projectId} 导入（两者保留）`;

  const provenanceWarning = proj.imageProvenance.converted
    ? '包内图片带有“已转换”标记：已按原样导入并保留拦截保护，仍不能当作原图再次转换。'
    : null;

  return {
    projectId,
    projectName: proj.name,
    projectWrite,
    profileWrites,
    profileBackfills,
    reused,
    added,
    conflicts,
    migrations,
    branch,
    branchNote,
    provenanceWarning,
  };
}
