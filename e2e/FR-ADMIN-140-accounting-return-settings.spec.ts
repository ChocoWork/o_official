import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { withAccountingScenario, type AccountingScenario } from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { FIXED_RETURN_FEE_LOCKED_TEXT } from '@/lib/orders/returns/return-messages';

// FREQ-578-AC-05 / FREQ-575-AC-04（計画3）: 返品の設定の手数料欄（返送料の定額・交換の手数料と送料は使えない。割合の手数料は設定できる）と、
// 届いた日に運送会社の配達日を使う設定（既定オフ）を、本物の画面・本物の route・手元の Supabase で確かめる。
// 返品の設定と配達日の設定は全体で1つの状態なので、このファイルの中は1つずつ流し、変えた設定は終わりに元へ戻す。
// 配達日の設定の切り替えの記録は消せないので db reset してから流す。サポーターは本物の route（権限なし）で断られることを確かめる。

test.use({ trace: 'off', locale: 'ja-JP' });
test.describe.configure({ mode: 'default' });

const SAVED = '設定を保存しました。';
const OPTION_SAVED = '保存しました。';

type FeeSettings = { restocking_fee_enabled: boolean; restocking_fee_percent: number };

async function readFees(s: AccountingScenario): Promise<FeeSettings> {
  const row = await s.db.query('select restocking_fee_enabled, restocking_fee_percent::int as restocking_fee_percent from public.shop_return_settings where id = 1');
  return row.rows[0] as FeeSettings;
}

type ReturnOption = { useCarrierDeliveryDate: boolean; changedAt: string | null; version: string };

