import { defineConfig } from '@playwright/test';

// End-to-end tests run against the production build (with its CSP), served locally.
// Optional: VOXPOP_FAKE_VIDEO=/path/clip.y4m feeds a video with faces as the camera.
const fakeVideo = process.env.VOXPOP_FAKE_VIDEO;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
    permissions: ['camera', 'microphone'],
    acceptDownloads: true,
    viewport: { width: 1100, height: 900 },
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        ...(fakeVideo ? [`--use-file-for-fake-video-capture=${fakeVideo}`] : []),
        ...(process.env.VOXPOP_FAKE_AUDIO ? [`--use-file-for-fake-audio-capture=${process.env.VOXPOP_FAKE_AUDIO}`] : []),
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: [
    {
      command: 'npx vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // Stand-in for the public Nostr relays (the e2e build is pointed at it).
      command: 'node e2e/nostr-relay.mjs',
      port: 7777,
      reuseExistingServer: true,
      timeout: 10_000,
    },
  ],
});
