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
  /* 手元の Storage に見本の画像を置く（npx supabase db reset で消えるので毎回置き直す）。 */
  globalSetup: './scripts/e2e/global-setup.ts',
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
   * 3000番で動いているアプリを使い回すかどうかと、起動の完了は、scripts/e2e-server.mjs が印で確かめる。
   * 確かめ終わると「[e2e-server] ready」を出すので、Playwright はその1行を待つ。
   * url は渡さない。渡すと Playwright は 3000番の応答だけで先へ進み、ビルドの間に 3000番を取った
   * ほかのアプリに対してテストを流してしまう（url の確かめと stdout の待ちを競わせるため）。
   * ゲート実行（pre-push）では E2E_STRICT=1 を立て、使い回さずに必ずビルドから起動する。
   * dev サーバーで動かすデバッグ用途のみ E2E_DEV_SERVER=1 を付ける。
   */
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    wait: { stdout: /\[e2e-server\] ready/ },
    /* next build を含むので長めに取る。 */
    timeout: 600_000,
    stdout: 'pipe',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      /*
       * 全部の公開の店を一時的に非公開にする・1001 件足す試験（FR-STOCKIST-017）、検索の回数の枠を使い切る・検索の関数の権限を
       * 一時的に外す試験（FR-SEARCH-022）、LOOK の読み出し・画像の置き場を一時的に壊す試験（FR-LOOK-SEC-005）、
       * 追跡の設定を読めなくする試験（FR-PRIVACY-009）、店全体に効く自動割引を作る グループ H の試験（FR-ADMIN-124〜127・
       * FR-CHECKOUT-054〜058・FR-CART-025・FR-ITEM-DETAIL-068・FR-ACCOUNT-045。同時に流れる他の試験のカートの合計・注文の額・割引の使用を
       * 変えてしまう）は、同時に流れる他の試験を壊すので、下の isolated-global に分けて、
       * 他の全部が終わった後に流す。
       */
      testIgnore: /FR-(STOCKIST-017|SEARCH-022|LOOK-SEC-005|PRIVACY-009|ADMIN-12[4-7]|CHECKOUT-05[4-8]|CART-025|ITEM-DETAIL-068|ACCOUNT-045)-.*\.spec\.ts/,
      teardown: 'isolated-global',
    },
    /*
     * chromium の teardown になる project は 1 つだけにする。teardown を連鎖（A -> B -> C）させると、Playwright は
     * 「teardown が、その setup から届く全部（teardown もたどる）が終わるまで待つ」ので、連鎖の中の project が互いに待ち合って
     * 段に入らず、chromium 以外が全件の実行で流れない（隠れた skip）。
     * これらの file は、fullyParallel: false・workers: 1 で 1 file ずつ直列に流すので、互いにも重ならない。
     */
    {
      name: 'isolated-global',
      testMatch: /FR-(STOCKIST-017|SEARCH-022|LOOK-SEC-005|PRIVACY-009|ADMIN-12[4-7]|CHECKOUT-05[4-8]|CART-025|ITEM-DETAIL-068|ACCOUNT-045)-.*\.spec\.ts/,
      fullyParallel: false,
      workers: 1,
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
