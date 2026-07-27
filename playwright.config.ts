import { defineConfig, devices } from '@playwright/test';

const resolvedBaseUrl = process.env.BASE_URL || 'http://localhost:3000';

/**
 * E2E は本番ビルド（next build && next start）に対して実行する。
 * dev サーバーはリクエストのたびにオンデマンドコンパイルするため、
 * 長時間の回帰では page.goto が 30 秒返らない偽の失敗を出す。
 * （288 件 22 分の直列実行で 9 件失敗 → 同じテストを単体実行すると 111/111 パス）
 * dev サーバーで動かしたい場合のみ E2E_DEV_SERVER=1 を付ける。
 */
const useDevServer = process.env.E2E_DEV_SERVER === '1';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Use a single worker to reduce suite flakiness in this workspace. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: resolvedBaseUrl,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    /* Screenshot on failure */
    screenshot: 'only-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },
  ],

  /* テスト前にサーバーを起動する（既定は本番ビルド） */
  webServer: {
    command: useDevServer ? 'npm run dev' : 'npm run build && npm run start',
    url: `${resolvedBaseUrl}/item`,
    reuseExistingServer: true, // 既存のサーバーを再利用
    // ビルドを含むため dev より長く待つ。
    timeout: (useDevServer ? 120 : 300) * 1000,
  },
});
