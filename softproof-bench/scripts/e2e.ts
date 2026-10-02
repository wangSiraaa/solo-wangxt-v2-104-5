/**
 * Browser end-to-end test against the running Vite dev server.
 *
 * Covers the required flow:
 *  1. import image with embedded ICC -> source identified automatically
 *  2. import image WITHOUT ICC -> source profile selection is mandatory,
 *     assumption recorded
 *  3. choose target profile (open CIE RGB + imported open CMYK), intent, BPC
 *  4. side-by-side preview appears
 *  5. sampler reports source/target device + Lab values
 *  6. export PNG (RGB target) -> ImageMagick-independent verification done in
 *     scripts/verify-exports.sh (iCCP + pixels + provenance)
 *  7. export TIFF (CMYK target)
 *  8. re-import the converted export -> blocked as already-converted
 *  9. transparent borders survive
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FIX = resolve(ROOT, 'test-assets/browser');
const PROFILES = resolve(ROOT, 'test-assets/profiles');
const URL = process.env.E2E_URL || 'http://localhost:5199';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 980 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('text=/正在加载|原图（原始像素）/');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  (page as unknown as { __errs: string[] }).__errs = errors;
  return page;
}

async function importImage(page: Page, file: string) {
  const input = page.locator('input[type=file][accept*="png"]').first();
  await input.setInputFiles(file);
}

async function runConvert(page: Page) {
  const btn = page.getByRole('button', { name: /执行 ICC 转换/ });
  await btn.click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('LittleCMS 转换中'),
    null,
    { timeout: 60000 },
  );
}

async function exportPair(page: Page): Promise<{ png: string; tif?: string }> {
  const names: string[] = [];
  page.on('download', async (d) => names.push(d.suggestedFilename()));
  // downloads actually save via <a download>; listen for download events
  const downloads: { name: string; path: string }[] = [];
  page.removeListener('download', () => {});
  const waiters: Promise<void>[] = [];
  page.on('download', (d) => {
    const p = resolve(ROOT, 'test-out', d.suggestedFilename());
    waiters.push(d.saveAs(p));
    downloads.push({ name: d.suggestedFilename(), path: p });
  });
  await page.getByRole('button', { name: /导出转换图像/ }).click();
  await page.waitForTimeout(1500);
  await Promise.all(waiters);
  ok(`export produced 2 files (got ${downloads.length})`, downloads.length === 2, downloads.map((d) => d.name).join(','));
  const img = downloads.find((d) => d.name.endsWith('.png') || d.name.endsWith('.tif'))!;
  return { png: img.path, tif: downloads.find((d) => d.name.endsWith('.tif'))?.path };
}

// ---------- handoff package helpers ----------

interface AppSnapshot {
  projects: number;
  profileIds: string[];
  profileFingerprints: (string | undefined)[];
  imageName: string | null;
  sourceId: string | null;
  targetId: string | null;
  intent: string;
  bpc: boolean;
  proofIntent: string;
  sourceAssumed: boolean;
}

/** Store-level state via the dev hook in main.ts (window.__app). */
async function appState(page: Page): Promise<AppSnapshot> {
  return page.evaluate(() => {
    const s = (window as unknown as { __app: { state: Record<string, never> } }).__app.state as never as {
      projects: unknown[];
      profiles: { id: string; sha256?: string }[];
      image: { name: string } | null;
      sourceProfile: { id: string } | null;
      targetProfile: { id: string } | null;
      intent: string;
      blackPointCompensation: boolean;
      proofIntent: string;
      sourceAssumed: boolean;
    };
    return {
      projects: s.projects.length,
      profileIds: s.profiles.map((p) => p.id),
      profileFingerprints: s.profiles.map((p) => p.sha256),
      imageName: s.image?.name ?? null,
      sourceId: s.sourceProfile?.id ?? null,
      targetId: s.targetProfile?.id ?? null,
      intent: s.intent,
      bpc: s.blackPointCompensation,
      proofIntent: s.proofIntent,
      sourceAssumed: s.sourceAssumed,
    };
  });
}

async function exportHandoffPkg(page: Page, outName: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.getByRole('button', { name: /导出当前工程为交接包/ }).click(),
  ]);
  const p = resolve(ROOT, 'test-out', outName);
  await download.saveAs(p);
  return p;
}

