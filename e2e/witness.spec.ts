import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate';

const OUT = 'e2e-output';
mkdirSync(OUT, { recursive: true });

async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to load (CSP): ${e.violatedDirective} ${e.blockedURI}`));
  });
  return violations;
}

test('record with protection, export, verify, detect tampering', async ({ page }) => {
  const csp = await watchCsp(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Witness' })).toBeVisible();

  // Camera → protection ready
  await page.getByRole('button', { name: 'Start camera' }).click();
  const rec = page.getByRole('button', { name: 'Start recording' });
  await expect(rec).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('.chip.ok', { hasText: 'Faces covered' })).toBeVisible();
  const iso = await page.evaluate(() => self.crossOriginIsolated);
  console.log('crossOriginIsolated:', iso);
  await page.waitForTimeout(1500);
  await page.locator('.stage').screenshot({ path: `${OUT}/preview.png` });

  // Record ~7 s
  await rec.click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await expect(page.locator('.rec-sub')).toContainText('pieces signed and saved', { timeout: 10_000 });
  await page.waitForTimeout(6000);
  await page.locator('.stage').screenshot({ path: `${OUT}/recording.png` });
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.locator('#toast')).toContainText('Recording sealed and saved', { timeout: 15_000 });

  // Ledger → export
  await page.goto('/#ledger');
  await expect(page.locator('.lede')).toContainText('1 recording');
  await page.locator('.list-row').first().click();
  await expect(page.locator('.json')).toContainText('"kind": "header"');
  await page.screenshot({ path: `${OUT}/ledger-detail.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Share file' }).click()]);
  const file = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(file);
  await page.keyboard.press('Escape');

  // Verify the exported file in the app
  await page.goto('/#verify');
  await page.locator('#verify-file').setInputFiles(file);
  await expect(page.getByRole('heading', { name: 'Intact and authentic' })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${OUT}/verify-ok.png`, fullPage: true });

  // Tamper: flip one byte in the middle of the video and re-zip
  const files = unzipSync(new Uint8Array(readFileSync(file)));
  const vname = Object.keys(files).find((k) => k.startsWith('video.'))!;
  const v = files[vname].slice();
  v[Math.floor(v.length / 2)] ^= 0xff;
  const bad = `${OUT}/tampered.voxpop`;
  writeFileSync(bad, zipSync({ 'manifest.json': files['manifest.json'], [vname]: v, 'README.txt': strToU8('x') }));
  await page.locator('#verify-file').setInputFiles(bad);
  await expect(page.getByRole('heading', { name: 'This file did not pass' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.check.fail')).toContainText(/modified after signing|checksum/);

  // Rejected file is listed (not hidden) in the ledger
  await page.goto('/#ledger');
  await expect(page.getByRole('heading', { name: 'Files that failed checks' })).toBeVisible();
  await expect(page.locator('.rejected')).toContainText('tampered.voxpop');

  // The manifest contains no exact location, no device identifiers
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(Object.keys(manifest.header.rec).sort()).toEqual(['alg', 'app', 'audio', 'cell', 'faces', 'identity', 'kind', 'mime', 'pub', 'r', 't', 'v']);
  expect(manifest.seal.rec.interrupted).toBe(false);
  expect(manifest.chunks.length).toBeGreaterThanOrEqual(3);

  expect(csp, 'no CSP violations').toEqual([]);
});

test('panic wipe deletes everything', async ({ page }) => {
  await page.goto('/#safety');
  const btn = page.getByRole('button', { name: 'Hold 2 s to wipe everything' });
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2300);
  await page.mouse.up();
  await page.waitForLoadState('load');
  await page.goto('/#ledger');
  await expect(page.locator('.lede')).toContainText('Nothing recorded or received yet.');
});
