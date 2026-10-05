import { defineConfig, devices } from '@playwright/test';
import { loadEnvConfig } from '@next/env';
import { prepareE2EEnvironment } from './scripts/e2e/environment';

// アプリと同じ .env 解決規則（.env.local > .env）でテストプロセスにも環境変数を読み込む。
// これが無いと spec 側の process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY が undefined になり、
// Turnstile トークンの注入が丸ごとスキップされて送信がクライアント側で止まる。
loadEnvConfig(process.cwd());

const resolvedBaseUrl = 'http://localhost:3000';

/*
 * E2E は手元の Supabase に対して流す（設計書 2026-10-05 グループ B の第7章）。
 * 手元の Supabase の住所と鍵で .env.local の値を上書きし、本番の Supabase の鍵と Resend の鍵は
 * アプリにもテストにも渡さない。本番につながるおそれのある設定や、確かめられない3000番のアプリが
 * あれば、ここで理由を出して止まる。worker は本体が上書きした値を受け継ぐので、確かめるだけにする。
 */
const e2e = prepareE2EEnvironment({
  baseEnv: process.env,
  mode: process.env.E2E_DEV_SERVER === '1' ? 'dev' : 'start',
  strict: process.env.E2E_STRICT === '1',
  isWorker: process.env.TEST_WORKER_INDEX !== undefined,
  baseUrl: resolvedBaseUrl,
});
Object.assign(process.env, e2e.env);

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
  /*
   * html は今までどおり。json は切り替えの前後を比べるため（npm run e2e:compare が読む）。
   * test-results は実行のたびに消えるので、最後の実行の結果だけが残る。
   */
  reporter: [['html'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
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
   * E2E は本番ビルドに対して実行する。scripts/e2e-server.mjs が build して起動し、
   * 起動したサーバーはテスト終了後も動いたまま残る。
   * 3000番で動いているアプリは、見張りが「この設定で起動した E2E 用のもの」と確かめたときだけ使い回す。
   * ゲート実行（pre-push）では E2E_STRICT=1 を立て、使い回さずに必ずビルドから起動する。
   * dev サーバーで動かすデバッグ用途のみ E2E_DEV_SERVER=1 を付ける。
   */
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: resolvedBaseUrl,
    reuseExistingServer: e2e.reuseExistingServer,
    env: e2e.env,
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
