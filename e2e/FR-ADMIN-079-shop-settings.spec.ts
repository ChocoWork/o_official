/**
 * FR-ADMIN-079 ショップの設定（自動の返金）
 * 対応 FREQ: FREQ-461（AC-01〜AC-03）・FREQ-452（AC-01〜AC-03）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P16）。窓口の答えは共通の約束（C-2）の形。確かめの画面が開いている間は、
 * 「支払額が注文と違う注文を…」の文字がトグルの名前と確かめの画面の題の2か所に出るので、文字でなく役割と名前（role）で探す。
 * 自動の返金②が要対応を自動で閉じた時の記録（FREQ-452-AC-03。解決した人が空であることと、閉じ済みの要対応を上書きしないこと）は、
 * 手元の DB の関数を直に呼んで確かめる。解決した要対応を出す画面は無い（要対応の欄は未解決だけ）ので、画面でなく DB の記録を見る。
 * 解決のメモの文は試験が自分で渡して読み返すので、実装が渡す文の確かめにはならない。その文は、単体の
 * tests/unit/lib/stripe/checkout-payment-reconciler.test.ts が確かめる（DB 結合の tests/integration/db/order_refund_results.integration.test.ts は、
 * 渡した文がそのまま残ることと、解決した人が空になることを確かめる）。
 * （自動の取消そのものは、Stripe のテストで支払額の違いを作れないので DB 結合で確かめる）。
 */
import { expect, test, type Page } from '@playwright/test';
import { uniqueSuffix } from '../tests/integration/db/helpers/order-fixtures';
import type { ShopSettings, UpdateShopSettingsRequest } from '@/lib/orders/refund/refund-types';
import { createOrderWithLines, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { fulfillJson, mockOrderList, viewports } from './order-fulfillment-test-utils';
import { formatJst, mockAdminSessionAs } from './refund-test-utils';

const AUTO_REFUND_NAME = '取り消した注文に届いた入金を、自動で全額返金する';
const AUTO_CANCEL_NAME = '支払額が注文と違う注文を、自動で全額返金して取り消す';
const AUTO_REFUND_HINT = '主にコンビニ払いで、期限切れで取り消した後に払われた時に動きます。お客様に返金のお知らせが届きます。';
const AUTO_CANCEL_HINT = 'オンにすると、差が小さくても注文は取り消されます。';
const AUTO_CANCEL_CONFIRM =
  'オンにすると、支払額が注文と違う注文は、差が小さくても自動で全額返金して取り消されます。オンにしますか？';
const SAVED = '設定を保存しました。';
const LOAD_FAILED = 'ショップの設定を読み込めませんでした。';
/** 自動の返金②が要対応を閉じる時の記録（Task 7 の照合が resolvePaymentExceptionBySystem に渡す文。task-07 の試験と同じ） */
const AUTO_CANCEL_RESOLUTION = 'システムが自動で解決した';
const CHANGED_AT = '2026-10-12T02:30:00.000Z';
const EARLIER_AT = '2026-10-11T01:30:00.000Z';

/** 最初の値: ①オン・②オフ。どちらもまだ誰も変えていない */
function initialSettings(): ShopSettings {
  return {
    autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
    autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null },
  };
}

type SettingsState = {
  settings: ShopSettings;
  puts: UpdateShopSettingsRequest[];
  loadFails: boolean;
};

async function mockApis(
  page: Page,
  options: { role?: 'admin' | 'supporter'; settings?: ShopSettings; loadFails?: boolean } = {},
): Promise<SettingsState> {
  const state: SettingsState = {
    settings: options.settings ?? initialSettings(),
    puts: [],
    loadFails: options.loadFails ?? false,
  };
  await mockAdminSessionAs(page, options.role ?? 'admin');
  await mockOrderList(page, () => []);
  await page.route('**/api/admin/settings/shop', async (route) => {
    if (route.request().method() === 'GET') {
      if (state.loadFails) {
        await fulfillJson(route, { error: 'Internal Server Error' }, 500);
        return;
      }
      await fulfillJson(route, { data: state.settings });
      return;
    }
    const body = route.request().postDataJSON() as UpdateShopSettingsRequest;
    state.puts.push(body);
    // 変えたトグルだけ、変えた人と時刻を書く（DB の関数 admin_update_shop_settings と同じ）
    const current = state.settings;
    state.settings = {
      autoRefundCancelledOrderPayment:
        body.autoRefundCancelledOrderPayment === current.autoRefundCancelledOrderPayment.enabled
          ? current.autoRefundCancelledOrderPayment
          : { enabled: body.autoRefundCancelledOrderPayment, updatedAt: CHANGED_AT, updatedByEmail: 'admin@example.com' },
      autoCancelAmountMismatch:
        body.autoCancelAmountMismatch === current.autoCancelAmountMismatch.enabled
          ? current.autoCancelAmountMismatch
          : { enabled: body.autoCancelAmountMismatch, updatedAt: CHANGED_AT, updatedByEmail: 'admin@example.com' },
    };
    await fulfillJson(route, { data: state.settings });
  });
  return state;
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: 'SETTINGS', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ショップの設定', level: 2 })).toBeVisible();
}

