/**
 * FR-PRIVACY-008 配送の追跡の設定が /privacy に届く形
 * 対応: SEC-PRIVACY-002-AC-01・006-AC-01・012-AC-01（011-AC-01 のオンの場合）
 *
 * 追跡の設定（shop_settings）を一時的に変えるので、withDeliveryScenario（DB の pg_advisory_lock）でほかの追跡の spec と直列にし、
 * 終わりに設定を元に戻す。各試験は自分で設定の状態を作るので、試験どうしの順番には頼らない（serial にしない。1本の失敗で残りが流れなくなるため）。
 * 手元の Supabase に対してだけ流す（本番ビルド）。設定を読めない状態の試験は FR-PRIVACY-009 に分けてある。
 */
import { expect, test, type Page } from '@playwright/test';
import {
  createAdminActor,
  deliveryViewports,
  jstToday,
  setTrackingFlagDirect,
  setTrackingViaFunction,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';

const TRACKING_CLAUSE_NAME = '17TRACK';
const SECTION_5_HEADING = '5. 個人情報の取扱いの委託';

/** 「5. 個人情報の取扱いの委託」の節（見出しを含む section） */
const outsourcingSection = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: SECTION_5_HEADING, exact: true }) });

for (const viewport of deliveryViewports) {
  test.describe(`FR-PRIVACY-008 tracking setting and read failure (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-PRIVACY-006-AC-01 ${viewport.name}: 追跡がオフの時に 17TRACK の一文が表示されず、委託の一覧が3項目`, async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        await setTrackingFlagDirect(client, false);
        const response = await page.goto('/privacy');
        expect(response?.status()).toBe(200);

        await expect(page.getByRole('heading', { level: 2, name: SECTION_5_HEADING, exact: true })).toBeVisible();
        await expect(page.getByText(TRACKING_CLAUSE_NAME)).toHaveCount(0);
        await expect(outsourcingSection(page).locator('li')).toHaveCount(3);
      });
    });

    test(`SEC-PRIVACY-011-AC-01 ${viewport.name}: 追跡がオンの時は委託の一覧に 17TRACK が表示される`, async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        await page.goto('/privacy');

        await expect(outsourcingSection(page).getByText(TRACKING_CLAUSE_NAME)).toBeVisible();
        await expect(outsourcingSection(page).locator('li')).toHaveCount(4);
      });
    });

    test(`SEC-PRIVACY-002-AC-01 ${viewport.name}: 追跡の設定を管理者のメール付きで保存した後も、頁に担当者のメールが表示されない`, async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        // 前提: 設定の更新者がこの管理者として保存されている（メールが引ける状態）
        const saved = await client.query(
          'select u.email::text as email from public.shop_settings as s join auth.users as u on u.id = s.delivery_tracking_updated_by where s.id = 1',
        );
        expect(saved.rows[0]?.email).toBe(actor.email);

        const response = await page.goto('/privacy');
        if (!response) throw new Error('/privacy の応答が無い');
        expect(response.status()).toBe(200);
        // 設定が頁に届いていること（読めていなければこの確かめは空振りになる）
        await expect(page.getByText(TRACKING_CLAUSE_NAME)).toBeVisible();

        expect(await response.text()).not.toContain(actor.email);
        expect(await page.locator('body').innerText()).not.toContain(actor.email);
        expect(await page.content()).not.toContain(actor.email);
      });
    });

    test(`SEC-PRIVACY-012-AC-01 ${viewport.name}: 追跡をオンにした後、最終改定日がオンにした日かそれより後の日になる`, async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        const actor = await createAdminActor(client);
        await setTrackingFlagDirect(client, false);
        await setTrackingViaFunction(client, true, actor.id);
        const today = await jstToday(client);
        await page.goto('/privacy');
        await expect(page.getByText(TRACKING_CLAUSE_NAME)).toBeVisible();

        const text = await page.locator('body').innerText();
        const match = /最終改定日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
        expect(match, '「最終改定日：YYYY年M月D日」が表示されること').not.toBeNull();
        const [, year, month, day] = match as RegExpExecArray;
        const revised = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        expect(revised >= today, `最終改定日 ${revised} が追跡をオンにした日 ${today} 以降であること`).toBe(true);
      });
    });
  });
}
