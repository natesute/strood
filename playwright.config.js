const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    // Dedicated e2e port: reusing the interactive dev server is nondeterministic —
    // once HMR has touched it, main.js imports modules with ?t= stamps while the
    // tests' bare import('/src/...') loads a second instance, which rewires the
    // master chain and silences the app's meter analyser.
    baseURL: 'http://127.0.0.1:4517',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        // Web Audio renders against a fake output stream instead of the real
        // device, so the meters keep moving when another app holds the device.
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
      ],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4517 --strictPort',
    url: 'http://127.0.0.1:4517',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
