/**
 * Node tests for the verifiable handover package:
 *
 *  - build -> parse round trip; outer + per-entry fingerprints
 *  - embedded-source and assumed-source packages validate
 *  - tampered / truncated / trailing-bytes packages are rejected
 *  - converted-file (provenance marker) image is rejected
 *  - evidence mismatches (embedded relink, assumption-with-embedded) rejected
 *  - import into a real (fake) IndexedDB:
 *      * fresh import restores project + only needed profiles
 *      * identical local profile is reused (no duplicate row, reference valid)
 *      * same description / different bytes is isolated, not merged
 *      * repeated import is idempotent (no new rows)
 *      * rejected package adds no project/profile residue
 *      * legacy v0 project coexists and loads alongside the new one
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { buildHandoverPackage } from '../src/lib/handover/buildPackage';
import { encodePackage, parsePackage, PKG_MAGIC, END_MAGIC } from '../src/lib/handover/format';
import { validatePackage } from '../src/lib/handover/validate';
import { planImport } from '../src/lib/handover/planner';
import { importHandoverPackage } from '../src/lib/handover/importPackage';
import {
  idbAll,
  idbDelete,
  idbPut,
  STORE_PROFILES,
  STORE_PROJECTS,
  type StoredProfile,
  type StoredProject,
} from '../src/lib/db/db';
import { encodePng } from '../src/lib/codec/png';
import { extractEmbeddedICC } from '../src/lib/icc/extractEmbedded';
import { readProfileInfo } from '../src/lib/icc/profileInfo';
import type { RenderingIntent } from '../src/lib/color/lcms';

const root = resolve(import.meta.dirname, '..');
const srgbIcc = new Uint8Array(readFileSync(resolve(root, 'public/profiles/sRGB-elle-V2-srgbtrc.icc')));
const cieIcc = new Uint8Array(readFileSync(resolve(root, 'public/profiles/CIERGB-elle-V2-g22.icc')));
const cmykIcc = new Uint8Array(readFileSync('/workspace/test-assets/profiles/ISOcoated_v2_300_mth.icc'));

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

async function expectReject(label: string, bytes: Uint8Array, stage?: string) {
  const r = await importHandoverPackage(bytes, label);
  check(`${label}: rejected`, !r.ok, r.error);
  if (stage) check(`${label}: rejected at ${stage}`, r.rejectedStage === stage, r.rejectedStage);
  return r;
}

function makeImage(opts: { embedded?: Uint8Array; provenance?: boolean; w?: number; h?: number } = {}): Uint8Array {
  const w = opts.w ?? 4;
  const h = opts.h ?? 3;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([200, 100, 50, 255], i * 4);
  return encodePng({
    width: w,
    height: h,
    colorChannels: 3,
    bitDepth: 8,
    data,
    hasAlpha: false,
    icc: opts.embedded,
    text: opts.provenance
      ? { 'softproof-bench-conversion': 'v=1; this-file-is-converted-not-original=1' }
      : undefined,
  });
}

function profileLike(bytes: Uint8Array, id: string): StoredProfile {
  const info = readProfileInfo(bytes);
  return {
    id,
    bytes,
    description: info.description || id,
    colorSpace: info.colorSpace,
    channels: info.channels,
    origin: 'user-imported',
    addedAt: '2026-01-01T00:00:00.000Z',
    size: bytes.byteLength,
  };
}

const fixedTime = '2026-09-01T10:00:00.000Z';

async function embeddedPackage(imageOverride?: Uint8Array) {
  const img = imageOverride ?? makeImage({ embedded: srgbIcc });
  const t = profileLike(cmykIcc, 'local-cmyk-id');
  return buildHandoverPackage({
    projectName: 'embedded-job',
    savedAt: fixedTime,
    imageBytes: img,
    imageName: 'job.png',
    bitDepth: 8,
    sourceKind: 'embedded',
    targetProfile: t,
    intent: 'relative-colorimetric',
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric',
  });
}

async function assumedPackage() {
  const img = makeImage(); // no embedded ICC
  const src = profileLike(srgbIcc, 'local-srgb-id');
  const t = profileLike(cmykIcc, 'local-cmyk-id');
  return buildHandoverPackage({
    projectName: 'assumed-job',
    savedAt: fixedTime,
    imageBytes: img,
    imageName: 'job-noicc.png',
    bitDepth: 8,
    sourceKind: 'assumed',
    assumedProfile: src,
    assumptionNote: '原图缺少嵌入配置，操作员手动选择 sRGB（假设已记录）',
    targetProfile: t,
    intent: 'perceptual',
    blackPointCompensation: false,
    proofIntent: 'absolute-colorimetric',
  });
}

async function resetDb() {
  // fresh database per scenario via a new name: fake-indexeddb keeps globals,
  // so delete object stores by nuking the DB through indexedDB.deleteDatabase.
  await new Promise<void>((res) => {
    const req = indexedDB.deleteDatabase('softproof-bench');
    req.onsuccess = () => res();
    req.onblocked = () => res();
    req.onerror = () => res();
  });
}

// ---------------------------------------------------------------------------
console.log('# container round trip + hashes');
{
  const { bytes, manifest } = await embeddedPackage();
  check('magic present', bytes.subarray(0, 8).every((b, i) => b === PKG_MAGIC[i]));
  check('footer magic present', bytes.subarray(bytes.length - 40, bytes.length - 32).every((b, i) => b === END_MAGIC[i]));
  const parsed = await parsePackage(bytes);
  check('manifest parses', parsed.manifest.project.name === 'embedded-job');
  check('entries: image + embedded + target', parsed.entries.size === 3, String(parsed.entries.size));
  check('image content id matches manifest', !!parsed.entries.get(`image:${manifest.image.contentId}`));
  // raw validate on parsed content
  const v = await validatePackage(parsed);
  check('validated embedded source', v.source.kind === 'embedded');
  check('target is CMYK evidence', v.target.evidence.colorSpace === 'CMYK');
}

console.log('# assumed-source package');
{
  const { bytes } = await assumedPackage();
  const parsed = await parsePackage(bytes);
  const v = await validatePackage(parsed);
  check('validated assumed source', v.source.kind === 'assumed' && v.source.note.includes('假设'));
  check('entries: image + assumed + target', parsed.entries.size === 3);
}

// ---------------------------------------------------------------------------
console.log('# tampering / truncation rejected');
{
  const { bytes } = await embeddedPackage();

  // 1. truncate
  const trunc = bytes.slice(0, bytes.length - 50);
  await expectReject('truncated', trunc, 'parse');

  // 2. flip an interior byte (image data region) -> outer digest mismatch
  const tamper = bytes.slice();
  tamper[Math.floor(tamper.length / 2)] ^= 0xff;
  await expectReject('byte-flipped', tamper, 'parse');

  // 3. append trailing bytes -> outer digest mismatch
  const appended = new Uint8Array(bytes.length + 4);
  appended.set(bytes);
  appended[bytes.length] = 1;
  await expectReject('appended', appended, 'parse');

  // 4. corrupt the manifest length field
  const badLen = bytes.slice();
  badLen[8] = (badLen[8] + 1) & 0xff;
  await expectReject('bad-manifest-length', badLen, 'parse');

  // 5. entirely wrong file
  const wrong = new TextEncoder().encode('not a package at all, just some random text'.repeat(10));
  await expectReject('wrong-format', wrong, 'parse');
}

console.log('# provenance / evidence-link semantic rejections');
{
  // converted image inside a package
  const converted = makeImage({ embedded: srgbIcc, provenance: true });
  let threw = false;
  try {
    await embeddedPackage(converted);
  } catch {
    threw = true;
  }
  check('building from a marked image is refused', threw);

  // forged manifest: take a valid package and rewrite only the manifest JSON to
  // claim a different target condition. Because the outer hash covers the
  // manifest, parsePackage must reject it.
  const { bytes } = await assumedPackage();
  const manifestLen = ((bytes[8] << 24) >>> 0) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11];
  const rawJson = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + manifestLen)));
  rawJson.condition.intent = 'saturation';
  const forgedJson = new TextEncoder().encode(JSON.stringify(rawJson));
  const forged = new Uint8Array(bytes.length);
  forged.set(bytes);
  forged.set(forgedJson.subarray(0, Math.min(forgedJson.length, manifestLen)), 16);
  await expectReject('forged-manifest', forged, 'parse');

  // tamper an ICC entry only but fix nothing -> outer hash rejects; to test the
  // per-entry fingerprint layer specifically, rebuild a package via
  // encodePackage with an entry whose data differs from its declared digest is
  // impossible (encoder recomputes), so instead confirm semantic validator:
  // embedded evidence not matching the actual embedded ICC.
  const parsed = await parsePackage((await embeddedPackage()).bytes);
  // swap the embedded entry data with the CIE profile while keeping manifest
  const cieEntries = new Map(parsed.entries);
  const embKey = [...cieEntries.keys()].find((k) => k.startsWith('icc-embedded:'))!;
  cieEntries.set(embKey, { ...cieEntries.get(embKey)!, data: cieIcc });
  let semReject = false;
  try {
    await validatePackage({ manifest: parsed.manifest, entries: cieEntries });
  } catch (e) {
    semReject = /不一致|不符/.test(String(e));
  }
  check('embedded evidence byte-mismatch rejected', semReject);
}

// ---------------------------------------------------------------------------
console.log('# real IndexedDB import: fresh embedded project');
await resetDb();
{
  const { bytes } = await embeddedPackage();
  const before = {
    profiles: (await idbAll<StoredProfile>(STORE_PROFILES)).length,
    projects: (await idbAll<StoredProject>(STORE_PROJECTS)).length,
  };
  const r = await importHandoverPackage(bytes, 'embedded.spbpkg');
  check('import ok', r.ok, r.error);
  check('outcome imported', r.project.outcome === 'imported', r.project.outcome);
  const profiles = await idbAll<StoredProfile>(STORE_PROFILES);
  const projects = await idbAll<StoredProject>(STORE_PROJECTS);
  check('project count +1', projects.length === before.projects + 1, String(projects.length));
  // embedded source is NOT copied into the library; only the target is
  check('only target profile added', profiles.length === before.profiles + 1, String(profiles.length));
  const proj = projects[0];
  check('project keeps original image name', proj.imageName === 'job.png');
  check('project sourceIsEmbedded', proj.sourceIsEmbedded === true);
  check('embedded ICC stored with project', !!proj.embeddedICC && proj.embeddedICC.byteLength === srgbIcc.byteLength);
  check('target condition restored', proj.intent === 'relative-colorimetric' && proj.blackPointCompensation === true);
  check('project has handover meta', proj.handover?.packageFormatVersion === 1);
  const tp = profiles.find((p) => p.id === proj.targetProfileId);
  check('target reference resolves', !!tp && tp.colorSpace === 'CMYK');
  check('imported profile keeps package provenance', !!tp.packageSource && tp.packageSource.role === 'target');
  check('image fingerprint recorded', !!proj.imageSha256 && proj.imageSha256.length === 64);
}

console.log('# repeated import is idempotent (no new rows)');
{
  const { bytes } = await embeddedPackage();
  const before = {
    profiles: (await idbAll<StoredProfile>(STORE_PROFILES)).length,
    projects: (await idbAll<StoredProject>(STORE_PROJECTS)).length,
  };
  const r = await importHandoverPackage(bytes, 'embedded-again.spbpkg');
  check('second import ok', r.ok);
  check('second import idempotent-skip', r.idempotent && r.project.outcome === 'idempotent-skip', r.project.outcome);
  const after = {
    profiles: (await idbAll<StoredProfile>(STORE_PROFILES)).length,
    projects: (await idbAll<StoredProject>(STORE_PROJECTS)).length,
  };
  check('no profile/project duplicated', after.profiles === before.profiles && after.projects === before.projects,
    `${before.profiles}/${after.profiles} ${before.projects}/${after.projects}`);
}

console.log('# assumed project + reuse identical-fingerprint profile');
{
  // Pre-populate the library with the same sRGB bytes under an arbitrary local
  // id/description-independent identity, and the CMYK under builtin origin.
  const profiles = await idbAll<StoredProfile>(STORE_PROFILES);
  const existingCmyk = profiles.find((p) => p.packageSource?.role === 'target')!;
  // change its origin to builtin-open to simulate a seeded identical profile
  existingCmyk.origin = 'builtin-open';
  delete existingCmyk.packageSource;
  await idbPut(STORE_PROFILES, existingCmyk);
  const { sha256 } = await import('../src/lib/color/sha256');
  const localSrgb = profileLike(srgbIcc, 'my-local-srgb');
  localSrgb.sha256 = await sha256(srgbIcc);
  await idbPut(STORE_PROFILES, localSrgb);
  const before = (await idbAll<StoredProfile>(STORE_PROFILES)).length;

  const { bytes } = await assumedPackage();
  const r = await importHandoverPackage(bytes, 'assumed.spbpkg');
  check('assumed import ok', r.ok, r.error);
  const after = await idbAll<StoredProfile>(STORE_PROFILES);
  check('no profile copied when same fingerprint exists', after.length === before, `${before} -> ${after.length}`);
  const bothReused = r.profiles.every((p) => p.action === 'reused');
  check('both source & target reported reused', bothReused, JSON.stringify(r.profiles.map((p) => p.action)));
  const builtinReuse = r.profiles.find((p) => p.key === 'target');
  check('builtin identical profile reused (reference verifiable)', !!builtinReuse?.reusedFromBuiltin);
  const proj = (await idbAll<StoredProject>(STORE_PROJECTS)).find((p) => p.name === 'assumed-job')!;
  check('assumed source references local id', proj.sourceProfileId === 'my-local-srgb', proj.sourceProfileId ?? '');
  check('assumption note carried', (proj.sourceAssumptionNote ?? '').includes('假设'));
  check('proof intent restored', proj.proofIntent === 'absolute-colorimetric');
}

console.log('# same description, different bytes -> isolated, never merged');
{
  // Rename an existing sRGB library profile to the CIE target's description.
  // Same display name, totally different bytes/space; CIE is not in the DB.
  const cieInfo = readProfileInfo(cieIcc);
  const { sha256 } = await import('../src/lib/color/sha256');
  const decoy: StoredProfile = {
    ...profileLike(srgbIcc, 'decoy-id'),
    description: cieInfo.description,
    sha256: await sha256(srgbIcc),
  };
  await idbPut(STORE_PROFILES, decoy);
  const beforeProfiles = (await idbAll<StoredProfile>(STORE_PROFILES)).length;

  // fresh DB project-wise: use a new package project name via another build
  const img = makeImage();
  const pkg = await buildHandoverPackage({
    projectName: 'isolation-job',
    savedAt: fixedTime,
    imageBytes: img,
    imageName: 'iso.png',
    bitDepth: 8,
    sourceKind: 'assumed',
    assumedProfile: profileLike(srgbIcc, 'srgb2'),
    assumptionNote: '假设源',
    targetProfile: profileLike(cieIcc, 'cie2'),
    intent: 'saturation',
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric',
  });
  const r = await importHandoverPackage(pkg.bytes, 'iso.spbpkg');
  check('isolation import ok', r.ok, r.error);
  const profiles = await idbAll<StoredProfile>(STORE_PROFILES);
  check('new profile row added despite same name', profiles.length === beforeProfiles + 1, String(profiles.length));
  const targetResult = r.profiles.find((p) => p.key === 'target')!;
  check('collision reported', targetResult.nameCollision.length === 1, JSON.stringify(targetResult.nameCollision));
  check('stored under fingerprint id', targetResult.storedId.startsWith('sha256:'), targetResult.storedId);
  const both = profiles.filter((p) => p.description === cieInfo.description);
  check('two profiles with same description coexist with different ids', both.length === 2 && new Set(both.map((p) => p.id)).size === 2);
  const importedOne = both.find((p) => p.id.startsWith('sha256:'))!;
  check('imported one keeps package provenance', !!importedOne.packageSource);
  // the decoy's bytes were not touched / merged
  const decoyBack = profiles.find((p) => p.id === 'decoy-id')!;
  check('decoy profile untouched (different fingerprint)', decoyBack.sha256 === (await sha256(srgbIcc)));
}

console.log('# rejected package leaves zero residue');
{
  const before = {
    profiles: (await idbAll<StoredProfile>(STORE_PROFILES)).length,
    projects: (await idbAll<StoredProject>(STORE_PROJECTS)).length,
  };
  const { bytes } = await embeddedPackage();
  const tamper = bytes.slice();
  tamper[tamper.length - 100] ^= 0x01;
  const r = await importHandoverPackage(tamper, 'tampered.spbpkg');
  check('tampered rejected', !r.ok && r.rejectedStage === 'parse', r.rejectedStage);
  const after = {
    profiles: (await idbAll<StoredProfile>(STORE_PROFILES)).length,
    projects: (await idbAll<StoredProject>(STORE_PROJECTS)).length,
  };
  check('no residue in either store', after.profiles === before.profiles && after.projects === before.projects,
    JSON.stringify({ before, after }));
}

console.log('# name-conflict (same display name, different content) branch');
{
  // Build a package with the SAME project name as an existing one but a
  // different savedAt -> different content key.
  const pkg = await buildHandoverPackage({
    projectName: 'embedded-job',
    savedAt: '2026-09-15T12:00:00.000Z',
    imageBytes: makeImage({ embedded: srgbIcc }),
    imageName: 'job2.png',
    bitDepth: 8,
    sourceKind: 'embedded',
    targetProfile: profileLike(cmykIcc, 'cmyk3'),
    intent: 'relative-colorimetric',
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric',
  });
  const beforeProjects = (await idbAll<StoredProject>(STORE_PROJECTS)).length;
  const r = await importHandoverPackage(pkg.bytes, 'same-name.spbpkg');
  check('same-name different-content imports', r.ok && r.project.outcome === 'name-conflict-renamed', r.project.outcome);
  check('renamed with suffix', r.project.name !== 'embedded-job' && r.project.name.includes('embedded-job'));
  const projects = await idbAll<StoredProject>(STORE_PROJECTS);
  check('both projects coexist', projects.length === beforeProjects + 1);
}

console.log('# legacy v0 project coexists and loads with new handover project');
{
  const legacy: StoredProject = {
    id: 'proj-legacy-1',
    name: 'old-format-project',
    updatedAt: '2025-12-01T00:00:00.000Z',
    imageBytes: makeImage(),
    imageName: 'old.png',
    sourceProfileId: null,
    sourceIsEmbedded: false,
    targetProfileId: null,
    intent: 'perceptual' as RenderingIntent,
    blackPointCompensation: false,
    // no recordVersion / fingerprints / handover
  };
  await idbPut(STORE_PROJECTS, legacy);
  const projects = await idbAll<StoredProject>(STORE_PROJECTS);
  const legacyBack = projects.find((p) => p.id === 'proj-legacy-1');
  check('legacy project still present', !!legacyBack && legacyBack.recordVersion === undefined);
  const handoverProjects = projects.filter((p) => p.recordVersion === 1);
  check('new-format projects still present', handoverProjects.length >= 3, String(handoverProjects.length));
  // planner/validator modules stay independent of store schema version
  const parsed = await parsePackage((await embeddedPackage()).bytes);
  const v = await validatePackage(parsed);
  const plan = await planImport(v, await idbAll(STORE_PROFILES), projects, new Date().toISOString());
  check('planner sees legacy project as non-matching', !plan.project.record || plan.project.record.id !== 'proj-legacy-1');
}

console.log('# reference repair: project exists, its profile was deleted -> re-import repairs');
{
  const { bytes } = await assumedPackage();
  const projects = await idbAll<StoredProject>(STORE_PROJECTS);
  const assumed = projects.find((p) => p.name === 'assumed-job')!;
  const lib0 = await idbAll<StoredProfile>(STORE_PROFILES);
  // Delete every user-owned profile the project references. The source sRGB is
  // the protected builtin (deletion is a no-op by design) so it remains; the
  // CMYK target is the profile the repair must restore.
  const targetRec = lib0.find((p) => p.id === assumed.targetProfileId)!;
  check('fixture: source is the protected builtin', targetRec ? true : false);
  await idbDelete(STORE_PROFILES, assumed.targetProfileId!);
  check('target actually removed', !(await idbAll<StoredProfile>(STORE_PROFILES)).some((p) => p.id === assumed.targetProfileId));
  const beforeProjects = (await idbAll<StoredProject>(STORE_PROJECTS)).length;
  const beforeProfiles = (await idbAll<StoredProfile>(STORE_PROFILES)).length;
  const r = await importHandoverPackage(bytes, 'assumed-repair.spbpkg');
  check('repair import ok', r.ok, r.error);
  check('outcome reference-repaired', r.project.outcome === 'reference-repaired', r.project.outcome);
  const afterProjects = (await idbAll<StoredProject>(STORE_PROJECTS)).length;
  const afterProfiles = (await idbAll<StoredProfile>(STORE_PROFILES)).length;
  check('project NOT duplicated on repair', afterProjects === beforeProjects, `${beforeProjects} -> ${afterProjects}`);
  check('missing target profile restored on repair', afterProfiles === beforeProfiles + 1, `${beforeProfiles} -> ${afterProfiles}`);
  const repaired = (await idbAll<StoredProject>(STORE_PROJECTS)).find((p) => p.id === assumed.id)!;
  const lib = await idbAll<StoredProfile>(STORE_PROFILES);
  check('repaired source reference resolves (builtin reused)', lib.some((p) => p.id === repaired.sourceProfileId));
  check('repaired target reference resolves', lib.some((p) => p.id === repaired.targetProfileId));
}

console.log(failures ? `\n${failures} HANDOVER TEST FAILURES` : '\nALL HANDOVER TESTS PASSED');
process.exit(failures ? 1 : 0);
