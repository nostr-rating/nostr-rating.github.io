import { defineConfig, devices } from '@playwright/test';

// ローカルリレー（npm run relay:up）に接続した開発サーバーで、2つのブラウザを対戦させる
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    ...devices['iPhone 13'],
    browserName: 'chromium',
    // シナリオは日本語の文言で書いている（英語のブラウザでは画面が英語になる）
    locale: 'ja-JP',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    env: { VITE_RELAYS: process.env.E2E_RELAY ?? 'ws://localhost:7777' },
  },
});
