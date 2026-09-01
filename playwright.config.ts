import { defineConfig, devices } from '@playwright/test';

const resolvedBaseUrl = 'http://localhost:3000';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /*
   * ファイル内のテストも並列に流す。16 論理コアあるので逐次実行は待ち時間が無駄になる。
   * 並列度は PW_WORKERS で調整する（干渉が出たら下げる。retries で誤魔化さない）。
   */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /*
   * 既定は 4。以前は「不安定さを抑えるため」1 に固定していたので、
   * 上げるときは干渉の実測とセットで行うこと。
   */
  workers: Number(process.env.PW_WORKERS ?? 4),
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

  /*
   * E2E は本番ビルドに対して実行する。3000 が既に起動していればそれを再利用し、
   * 起動していなければ scripts/e2e-server.mjs が build して起動する。
   * 起動したサーバーはテスト終了後も動いたまま残る。
   * dev サーバーで動かすデバッグ用途のみ E2E_DEV_SERVER=1 を付ける。
   */
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: resolvedBaseUrl,
    /*
     * 対話的な実行では起動済みサーバーを使い回して待ち時間を減らす。
     * ゲート実行（pre-push）では E2E_STRICT=1 を立て、必ず自前でビルドから起動する。
     * 使い回すと「どのビルドを検証したのか」が曖昧になり、計測が信用できなくなる。
     */
    reuseExistingServer: process.env.E2E_STRICT !== '1',
    /* next build を含むので長めに取る。 */
    timeout: 600_000,
    stdout: 'pipe',
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

});