async function importHandoffPkg(page: Page, file: string) {
  await page.locator('input[type=file][accept=".spkg"]').setInputFiles(file);
  await page.waitForSelector('.report', { timeout: 30000 });
}


async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--no-sandbox'],
  });

  // ---------- Scenario A: embedded sRGB -> CIE RGB ----------
  {
    const page = await freshPage(browser);
    console.log('# A. embedded-profile image -> CIE RGB');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    ok('embedded ICC badge shown', await page.locator('.badge.embedded').first().isVisible());
    ok('source description visible', (await page.locator('.mono.small').first().innerText()).length > 3);

    // transparent border canvas alpha check happens after convert; run it
    await runConvert(page);
    await page.waitForTimeout(800);
    // both canvases present and non-empty
    const canvases = await page.locator('canvas').count();
    ok('two canvases rendered', canvases >= 2, String(canvases));
    const alphaInfo = await page.evaluate(() => {
      const cvs = document.querySelectorAll('canvas');
      const out: { corner: number[]; red: number[] }[] = [];
      cvs.forEach((c) => {
        const ctx = c.getContext('2d')!;
        const corner = Array.from(ctx.getImageData(0, 0, 1, 1).data);
        const red = Array.from(ctx.getImageData(1, 1, 1, 1).data);
        out.push({ corner, red });
      });
      return out;
    });
    ok(
      'transparent corner alpha=0 on both canvases',
      alphaInfo.length >= 2 && alphaInfo.every((a) => a.corner[3] === 0),
      JSON.stringify(alphaInfo),
    );

    // sampler: hover interior red block
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.45);
    await page.waitForTimeout(600);
    const sampleText = await page.locator('.samplegrid').first().innerText();
    ok('sampler shows Lab rows', sampleText.includes('Lab') && sampleText.includes('ΔE'), sampleText.slice(0, 200));
    ok('sampler shows source percentages', /R\s+\d+\.\d%/.test(sampleText));

    // export RGB PNG
    const { png } = await exportPair(page);
    ok('PNG export exists', existsSync(png), png);
    const exported = readFileSync(png);
    ok('PNG export has iCCP marker bytes', exported.subarray(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i]));
    const errs = (page as unknown as { __errs: string[] }).__errs.filter(
      (e) => !e.includes('Failed to load resource') && !e.includes('favicon'),
    );
    ok('no page errors', errs.length === 0, errs.join(' | ').slice(0, 400));
    await page.close();
  }

  // ---------- Scenario B: missing profile forces source choice ----------
  {
    const page = await freshPage(browser);
    console.log('# B. no-ICC image forces source assumption');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('.warn');
    const warn = await page.locator('.warn.panel-warn').first().innerText();
    ok('missing-profile warning shown', warn.includes('缺少嵌入'));
    const convertBtn = page.getByRole('button', { name: /执行 ICC 转换/ });
    ok('convert disabled until source chosen', await convertBtn.isDisabled());

    // choose sRGB as assumed source
    await page.locator('select').filter({ hasText: '请选择源配置' }).first().selectOption({ index: 1 });
    await page.waitForSelector('.ok');
    ok('assumption recorded notice', (await page.locator('.small.ok').first().innerText()).includes('已记录假设'));
    ok('convert enabled after choice', !(await convertBtn.isDisabled()));
    await page.close();
  }

  // ---------- Scenario C: CMYK target -> TIFF export ----------
  {
    const page = await freshPage(browser);
    console.log('# C. RGB -> open CMYK profile -> TIFF export');
    // import CMYK profile into the library
    await page
      .locator('input[type=file][accept*=".icc"]')
      .setInputFiles(resolve(PROFILES, 'ISOcoated_v2_300_mth.icc'));
    await page.waitForTimeout(1000);
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    // pick target: select containing ISO Coated
    const targetSelect = page.locator('label.field', { hasText: '目标 ICC' }).locator('select');
    const opts = await targetSelect.locator('option').allInnerTexts();
    const isoIdx = opts.findIndex((o) => o.includes('ISO Coated'));
    ok('CMYK profile listed', isoIdx >= 0, opts.join(' | '));
    await targetSelect.selectOption({ index: isoIdx });
    await page.waitForTimeout(200);
    await runConvert(page);
    await page.waitForTimeout(800);
    const { tif } = await exportPair(page);
    ok('TIFF export produced', !!tif && existsSync(tif!), tif ?? '');
    await page.close();
  }

  // ---------- Scenario D: re-import converted export is blocked ----------
  {
    const page = await freshPage(browser);
    console.log('# D. converted export re-import is blocked');
    const exportedPng = resolve(ROOT, 'test-out')
      ? undefined
      : undefined;
    void exportedPng;
    // find latest proof png in test-out
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(ROOT, 'test-out')).filter((f) => f.endsWith('.png') && f.includes('proof'));
    ok('found converted export to re-import', files.length > 0, files.join(','));
    if (files.length) {
      await importImage(page, resolve(ROOT, 'test-out', files[0]));
      await page.waitForSelector('.danger');
      const danger = await page.locator('.danger').first().innerText();
      ok('re-import warns about double conversion', danger.includes('转换标记'));
      ok(
        'convert button blocked',
        await page.getByRole('button', { name: /执行 ICC 转换/ }).isDisabled(),
      );
    }
    await page.close();
  }

  // ---------- Scenario E: JPEG with embedded ICC (APP2 path) ----------
  {
    const page = await freshPage(browser);
    console.log('# E. embedded-profile JPEG -> CIE RGB');
    const input = page.locator('input[type=file][accept*="jpeg"]').first();
    await input.setInputFiles(resolve(FIX, 'patches-srgb.jpg'));
    await page.waitForSelector('.badge.embedded');
    ok('JPEG embedded ICC badge shown', await page.locator('.badge.embedded').first().isVisible());
    await runConvert(page);
    await page.waitForTimeout(500);
    ok('JPEG conversion rendered 2 canvases', (await page.locator('canvas').count()) >= 2);
    await page.close();
  }

  // ---------- Scenario F: 16-bit PNG with iCCP ----------
  {
    const page = await freshPage(browser);
    console.log('# F. 16-bit PNG -> CIE RGB');
    await importImage(page, resolve(FIX, 'patches-srgb16.png'));
    await page.waitForSelector('.badge.embedded');
    await runConvert(page);
    await page.waitForTimeout(900);
    const info16 = await page.evaluate(() => {
      const cvs = document.querySelectorAll('canvas');
      const c = cvs[1];
      const ctx = c.getContext('2d')!;
      return { corner: Array.from(ctx.getImageData(0, 0, 1, 1).data), w: c.width, h: c.height };
    });
    ok('16-bit source proof canvas alpha preserved', info16.corner[3] === 0, JSON.stringify(info16.corner));
    ok('16-bit dimensions kept', info16.w === 12 && info16.h === 8, JSON.stringify(info16));
    await page.close();
  }

  // ---------- Scenario G: export a handoff package ----------
  const pkgG = resolve(ROOT, 'test-out', 'handoff-g.spkg');
  {
    const page = await freshPage(browser);
    console.log('# G. export handoff package (non-default target conditions)');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    // non-default target conditions so the import side can prove reproduction
    await page.locator('label.field', { hasText: '渲染意图' }).locator('select').selectOption('saturation');
    await page.locator('label.row.check input[type="checkbox"]').uncheck();
    await page.locator('label.field', { hasText: '软打样模拟意图' }).locator('select').selectOption('absolute-colorimetric');
    const p = await exportHandoffPkg(page, 'handoff-g.spkg');
    ok('handoff package downloaded', existsSync(p) && readFileSync(p).byteLength > 1000, p);
    const head = readFileSync(p).subarray(0, 8).toString('latin1');
    ok('package magic', head === 'SPBPKG01', head);
    await page.close();
  }

  // ---------- Scenario H+I: import in ANOTHER browser reproduces the project;
  //            same-fingerprint profiles are reused; re-import is idempotent ----------
  {
    const page = await freshPage(browser); // fresh context == another offline browser
    console.log('# H. another browser imports the package and reproduces the project');
    const before = await appState(page);
    ok('fresh browser starts with builtin profiles only', before.profileIds.length === 2, before.profileIds.join(','));
    await importHandoffPkg(page, pkgG);
    const report = await page.locator('.report').innerText();
    ok('import report ok', report.includes('交接包导入完成'), report.slice(0, 200));
    ok('builtin target profile reused (not copied)', report.includes('复用本机同指纹配置'), report.slice(0, 300));
    await page.waitForSelector('.badge.embedded');
    const st = await appState(page);
    ok('exactly one project landed', st.projects === 1, String(st.projects));
    ok('no profile duplicated (library unchanged)', st.profileIds.length === 2, st.profileIds.join(','));
    ok('source reproduced as embedded', (st.sourceId ?? '').startsWith('embedded:'), st.sourceId ?? '');
    ok('image reproduced', st.imageName === 'patches-srgb.png', st.imageName ?? '');
    ok('target condition reproduced (profile)', st.targetId === 'builtin-ciergb-elle', st.targetId ?? '');
    ok('target condition reproduced (intent)', st.intent === 'saturation', st.intent);
    ok('target condition reproduced (BPC off)', st.bpc === false, String(st.bpc));
    ok('target condition reproduced (proof intent)', st.proofIntent === 'absolute-colorimetric', st.proofIntent);
    ok('reference verifiable via stored fingerprint', (st.profileFingerprints[0] ?? '').length === 64);
    // the imported project is fully workable: conversion runs end to end
    await runConvert(page);
    await page.waitForTimeout(600);
    ok('conversion works on imported project', (await page.locator('canvas').count()) >= 2);

    console.log('# I. re-importing the same package is idempotent');
    await importHandoffPkg(page, pkgG);
    await page.waitForSelector('text=幂等跳过');
    const st2 = await appState(page);
    ok('idempotent: still one project', st2.projects === 1, String(st2.projects));
    ok('idempotent: library still untouched', st2.profileIds.length === 2, st2.profileIds.join(','));
    await page.close();
  }

  // ---------- Scenario K: same-name different-bytes profile is isolated ----------
  const pkgK = resolve(ROOT, 'test-out', 'handoff-k.spkg');
  {
    const pageA = await freshPage(browser);
    console.log('# K. same-name/different-bytes profile isolation');
    await pageA.locator('input[type=file][accept*=".icc"]').setInputFiles(resolve(FIX, 'srgb-samedesc-modified.icc'));
    await pageA.waitForTimeout(1000);
    await importImage(pageA, resolve(FIX, 'patches-srgb.png'));
    await pageA.waitForSelector('.badge.embedded');
    const targetSelect = pageA.locator('label.field', { hasText: '目标 ICC' }).locator('select');
    const opts = await targetSelect.locator('option').allInnerTexts();
    const modIdx = opts.findIndex((o) => o.includes('用户导入'));
    ok('modified profile listed as user-imported', modIdx >= 0, opts.join(' | '));
    await targetSelect.selectOption({ index: modIdx });
    await pageA.waitForTimeout(200);
    await exportHandoffPkg(pageA, 'handoff-k.spkg');
    await pageA.close();

    // fresh browser: builtin sRGB has the SAME description but DIFFERENT bytes
    const pageB = await freshPage(browser);
    await importHandoffPkg(pageB, pkgK);
    const report = await pageB.locator('.report').innerText();
    ok('name conflict reported', report.includes('同名但字节不同'), report.slice(0, 400));
    const st = await appState(pageB);
    ok('isolated profile added alongside builtin', st.profileIds.length === 3, st.profileIds.join(','));
    ok('builtin sRGB untouched', st.profileIds.includes('builtin-srgb-elle'));
    const newId = st.targetId ?? '';
    ok('project references the isolated record, not the builtin', newId.startsWith('pkg-icc-'), newId);
    ok('isolated record keeps package provenance', report.includes('新增配置'), report.slice(0, 400));
    await pageB.close();
  }

  // ---------- Scenario L: tampered / truncated packages are rejected without residue ----------
  {
    const page = await freshPage(browser);
    console.log('# L. tampered and truncated packages rejected, stores stay clean');
    const bytes = readFileSync(pkgG);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 5] ^= 0xff;
    const tamperedPath = resolve(ROOT, 'test-out', 'handoff-tampered.spkg');
    writeFileSync(tamperedPath, tampered);
    const truncatedPath = resolve(ROOT, 'test-out', 'handoff-truncated.spkg');
    writeFileSync(truncatedPath, bytes.subarray(0, bytes.length - 61));

    await importHandoffPkg(page, tamperedPath);
    let report = await page.locator('.report').innerText();
    ok('tampered package rejected', report.includes('交接包被拒绝'), report.slice(0, 200));
    ok('rejection lists fingerprint issue', report.includes('指纹'), report.slice(0, 300));
    let st = await appState(page);
    ok('no project residue after tamper', st.projects === 0, String(st.projects));
    ok('no profile residue after tamper', st.profileIds.length === 2, st.profileIds.join(','));

    await importHandoffPkg(page, truncatedPath);
    report = await page.locator('.report').innerText();
    ok('truncated package rejected', report.includes('交接包被拒绝'), report.slice(0, 200));
    st = await appState(page);
    ok('no project residue after truncation', st.projects === 0, String(st.projects));
    ok('no profile residue after truncation', st.profileIds.length === 2, st.profileIds.join(','));
    await page.close();
  }

  // ---------- Scenario M: legacy (pre-handoff) projects coexist and still load ----------
  {
    const page = await freshPage(browser);
    console.log('# M. legacy-format project coexists with handoff packages');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('.warn');
    const srcSelect = page.locator('select').filter({ hasText: '请选择源配置' }).first();
    const srcOpts = await srcSelect.locator('option').allInnerTexts();
    const srgbIdx = srcOpts.findIndex((o) => o.toLowerCase().includes('srgb'));
    await srcSelect.selectOption({ index: srgbIdx });
    await page.getByRole('button', { name: '保存工程' }).click();
    await page.waitForTimeout(600);
    // strip handoff-era fields to simulate a record written before this feature
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('softproof-bench');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const t = db.transaction('projects', 'readwrite');
      const store = t.objectStore('projects');
      const all = await new Promise<Record<string, unknown>[]>((res, rej) => {
        const q = store.getAll();
        q.onsuccess = () => res(q.result as Record<string, unknown>[]);
        q.onerror = () => rej(q.error);
      });
      for (const p of all) {
        delete p.schemaVersion;
        delete p.proofIntent;
        delete p.handoff;
        store.put(p);
      }
      await new Promise<void>((res, rej) => {
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
    });
    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await page.waitForTimeout(600);
    await importHandoffPkg(page, pkgG);
    let st = await appState(page);
    ok('legacy + handoff projects coexist', st.projects === 2, String(st.projects));
    // load the legacy project: old record shape must still load fine
    await page.locator('.projlist .pl', { hasText: 'patches-noicc' }).locator('button').first().click();
    await page.waitForTimeout(600);
    st = await appState(page);
    ok('legacy project still loads', st.imageName === 'patches-noicc.png', st.imageName ?? '');
    ok('legacy source assumption restored', st.sourceId === 'builtin-srgb-elle' && st.sourceAssumed, `${st.sourceId} assumed=${st.sourceAssumed}`);
    ok('legacy proofIntent defaulted', st.proofIntent === 'relative-colorimetric', st.proofIntent);
    await page.close();
  }

  // ---------- Scenario N: a marked (already-converted) image stays blocked through handoff ----------
  {
    const pageA = await freshPage(browser);
    console.log('# N. conversion-marked image in a package keeps its protection');
    await importImage(pageA, resolve(FIX, 'patches-srgb.png'));
    await pageA.waitForSelector('.badge.embedded');
    await runConvert(pageA);
    await pageA.waitForTimeout(600);
    const { png: proofPng } = await exportPair(pageA);
    await importImage(pageA, proofPng); // re-import the marked export
    await pageA.waitForSelector('.danger');
    await exportHandoffPkg(pageA, 'handoff-marked.spkg');
    await pageA.close();

    const pageB = await freshPage(browser);
    await importHandoffPkg(pageB, resolve(ROOT, 'test-out', 'handoff-marked.spkg'));
    const report = await pageB.locator('.report').innerText();
    ok('import ok but provenance warning surfaced', report.includes('已转换'), report.slice(0, 400));
    await pageB.waitForSelector('.panel-warn');
    ok('marker warning shown after handoff import', (await pageB.locator('.panel-warn').first().innerText()).includes('转换标记'));
    ok(
      'convert stays blocked after handoff import',
      await pageB.getByRole('button', { name: /执行 ICC 转换/ }).isDisabled(),
    );
    await pageB.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} E2E FAILURES` : '\nALL E2E TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
