import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'e2e-output';
mkdirSync(OUT, { recursive: true });

// A real drand quicknet beacon (round 1000000), served instead of the network.
const BEACON = {
  round: 1000000,
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
};

async function setOption(page: Page, group: string, option: string) {
  await page.goto('/#safety');
  await page.getByRole('radiogroup', { name: group }).getByText(option, { exact: true }).click();
}

async function recordFor(page: Page, ms: number) {
  await page.goto('/#witness');
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForTimeout(ms);
}

test('time proof, coarse location and map', async ({ page, context }) => {
  await context.grantPermissions(['camera', 'microphone', 'geolocation']);
  await context.setGeolocation({ latitude: 41.9028, longitude: 12.4964 });
  await page.route('https://api.drand.sh/**', (r) => r.fulfill({ json: BEACON, headers: { 'access-control-allow-origin': '*' } }));
  await setOption(page, 'Public time proof', 'On');
  await setOption(page, 'Location', '~11 km area');
  await recordFor(page, 4500);
  await expect(page.locator('.chip.ok', { hasText: 'Time proof 1000000' })).toBeVisible();
  await expect(page.locator('.chip.ok', { hasText: 'Area ~11 km' })).toBeVisible();
  await page.locator('.stage').screenshot({ path: `${OUT}/beacon-overlay.png` });
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.locator('#toast')).toContainText('sealed', { timeout: 15_000 });

  await page.goto('/#ledger');
  await expect(page.locator('.map-canvas')).toBeVisible();
  await expect(page.locator('.list-row').first()).toContainText('41.95°N 12.45°E');
  await page.screenshot({ path: `${OUT}/ledger.png` });
  await page.locator('.list-row').first().click();
  await expect(page.locator('.json')).toContainText('"round": 1000000');
  await expect(page.locator('.json')).toContainText('"la": 419');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Share file' }).click()]);
  await dl.saveAs(`${OUT}/with-time-proof.voxpop`);
});

test('interrupted recording is sealed on next start', async ({ page }) => {
  await recordFor(page, 4500);
  await page.reload(); // the app is killed mid-recording
  await expect(page.locator('#toast')).toContainText('1 interrupted recording was sealed', { timeout: 15_000 });
  await page.goto('/#ledger');
  await expect(page.locator('.badge').first()).toContainText('Interrupted');
});

test('passphrase locks watching, not recording', async ({ page }) => {
  await page.goto('/#safety');
  await page.locator('#pp-new').fill('a long passphrase');
  await page.locator('#pp-again').fill('a long passphrase');
  await page.getByRole('button', { name: 'Set passphrase' }).click();
  await expect(page.locator('#toast')).toContainText('Passphrase set', { timeout: 20_000 });
  await page.reload();
  await expect(page.locator('.lock-state')).toContainText('Locked');
  await recordFor(page, 3000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.locator('#toast')).toContainText('sealed', { timeout: 15_000 });
  await page.goto('/#ledger');
  await page.locator('.list-row').first().click();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your recordings' })).toBeVisible();
  await page.locator('#unlock-pass').fill('wrong one');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.locator('.form-error')).toContainText('Wrong passphrase', { timeout: 20_000 });
  await page.locator('#unlock-pass').fill('a long passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.locator('.detail-video video')).toBeVisible({ timeout: 20_000 });
});

test('phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#witness');
  await page.screenshot({ path: `${OUT}/phone-start.png` });
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/phone-witness.png` });
  await page.goto('/#safety');
  await page.screenshot({ path: `${OUT}/phone-safety.png` });
});

test('works offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  await page.reload(); // now controlled by the service worker
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Witness' })).toBeVisible();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled({ timeout: 60_000 });
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await context.setOffline(false);
});