const autoRefundSwitch = (page: Page) => page.getByRole('switch', { name: AUTO_REFUND_NAME, exact: true });
const autoCancelSwitch = (page: Page) => page.getByRole('switch', { name: AUTO_CANCEL_NAME, exact: true });

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-079 shop settings (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('店長のメニューには SETTINGS が出て、直に開くこともできる', async ({ page }) => {
      // FREQ-461-AC-01
      await mockApis(page);
      await page.goto('/admin');
      const menu = page.getByRole('navigation', { name: '管理メニュー' });
      await expect(menu.getByRole('button', { name: 'SETTINGS', exact: true })).toBeVisible();

      await page.goto('/admin?tab=SETTINGS');
      await expect(page.getByRole('heading', { name: 'ショップの設定', level: 2 })).toBeVisible();
      await expect(menu.getByRole('button', { name: 'SETTINGS', exact: true })).toHaveAttribute('aria-current', 'page');
    });

    test('サポートの人のメニューには SETTINGS が出ず、直に開いても注文の画面に戻る', async ({ page }) => {
      // FREQ-461-AC-01
      await mockApis(page, { role: 'supporter' });
      await page.goto('/admin?tab=SETTINGS');
      const menu = page.getByRole('navigation', { name: '管理メニュー' });

      await expect(menu.getByRole('button', { name: 'ORDER' })).toHaveAttribute('aria-current', 'page');
      await expect(menu.getByRole('button', { name: 'SETTINGS' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'ショップの設定' })).toHaveCount(0);
    });

    test('題と欄の見出しが出て、最初の値は①がオン・②がオフで、最後に変えた人はまだ無い', async ({ page }) => {
      // FREQ-461-AC-02, FREQ-452-AC-01
      await mockApis(page);
      await openSettings(page);

      await expect(page.getByRole('heading', { name: '自動の返金', level: 3 })).toBeVisible();
      await expect(autoRefundSwitch(page)).toHaveAttribute('aria-checked', 'true');
      await expect(autoCancelSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByText(AUTO_REFUND_HINT)).toBeVisible();
      await expect(page.getByText(AUTO_CANCEL_HINT)).toBeVisible();
      await expect(page.getByText('まだ変えていません')).toHaveCount(2);
      // ダイアログではないので、動きは無い。目で見るための写し
      await page.screenshot({ path: `test-results/group-e2/shop-settings-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('①を切り替えると確かめなしですぐ保存され、最後に変えた人と時刻がその下に出る', async ({ page }) => {
      // FREQ-461-AC-03
      const state = await mockApis(page);
      await openSettings(page);

      await autoRefundSwitch(page).click();

      await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
      expect(state.puts).toEqual([{ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false }]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(autoRefundSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByText(`最後に変えた人: admin@example.com（${formatJst(CHANGED_AT)}）`)).toHaveCount(1);
      // 変えていない②は、まだ変えていないまま
      await expect(autoCancelSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByText('まだ変えていません')).toHaveCount(1);

      // キーボード（focus → Space）でも切り替わり、保存が済んだ後もフォーカスはそのトグルにある
      // （保存の間 disabled にすると、ブラウザがフォーカスを body へ移し、戻らない）
      await autoRefundSwitch(page).focus();
      await page.keyboard.press('Space');
      await expect(autoRefundSwitch(page)).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
      await expect(autoRefundSwitch(page)).toBeFocused();
      expect(state.puts).toEqual([
        { autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false },
        { autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: false },
      ]);
    });

    test('②をオンにする時は確かめの画面が出て、やめると何も保存せず、オンにすると保存される', async ({ page }) => {
      // FREQ-452-AC-02, FREQ-461-AC-03
      const state = await mockApis(page);
      await openSettings(page);
      const dialog = page.getByRole('dialog', { name: AUTO_CANCEL_NAME, exact: true });

      // やめる: トグルはオフのまま、何も保存しない
      await autoCancelSwitch(page).click();
      await expect(dialog.getByText(AUTO_CANCEL_CONFIRM)).toBeVisible();
      await expect(autoCancelSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(autoCancelSwitch(page)).toHaveAttribute('aria-checked', 'false');
      expect(state.puts).toHaveLength(0);

      // オンにする: ①は今の値のまま、②だけがオンの本文で保存される
      await autoCancelSwitch(page).click();
      await dialog.getByRole('button', { name: 'オンにする', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(autoCancelSwitch(page)).toHaveAttribute('aria-checked', 'true');
      expect(state.puts).toEqual([{ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: true }]);
      await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
      await expect(page.getByText(`最後に変えた人: admin@example.com（${formatJst(CHANGED_AT)}）`)).toHaveCount(1);
      await expect(page.getByText('まだ変えていません')).toHaveCount(1);
    });

    test('②をオフにする時は確かめなしですぐ保存され、前に変えた人は上書きされて今の人になる', async ({ page }) => {
      // FREQ-461-AC-03
      const state = await mockApis(page, {
        settings: {
          autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
          autoCancelAmountMismatch: { enabled: true, updatedAt: EARLIER_AT, updatedByEmail: 'owner@example.com' },
        },
      });
      await openSettings(page);
      await expect(page.getByText(`最後に変えた人: owner@example.com（${formatJst(EARLIER_AT)}）`)).toHaveCount(1);

      await autoCancelSwitch(page).click();

      await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.puts).toEqual([{ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: false }]);
      await expect(autoCancelSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByText(`最後に変えた人: admin@example.com（${formatJst(CHANGED_AT)}）`)).toHaveCount(1);
      await expect(page.getByText('owner@example.com')).toHaveCount(0);
    });

    test('設定を読み込めなかった時は、読み込めなかった旨を出し、トグルは出さない', async ({ page }) => {
      // FREQ-461-AC-02
      await mockApis(page, { loadFails: true });
      await openSettings(page);

      await expect(page.getByRole('alert').filter({ hasText: LOAD_FAILED })).toBeVisible();
      await expect(page.getByRole('switch')).toHaveCount(0);
    });

    test('システムが自動で閉じた要対応は、解決した人が空になる。閉じ済みの要対応は、もう一度閉じようとしても上書きされない（手元の DB）', async () => {
      // FREQ-452-AC-03
      // 確かめるのは、システムが閉じた要対応の「解決した人」が空になること（resolved_by が null）と、閉じ済みの要対応を上書きしないこと。
      // 解決のメモの文は試験が自分で渡して読み返すだけで、実装が渡す文（①は「システムが自動で返金した」、②は「システムが自動で解決した」）の
      // 確かめではない。その文は単体（tests/unit/lib/stripe/checkout-payment-reconciler.test.ts）が確かめる。DB 結合
      // （tests/integration/db/order_refund_results.integration.test.ts）は、渡した文がそのまま残ることと、解決した人が空になることを確かめる
      await withLocalDb(async (db) => {
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`auto-resolve-${viewport.name}`),
          [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }],
          { paidAmount: 'total' },
        );
        // 支払額の違いの要対応（自動の返金②が閉じる物）を、見つけた形で作る
        const recorded = await db.query(
          "select * from public.record_payment_exception($1::text, 'paid_amount_mismatch', null, null, null, null, $2::uuid)",
          [`pi_e2e${uniqueSuffix()}`, order.orderId],
        );
        const exceptionId = recorded.rows[0].exception_id as string;
        expect(recorded.rows[0].is_new).toBe(true);

        const closed = await db.query('select public.resolve_payment_exception_by_system($1::uuid, $2::text) as closed', [
          exceptionId,
          AUTO_CANCEL_RESOLUTION,
        ]);
        expect(closed.rows[0].closed).toBe(true);
        const row = (
          await db.query('select resolved_at, resolved_by, resolution_note from public.payment_exceptions where id = $1', [exceptionId])
        ).rows[0];
        expect(row.resolved_at).not.toBeNull();
        expect(row.resolved_by).toBeNull();
        expect(row.resolution_note).toBe(AUTO_CANCEL_RESOLUTION);

        // 閉じ済みの要対応には、もう一度呼んでも何もしない
        const again = await db.query('select public.resolve_payment_exception_by_system($1::uuid, $2::text) as closed', [
          exceptionId,
          '別の文',
        ]);
        expect(again.rows[0].closed).toBe(false);
        const kept = (await db.query('select resolution_note from public.payment_exceptions where id = $1', [exceptionId])).rows[0];
        expect(kept.resolution_note).toBe(AUTO_CANCEL_RESOLUTION);
      });
    });

    test('ショップの設定の画面でも、確かめの画面を開いても、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockApis(page);
      await openSettings(page);
      await autoCancelSwitch(page).click();
      await expect(page.getByRole('dialog', { name: AUTO_CANCEL_NAME, exact: true })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
