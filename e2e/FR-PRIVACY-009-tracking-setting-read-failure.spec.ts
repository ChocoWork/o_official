/**
 * FR-PRIVACY-009 追跡の設定を読めない時の /privacy の失敗の画面
 * 対応: SEC-PRIVACY-005-AC-01・008-AC-01・009-AC-01
 *
 * 【ほかの spec と同時に流さない】サービスロールの実行権を DB 全体で一時的に外す（revoke execute ... from service_role）。
 * withDeliveryScenario（pg_advisory_lock(940488)）は追跡の spec どうしを並べるだけで、/privacy・設定の API・17TRACK の webhook・
 * 配送の cron の worker を叩くほかの spec（fullyParallel・4 worker）は、この間に流れると無関係な理由で落ちる。
 * この file は playwright.config.ts の単独の project（isolated-global。chromium 側は testIgnore。chromium の teardown、fullyParallel: false・workers: 1 で 1 file ずつ直列）で流す。
 * 手元の Supabase に対してだけ流す（本番ビルド）。終わりに必ず grant で戻す。異常終了で外れたままなら npm run db:reset で直る。
 * 試験は serial にしない（1本の失敗で残りが流れなくなるため）。各試験が自分で権限を外し・戻す。
 */
import { expect, test, type Page } from '@playwright/test';
import { deliveryViewports, withDeliveryScenario } from './delivery-tracking-test-utils';
import type { PgClient } from '../tests/integration/db/helpers/local-db';

const TRACKING_CLAUSE_NAME = '17TRACK';
const SECTION_5_HEADING = '5. 個人情報の取扱いの委託';
const SETTINGS_FUNCTION = 'public.get_delivery_tracking_settings()';

/** 設定の読み出し関数を service_role から一時的に取り上げ、run の間だけ「設定を読めない」状態にする。終わりに必ず戻す */
async function withSettingsUnreadable<T>(client: PgClient, run: () => Promise<T>): Promise<T> {
  const privilege = async () =>
    (await client.query(`select has_function_privilege('service_role', '${SETTINGS_FUNCTION}', 'execute') as ok`)).rows[0].ok as boolean;
  if (!(await privilege())) throw new Error('前提: service_role は設定の読み出し関数を実行できるはず');
  await client.query(`revoke execute on function ${SETTINGS_FUNCTION} from service_role`);
  try {
    expect(await privilege(), '前提: 実行権を外せたこと').toBe(false);
    return await run();
  } finally {
    await client.query(`grant execute on function ${SETTINGS_FUNCTION} to service_role`);
  }
}

/** 設定を読めない状態で /privacy を開き、応答と画面に見える文字を返す */
async function openPrivacyWhileUnreadable(page: Page) {
  const response = await page.goto('/privacy');
  if (!response) throw new Error('/privacy の応答が無い');
  // 失敗の画面がサイトの枠（main）の中なら main の字だけ、枠ごと既定の誤りの画面なら body の字を見る（ヘッダー・フッターの字を混ぜない）
  const main = page.getByRole('main');
  const visibleText = (await main.count()) > 0 ? await main.innerText() : await page.locator('body').innerText();
  return { response, visibleText };
}

for (const viewport of deliveryViewports) {
  test.describe(`FR-PRIVACY-009 tracking setting read failure (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-PRIVACY-005-AC-01 ${viewport.name}: 設定を読めない時に委託の一覧が表示されず、誤りの画面になる`, async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        await withSettingsUnreadable(client, async () => {
          const { response, visibleText } = await openPrivacyWhileUnreadable(page);

          // 誤りの画面
          expect(response.status()).toBe(500);
          // 誤りの画面として何かが表示されている（空白の画面ではない）。方針の本文の h1 は無い
          expect(visibleText.trim(), '誤りの画面に表示される字').not.toBe('');
          await expect(page.getByRole('heading', { level: 1, name: /Privacy Policy/ })).toHaveCount(0);
          // 委託の一覧（5 節）が表示されない。方針の本文ごと出さない
          await expect(page.getByRole('heading', { level: 2, name: SECTION_5_HEADING, exact: true })).toHaveCount(0);
          await expect(page.getByText('決済処理業務（Stripe, Inc.）')).toHaveCount(0);
          await expect(page.getByText('商品の配送業務（配送事業者）')).toHaveCount(0);
          expect(visibleText).not.toContain(TRACKING_CLAUSE_NAME);
          expect(visibleText).not.toContain('個人情報の取扱いの委託');
        });
      });
    });

    test(`SEC-PRIVACY-008-AC-01 ${viewport.name}: 失敗の画面に設定の関数・環境変数・SQL の誤りの文が表示されない`, async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        await withSettingsUnreadable(client, async () => {
          const { response, visibleText } = await openPrivacyWhileUnreadable(page);
          expect(response.status(), '前提: 失敗の画面になっていること').toBe(500);

          expect(visibleText).not.toContain('get_delivery_tracking_settings');
          expect(visibleText).not.toContain('DELIVERY_');
          expect(visibleText).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
          expect(visibleText).not.toContain('SUPABASE_URL');
          // SQL の誤りの文（権限の拒否・Postgres・PostgREST の言い回し）
          expect(visibleText).not.toMatch(/permission denied|PGRST\d+|42501|SQLSTATE|relation ".*" does not exist|syntax error at or near/i);
        });
      });
    });

    test(`SEC-PRIVACY-009-AC-01 ${viewport.name}: 設定を読めない時の画面に、開き直す案内か窓口が表示される`, async ({ page }) => {
      test.fail(true, 'SEC-PRIVACY-009 今のコードは満たさない（error.tsx が無く既定の誤りの頁。docs/02_Requirements/areas/privacy.md）');
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        await withSettingsUnreadable(client, async () => {
          const { response, visibleText } = await openPrivacyWhileUnreadable(page);
          expect(response.status(), '前提: 失敗の画面になっていること').toBe(500);

          // 時間を置いて開き直す案内、窓口のメール、お問い合わせのフォームへのリンクのどれか
          const retryGuidance = /時間を置|しばらく(してから|経ってから|後)|再度|もう一度|開き直|再読み込み/;
          const hasGuidanceText = retryGuidance.test(visibleText) || visibleText.includes('privacy@lefildesheures.com');
          const contactLinks = await page.getByRole('link', { name: /お問い合わせ|privacy@/ }).count();
          expect(
            hasGuidanceText || contactLinks > 0,
            `失敗の画面に、開き直す案内か窓口（メール・お問い合わせフォーム）が表示されること。画面の文字: ${visibleText.slice(0, 200)}`,
          ).toBe(true);
        });
      });
    });
  });
}
