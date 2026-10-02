/**
 * Node-side unit tests for the handoff package ("工程交接包") modules:
 *  - build -> parse round-trip (fingerprints, manifest, content association)
 *  - tamper / truncation / wrong-magic rejection
 *  - manifest<->content association attacks (attacker may re-hash the manifest)
 *  - import planning: fingerprint reuse, legacy backfill migration,
 *    same-name/different-bytes isolation, idempotency, fork branch,
 *    provenance protection flag
 *
 * Run: npx tsx scripts/test-handoff.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildHandoffPackage, parseHandoffPackage, HandoffValidationError, type HandoffBuildInput } from '../src/lib/handoff/package';
import { planHandoffImport, planToWrites } from '../src/lib/handoff/plan';
import { HANDOFF_MAGIC, HEADER_BYTES, type HandoffManifest } from '../src/lib/handoff/format';
import { encodePng } from '../src/lib/codec/png';
import { sha256Hex } from '../src/lib/color/hash';
import { readProfileInfo } from '../src/lib/icc/profileInfo';
import type { StoredProfile, StoredProject } from '../src/lib/db/db';

const root = resolve(import.meta.dirname, '..');
const srgbIcc = new Uint8Array(readFileSync(resolve(root, 'public/profiles/sRGB-elle-V2-srgbtrc.icc')));
const cieIcc = new Uint8Array(readFileSync(resolve(root, 'public/profiles/CIERGB-elle-V2-g22.icc')));
const cmykIcc = new Uint8Array(readFileSync(resolve('/workspace/test-assets/profiles/ISOcoated_v2_300_mth.icc')));

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

// ---- fixture images ----
const W = 4, H = 3;
const rgba = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) rgba.set([200, 100, 50, 255], i * 4);
const pngEmbedded = encodePng({ width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgba, hasAlpha: true, icc: srgbIcc });
const pngNoIcc = encodePng({ width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgba, hasAlpha: true });
const pngMarked = encodePng({
  width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgba, hasAlpha: true, icc: cieIcc,
  text: { 'softproof-bench-conversion': 'v=1; source=test; target=x; this-file-is-converted-not-original=1' },
});

const embeddedInput: HandoffBuildInput = {
  projectName: '色块工程',
  imageName: 'patches.png',
  imageBytes: pngEmbedded,
  embeddedICC: srgbIcc,
  source: { kind: 'embedded' },
  targetProfile: { bytes: cmykIcc, description: 'ISO Coated v2 300', fileName: 'ISOcoated_v2_300_mth.icc', origin: 'user-imported' },
  intent: 'relative-colorimetric',
  blackPointCompensation: true,
  proofIntent: 'absolute-colorimetric',
  provenance: { converted: false },
  appVersion: '0.1.0',
};

const assumedInput: HandoffBuildInput = {
  projectName: '无配置工程',
  imageName: 'noicc.png',
  imageBytes: pngNoIcc,
  embeddedICC: null,
  source: {
    kind: 'assumed',
    profile: { bytes: cieIcc, description: 'CIE RGB', fileName: 'CIERGB-elle-V2-g22.icc', origin: 'builtin-open' },
    note: '原图缺少嵌入配置，操作员手动选择源配置（假设已记录）',
  },
  targetProfile: { bytes: cmykIcc, description: 'ISO Coated v2 300', fileName: 'ISOcoated_v2_300_mth.icc', origin: 'user-imported' },
  intent: 'perceptual',
  blackPointCompensation: false,
  proofIntent: 'relative-colorimetric',
  provenance: { converted: false },
  appVersion: '0.1.0',
};

async function expectReject(name: string, bytes: Uint8Array, keyword: string) {
  try {
    await parseHandoffPackage(bytes);
    check(name, false, '应当被拒绝但却通过了');
  } catch (err) {
    const msg = err instanceof HandoffValidationError ? err.issues.join(' | ') : String(err);
    check(name, err instanceof HandoffValidationError && msg.includes(keyword), msg.slice(0, 160));
  }
}

/** Re-assemble a package with a mutated manifest (attacker fixes the header hash). */
async function repackWithManifest(orig: Uint8Array, mutate: (m: HandoffManifest) => void): Promise<Uint8Array> {
  const manifestLen = new DataView(orig.buffer, orig.byteOffset, orig.byteLength).getUint32(8, true);
  const m = JSON.parse(new TextDecoder().decode(orig.subarray(HEADER_BYTES, HEADER_BYTES + manifestLen))) as HandoffManifest;
  mutate(m);
  const nm = new TextEncoder().encode(JSON.stringify(m));
  const hashHex = await sha256Hex(nm);
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hash[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  const rest = orig.subarray(HEADER_BYTES + manifestLen);
  const out = new Uint8Array(HEADER_BYTES + nm.byteLength + rest.byteLength);
  out.set(orig.subarray(0, 8), 0);
  new DataView(out.buffer).setUint32(8, nm.byteLength, true);
  out.set(hash, 12);
  out.set(nm, HEADER_BYTES);
  out.set(rest, HEADER_BYTES + nm.byteLength);
  return out;
}

/** Minimal in-memory "IndexedDB" for planning tests. */
interface MockDb {
  profiles: StoredProfile[];
  projects: StoredProject[];
}
function mockApply(db: MockDb, plan: Awaited<ReturnType<typeof planHandoffImport>>) {
  for (const w of planToWrites(plan)) {
    const store = w.store === 'profiles' ? db.profiles : db.projects;
    const rec = w.value as StoredProfile & StoredProject;
    const i = store.findIndex((x) => x.id === rec.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (i >= 0) store[i] = rec as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else store.push(rec as any);
  }
}

async function main() {
  console.log('# handoff build -> parse round-trip (embedded source)');
  const pkg = await buildHandoffPackage(embeddedInput);
  check('magic header', new TextDecoder().decode(pkg.subarray(0, 8)) === HANDOFF_MAGIC);
  const parsed = await parseHandoffPackage(pkg);
  check('manifest hash is sha-256 hex', /^[0-9a-f]{64}$/.test(parsed.manifestHash));
  check('image bytes round-trip', Buffer.from(parsed.imageBytes).equals(Buffer.from(pngEmbedded)));
  check('embedded ICC round-trips byte-for-byte', !!parsed.embeddedICC && Buffer.from(parsed.embeddedICC).equals(Buffer.from(srgbIcc)));
  check('two profiles shipped (embedded + target)', parsed.profiles.length === 2, String(parsed.profiles.length));
  const target = parsed.profiles.find((p) => p.entry.origin === 'user-imported');
  check('target profile bytes round-trip', !!target && Buffer.from(target.bytes).equals(Buffer.from(cmykIcc)));
  check('target conditions in manifest',
    parsed.manifest.project.intent === 'relative-colorimetric' &&
    parsed.manifest.project.blackPointCompensation === true &&
    parsed.manifest.project.proofIntent === 'absolute-colorimetric');
  check('format version recorded', parsed.manifest.format === 'softproof-bench-handoff/1');
  check('project metadata recorded', parsed.manifest.project.name === '色块工程' && parsed.manifest.project.imageName === 'patches.png');

  console.log('# handoff round-trip (assumed source, no embedded ICC)');
  {
    const p2 = await parseHandoffPackage(await buildHandoffPackage(assumedInput));
    check('no embedded ICC', p2.embeddedICC === null);
    check('assumed source recorded with note',
      p2.manifest.project.source.kind === 'assumed' && p2.manifest.project.source.note.includes('假设'));
    check('assumed profile shipped', p2.profiles.some((p) => p.entry.origin === 'builtin-open'));
  }

  console.log('# target profile byte-identical to embedded ICC (shared blob, distinct roles)');
  {
    const pngCie = encodePng({ width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgba, hasAlpha: true, icc: cieIcc });
    const sameBytes = await parseHandoffPackage(await buildHandoffPackage({
      ...embeddedInput,
      imageBytes: pngCie,
      embeddedICC: cieIcc,
      targetProfile: { bytes: cieIcc, description: 'CIE RGB', fileName: 'CIERGB-elle-V2-g22.icc', origin: 'builtin-open' },
    }));
    check('two role entries for identical bytes', sameBytes.profiles.length === 2, String(sameBytes.profiles.length));
    const refs = sameBytes.profiles.map((p) => p.entry.ref);
    check('refs distinct by role', new Set(refs).size === 2, refs.join(' | '));
    check('single shared blob', sameBytes.profiles[0].entry.offset === sameBytes.profiles[1].entry.offset);
    check('source/target refs resolve to their own entries',
      sameBytes.manifest.project.source.kind === 'embedded' &&
      sameBytes.manifest.project.source.profileRef !== sameBytes.manifest.project.targetProfileRef);
    const planSame = await planHandoffImport(sameBytes, { profiles: [], projects: [] });
    check('plan resolves target to a library profile', !!planSame.projectWrite?.targetProfileId);
    check('plan keeps embedded source in project', planSame.projectWrite?.sourceIsEmbedded === true);
  }

  console.log('# tamper & truncation rejection');
  {
    const tampered = pkg.slice();
    tampered[tampered.length - 1] ^= 0xff; // flip a bit inside the last blob
    await expectReject('blob tamper detected', tampered, '指纹不匹配');

    const tamperedManifest = pkg.slice();
    tamperedManifest[HEADER_BYTES + 4] ^= 0x20; // flip inside manifest JSON
    await expectReject('manifest tamper detected', tamperedManifest, '清单指纹不匹配');

    const badMagic = pkg.slice();
    badMagic[0] ^= 0xff;
    await expectReject('wrong magic rejected', badMagic, '文件头标识不符');

    await expectReject('truncated blob area rejected', pkg.subarray(0, pkg.length - 10), '截断');
    const manifestLen = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength).getUint32(8, true);
    await expectReject('truncated manifest rejected', pkg.subarray(0, HEADER_BYTES + manifestLen - 2), '截断');
    await expectReject('tiny file rejected', pkg.subarray(0, 20), '太小');
  }

  console.log('# manifest<->content association (attacker re-hashes manifest)');
  {
    const markedInput: HandoffBuildInput = {
      ...embeddedInput,
      imageBytes: pngMarked,
      embeddedICC: cieIcc,
      source: { kind: 'embedded' },
      provenance: { converted: true, detail: 'v=1; test' },
    };
    const markedPkg = await buildHandoffPackage(markedInput);
    const okMarked = await parseHandoffPackage(markedPkg);
    check('marked image package parses with converted=true', okMarked.manifest.project.imageProvenance.converted === true);

    // lie about the conversion marker while keeping hashes consistent
    const lied = await repackWithManifest(markedPkg, (m) => {
      m.project.imageProvenance = { converted: false };
    });
    await expectReject('provenance lie detected', lied, '转换标记状态');

    // claim the no-ICC image has an embedded profile: point embeddedICC at the target blob
    const pkgNoIcc = await buildHandoffPackage(assumedInput);
    const liedEmbedded = await repackWithManifest(pkgNoIcc, (m) => {
      m.project.embeddedICC = m.profiles[0];
    });
    await expectReject('fake embedded-ICC claim detected', liedEmbedded, '嵌入');

    // swap source kind embedded -> assumed against the embedded entry
    const liedSource = await repackWithManifest(pkg, (m) => {
      m.project.source = { kind: 'assumed', profileRef: m.project.source.profileRef, note: 'x' };
    });
    await expectReject('source-role lie detected', liedSource, '标记为嵌入');

    // point target at the embedded entry (also leaves the real target unreferenced)
    const liedTarget = await repackWithManifest(pkg, (m) => {
      m.project.targetProfileRef = m.project.source.kind === 'embedded' ? m.project.source.profileRef : '';
    });
    await expectReject('embedded entry as target detected', liedTarget, '引用');

    // corrupt a profile fingerprint inside the manifest, keeping refs consistent
    // so the failure must come from blob-level fingerprint verification
    const liedHash = await repackWithManifest(pkg, (m) => {
      const e = m.profiles[0];
      e.sha256 = `00${e.sha256.slice(2)}`;
      e.ref = `${e.origin === 'embedded' ? 'embedded' : 'sha256'}:${e.sha256}`;
      if (m.project.source.kind === 'embedded') m.project.source.profileRef = e.ref;
    });
    await expectReject('profile hash mismatch detected', liedHash, '指纹不匹配');
  }

  console.log('# plan: fingerprint reuse + legacy backfill migration');
  const parsedEmbedded = await parseHandoffPackage(pkg);
  {
    const legacy: StoredProfile = {
      id: 'icc-legacy-1',
      bytes: cmykIcc,
      description: 'ISO Coated v2 300',
      colorSpace: 'CMYK',
      channels: 4,
      origin: 'user-imported',
      addedAt: '2024-01-01T00:00:00.000Z',
      size: cmykIcc.byteLength,
      // no sha256: legacy record from before fingerprints existed
    };
    const plan = await planHandoffImport(parsedEmbedded, { profiles: [legacy], projects: [] });
    check('same-fingerprint profile reused, not duplicated', plan.profileWrites.length === 0 && plan.reused.length === 1);
    check('reused local id', plan.reused[0]?.localId === 'icc-legacy-1');
    check('legacy fingerprint backfill planned as migration', plan.profileBackfills.length === 1 && plan.migrations.length === 1);
    check('project references reused profile', plan.projectWrite?.targetProfileId === 'icc-legacy-1');
    check('fresh branch', plan.branch === 'fresh' && plan.projectId.startsWith('pkg-'));
  }

  console.log('# plan: same-name different-bytes isolation');
  {
    const cmykDesc = readProfileInfo(cmykIcc).description;
    const impostor: StoredProfile = {
      id: 'icc-impostor',
      bytes: srgbIcc, // different bytes...
      description: cmykDesc, // ...same description as the shipped target
      colorSpace: 'RGB',
      channels: 3,
      origin: 'user-imported',
      addedAt: '2024-01-01T00:00:00.000Z',
      size: srgbIcc.byteLength,
      sha256: await sha256Hex(srgbIcc),
    };
    const plan = await planHandoffImport(parsedEmbedded, { profiles: [impostor], projects: [] });
    check('not merged: new isolated profile written', plan.profileWrites.length === 1);
    check('conflict reported', plan.conflicts.length === 1 && plan.conflicts[0].includes('同名但字节不同'));
    const newId = plan.profileWrites[0].id;
    check('new id distinct from impostor', newId !== 'icc-impostor');
    check('project points at the isolated record', plan.projectWrite?.targetProfileId === newId);
    check('package provenance kept on record',
      plan.profileWrites[0].origin === 'handoff-imported' &&
      plan.profileWrites[0].handoff?.bundleFileName === 'ISOcoated_v2_300_mth.icc' &&
      plan.profileWrites[0].sha256 === (await sha256Hex(cmykIcc)));
  }

  console.log('# plan: idempotency and fork branch');
  {
    const db: MockDb = { profiles: [], projects: [] };
    const plan1 = await planHandoffImport(parsedEmbedded, db);
    check('first import is fresh with writes', plan1.branch === 'fresh' && planToWrites(plan1).length > 0);
    mockApply(db, plan1);
    const projCount = db.projects.length;
    const profCount = db.profiles.length;

    const plan2 = await planHandoffImport(parsedEmbedded, db);
    check('second import of same package is idempotent', plan2.branch === 'idempotent', plan2.branch);
    check('idempotent: no project write', plan2.projectWrite === null);
    check('idempotent: same project id', plan2.projectId === plan1.projectId);
    check('idempotent: no new profiles/backfills', plan2.profileWrites.length === 0 && plan2.profileBackfills.length === 0);
    mockApply(db, plan2);
    check('store sizes unchanged after re-import', db.projects.length === projCount && db.profiles.length === profCount);

    // local modification of the imported project -> explicit fork branch
    db.projects[0] = { ...db.projects[0], name: '本地改过的名字' };
    const plan3 = await planHandoffImport(parsedEmbedded, db);
    check('modified local copy triggers fork', plan3.branch === 'fork', plan3.branch);
    check('fork gets -r2 id', plan3.projectId.endsWith('-r2'), plan3.projectId);
    check('fork writes a project', plan3.projectWrite !== null);
    mockApply(db, plan3);
    const plan4 = await planHandoffImport(parsedEmbedded, db);
    check('fork converges idempotently', plan4.branch === 'idempotent' && plan4.projectId === plan3.projectId);
  }

  console.log('# plan: assumed source + provenance protection');
  {
    const parsedAssumed = await parseHandoffPackage(await buildHandoffPackage(assumedInput));
    const plan = await planHandoffImport(parsedAssumed, { profiles: [], projects: [] });
    check('assumed source resolves to shipped profile id', !!plan.projectWrite?.sourceProfileId);
    check('assumption note carried', (plan.projectWrite?.sourceAssumptionNote ?? '').includes('假设'));
    check('sourceIsEmbedded false', plan.projectWrite?.sourceIsEmbedded === false);

    const markedPkg = await buildHandoffPackage({
      ...embeddedInput,
      imageBytes: pngMarked,
      embeddedICC: cieIcc,
      provenance: { converted: true },
    });
    const planM = await planHandoffImport(await parseHandoffPackage(markedPkg), { profiles: [], projects: [] });
    check('converted-marker warning surfaced', !!planM.provenanceWarning && planM.provenanceWarning.includes('已转换'));
    check('provenanceSeen stored on project', planM.projectWrite?.provenanceSeen === true);
  }

  console.log(failures ? `\n${failures} FAILURES` : '\nALL HANDOFF NODE TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