async function readOption(s: AccountingScenario): Promise<ReturnOption> {
  const reply = await s.api(s.admin, '/api/admin/accounting/return-options');
  expect(reply.status, reply.text.slice(0, 200)).toBe(200);
  return reply.body.data.option as ReturnOption;
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-140 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-578-AC-05: 返品の設定の手数料欄は無効で、割合の手数料は設定できる', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('return-fee-settings', async (s) => {
        const original = await readFees(s);
        try {
          await s.attach(page);
          await page.route('**/api/auth/refresh', (route) => route.continue());
          await page.goto('/admin');
          await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: 'SETTINGS', exact: true }).click();
          await expect(page.getByRole('heading', { name: '返品', level: 3, exact: true })).toBeVisible({ timeout: 60_000 });

          // 返送料の定額と交換の手数料と送料は、仕訳の決まりを決めるまで使えない（欄は無効で、理由が出る）
          const ship = page.getByRole('region', { name: '返送', exact: true });
          await expect(ship.getByLabel('返送料の定額（円）', { exact: true })).toBeDisabled();
          await expect(ship.getByText(FIXED_RETURN_FEE_LOCKED_TEXT, { exact: true })).toBeVisible();
          const fees = page.getByRole('region', { name: '手数料', exact: true });
          const restocking = fees.getByRole('switch', { name: '返品の手数料を使う', exact: true });
          const exchange = fees.getByRole('switch', { name: '交換の手数料と送料を使う', exact: true });
          await expect(exchange).toBeDisabled();
          await expect(exchange).toHaveAttribute('aria-checked', 'false');
          await expect(fees.getByText(FIXED_RETURN_FEE_LOCKED_TEXT, { exact: true })).toBeVisible();
          await expect(fees.getByLabel('交換の手数料（円）', { exact: true })).toHaveCount(0);
          await expect(fees.getByLabel('交換の送料（円）', { exact: true })).toHaveCount(0);

          // 割合の手数料は設定できる（今の値と違う割合にして保存し、保存した値が DB に残る）
          const percent = original.restocking_fee_enabled && original.restocking_fee_percent === 12 ? 15 : 12;
          if ((await restocking.getAttribute('aria-checked')) !== 'true') await restocking.click();
          await fees.getByLabel('返品の手数料（%）', { exact: true }).fill(String(percent));
          await expect(fees.getByText('手で受け取った手数料は、帳簿に自動では入りません。')).toBeVisible();
          await expectNoHorizontalOverflow(page);
          await page.getByRole('button', { name: '保存する', exact: true }).first().click();
          await expect(page.getByText(SAVED, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
          const saved = await s.db.query(`select restocking_fee_enabled, restocking_fee_percent::int as restocking_fee_percent, exchange_fees_enabled,
            exchange_fee, exchange_shipping_fee, shop_label_fee from public.shop_return_settings where id = 1`);
          expect(saved.rows[0]).toMatchObject({ restocking_fee_enabled: true, restocking_fee_percent: percent, exchange_fees_enabled: false, exchange_fee: 0, exchange_shipping_fee: 0, shop_label_fee: 0 });
          await expectNoHorizontalOverflow(page);
        } finally {
          // 次の試験へ持ち越さない（割合の手数料を元の値へ戻す。DB の道具が同じ表を直接直す）
          await s.db.query('update public.shop_return_settings set restocking_fee_enabled = $1, restocking_fee_percent = $2 where id = 1', [original.restocking_fee_enabled, original.restocking_fee_percent]);
        }
      }, { period: 'none' });
    });

    test('FREQ-575-AC-04: 配達日を使う設定は既定がオフで切り替えられ、サポーターは切り替えられない', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('return-arrival-option', async (s) => {
        await s.todayPeriod();
        const initial = await readOption(s);
        // 一度も切り替えていなければ既定はオフ（切り替えた日は空）。切り替えの記録は消せないので、既定そのものを確かめられるのは db reset の後の最初の幅だけ
        if (initial.changedAt === null) expect(initial.useCarrierDeliveryDate).toBe(false);
        // 既定がオフであることは、切り替えの履歴に関わらず毎回確かめる: 列の既定値（DB の定義）と、行が1つしか無いこと
        const column = await s.db.query(
          "select column_default from information_schema.columns where table_schema = 'public' and table_name = 'accounting_return_options' and column_name = 'use_carrier_delivery_date'");
        expect(column.rows).toEqual([{ column_default: 'false' }]);
        if (initial.useCarrierDeliveryDate) {
          const reset = await s.api(s.admin, '/api/admin/accounting/return-options', 'PUT', { enabled: false, expectedVersion: initial.version, requestKey: randomUUID() });
          expect(reset.status, reset.text.slice(0, 200)).toBe(200);
        }
        try {
          // サポーター（会計の設定を切り替える権限が無い）は、本物の route で断られ、設定は変わらない
          const before = await readOption(s);
          const supporter = await s.actor('supporter', 'aal2');
          const denied = await s.api(supporter, '/api/admin/accounting/return-options', 'PUT', { enabled: true, expectedVersion: before.version, requestKey: randomUUID() });
          expect(denied.status, denied.text.slice(0, 200)).toBe(403);
          const unchanged = await readOption(s);
          expect(unchanged).toMatchObject({ useCarrierDeliveryDate: false, version: before.version });

          // 店長: 設定・期間のタブでオンにする（年の途中の注意に同意して送る）
          await s.openAccounting(page, '設定・期間');
          const section = page.getByRole('region', { name: '返品の届いた日', exact: true });
          const toggle = section.getByRole('switch', { name: '運送会社の配達日を届いた日に使う', exact: true });
          await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
          await expect(section.getByTestId('return-option-tracking-notice')).toBeVisible();
          await toggle.click();
          await expect(section.getByText('年の途中で切り替えると')).toBeVisible();
          await section.getByRole('button', { name: 'この内容で切り替える', exact: true }).click();
          await expect(section.getByText(OPTION_SAVED, { exact: true })).toBeVisible({ timeout: 60_000 });
          await expect(toggle).toHaveAttribute('aria-checked', 'true');
          const on = await readOption(s);
          expect(on.useCarrierDeliveryDate).toBe(true);
          expect(on.changedAt).not.toBeNull();
          await expectNoHorizontalOverflow(page);

          // オフへ戻す（やめるを押すと送られない。同意して戻す）
          await toggle.click();
          await section.getByRole('button', { name: 'やめる', exact: true }).click();
          expect((await readOption(s)).useCarrierDeliveryDate).toBe(true);
          await toggle.click();
          await section.getByRole('button', { name: 'この内容で切り替える', exact: true }).click();
          await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
          expect((await readOption(s)).useCarrierDeliveryDate).toBe(false);
          await expectNoHorizontalOverflow(page);
        } finally {
          // どの場合もオフに戻す
          const now = await readOption(s);
          if (now.useCarrierDeliveryDate) {
            await s.api(s.admin, '/api/admin/accounting/return-options', 'PUT', { enabled: false, expectedVersion: now.version, requestKey: randomUUID() });
          }
        }
      }, { period: 'none' });
    });
  });
}
