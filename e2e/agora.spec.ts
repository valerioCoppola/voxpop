import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Two independent users (separate browser profiles: separate storage, keys and
// identities) meet in a room through the local test relay, then one goes live.
const OUT = 'e2e-output';
mkdirSync(OUT, { recursive: true });

const fakeVideo = process.env.VOXPOP_FAKE_VIDEO;
const args = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  ...(fakeVideo ? [`--use-file-for-fake-video-capture=${fakeVideo}`] : []),
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns', // let two browsers on one machine connect directly
];

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ args });
});
test.afterAll(async () => browser.close());

async function user(viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'], acceptDownloads: true, baseURL: 'http://localhost:4173' });
  return ctx.newPage();
}

async function joinRoom(page: Page, room: string, saveLive = true) {
  await page.goto('/#agora');
  await page.locator('#room-name').fill(room);
  if (!saveLive) await page.locator('#save-live').uncheck();
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.locator('.room-title')).toHaveText(`#${room}`);
}

async function goLive(page: Page) {
  await page.goto('/#witness');
  await page.getByRole('button', { name: 'Start camera' }).click();
  const go = page.getByRole('button', { name: 'Go live' });
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await go.click();
  await expect(page.locator('.rec-time')).toContainText('LIVE');
}

test('two users: one goes live, the other watches and saves a verified copy', async () => {
  const pc = await user({ width: 1100, height: 850 });
  const phone = await user({ width: 390, height: 844 });
  const room = `test-${Date.now()}`;

  await joinRoom(pc, room);
  await joinRoom(phone, room);
  await expect(pc.locator('.room-status')).toHaveText('1 other here', { timeout: 30_000 });
  await expect(phone.locator('.room-status')).toHaveText('1 other here', { timeout: 30_000 });

  // The PC user goes live.
  await goLive(pc);
  await expect(pc.locator('.chip.live')).toContainText(`Live to #${room}, 1 person`);

  // The phone user sees the live picture arrive.
  const card = phone.locator('.live-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => card.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(card.locator('.copy-line')).toContainText('Watching only: nothing is stored');
  await phone.screenshot({ path: `${OUT}/agora-phone-watching.png` });

  // Saving is optional: the viewer asks for a copy.
  await card.getByRole('button', { name: 'Save a copy' }).click();
  await expect(card.locator('.copy-line')).toContainText(/Saving a copy: [1-9]\d* pieces? verified/, { timeout: 30_000 });
  await pc.waitForTimeout(5000);
  await pc.getByRole('button', { name: 'Stop live' }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 }); // live ended
  await phone.goto('/#ledger');
  await expect(phone.locator('.list-row')).toHaveCount(1);
  await expect(phone.locator('.list-row')).toContainText('Saved live');
  await expect(phone.locator('.badge').first()).toHaveText('Sealed');
  await phone.locator('.list-row').click();
  await expect(phone.locator('.facts')).toContainText('Saved while watching live, verified piece by piece');
  await phone.screenshot({ path: `${OUT}/agora-phone-ledger.png` });
  const [dl] = await Promise.all([phone.waitForEvent('download'), phone.getByRole('button', { name: 'Share file' }).click()]);
  await dl.saveAs(`${OUT}/live-copy.voxpop`);

  // The recorder's own ledger has the same recording.
  await pc.goto('/#ledger');
  await expect(pc.locator('.list-row')).toContainText('Yours');
});

test('live only: nothing is saved anywhere, and no copy can be requested', async () => {
  const a = await user({ width: 1000, height: 800 });
  const b = await user({ width: 390, height: 844 });
  const room = `live-only-${Date.now()}`;
  await joinRoom(a, room, false);
  await joinRoom(b, room);
  await expect(b.locator('.room-status')).toHaveText('1 other here', { timeout: 30_000 });
  await goLive(a);
  await expect(a.locator('.rec-sub')).toContainText('not saving');
  const card = b.locator('.live-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('button', { name: 'Save a copy' })).toHaveCount(0);
  await expect(card.locator('.copy-line')).toContainText('not saving');
  await a.waitForTimeout(3000);
  await a.getByRole('button', { name: 'Stop live' }).click();
  await a.goto('/#ledger');
  await expect(a.locator('.lede')).toContainText('Nothing recorded');
  await b.goto('/#ledger');
  await expect(b.locator('.lede')).toContainText('Nothing recorded');
});
