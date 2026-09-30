import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-413: 取消の画面で理由を選び（必須）、メモとお知らせの有無を決めて取り消せる。払込票が有効な間は取り消せない。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const BASE = {
  customerEmail: 'buyer@example.com',
  orderDate: '2026-09-27',
  itemCount: '1点',
  items: [{ name: 'タックスカート', quantity: 1 }],
  totalAmount: '¥32,000',
};

const ORDERS = [
  { ...BASE, id: 'order-progress', customerName: '手続き 花子', status: '支払い手続き中', canCancel: true },
  {
    ...BASE,
    id: 'order-voucher',
    customerName: '払込 太郎',
    status: '未決済',
    canCancel: false,
    cancelBlockedUntil: '2026-09-30T14:59:59.000Z',
  },
  // Stripe の状態を読めなかった入金待ち。取り消せない側に倒し、払込期限は出せない
  {
    ...BASE,
    id: 'order-unknown',
    customerName: '不明 三郎',
    status: '未決済',
    canCancel: false,
    cancelBlockedUntil: null,
  },
  { ...BASE, id: 'order-failed', customerName: '失敗 次郎', status: '決済失敗', canCancel: true },
];

async function mockAdminApis(page: Page, cancelBodies: unknown[]): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ORDERS, pagination: { page: 1, pageSize: 20, total: ORDERS.length, totalPages: 1 } }),
    }),
  );
  await page.route('**/api/admin/orders/*/status', (route) => {
    cancelBodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: 'cancelled' }),
    });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
  await expect(page.getByRole('row', { name: /order-progress/ })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-063 order cancel dialog (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('取消の理由を選ばないと取り消せない', async ({ page }) => {
      // FREQ-413-AC-01
      await mockAdminApis(page, []);
      await openOrders(page);

      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeDisabled();

      await dialog.getByLabel('取消の理由').selectOption('customer_request');
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeEnabled();
    });

    test('お知らせは既定でオンで表示され、外すと notifyCustomer=false を送る', async ({ page }) => {
      // FREQ-413-AC-02
      const cancelBodies: unknown[] = [];
      await mockAdminApis(page, cancelBodies);
      await openOrders(page);

      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      const notify = dialog.getByRole('checkbox', { name: 'お客様に取消のお知らせを送る' });
      await expect(notify).toBeChecked();

      await dialog.getByLabel('取消の理由').selectOption('customer_request');
      await notify.uncheck();
      await dialog.getByRole('button', { name: '取り消す' }).click();

      await expect(page.getByRole('row', { name: /order-progress/ }).getByText('キャンセル', { exact: true })).toBeVisible();
      expect(cancelBodies).toEqual([{ status: 'cancelled', reason: 'customer_request', notifyCustomer: false }]);
    });

    test('「その他」はメモを入れるまで取り消せない', async ({ page }) => {
      // FREQ-413-AC-03
      const cancelBodies: unknown[] = [];
      await mockAdminApis(page, cancelBodies);
      await openOrders(page);

      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      await dialog.getByLabel('取消の理由').selectOption('other');
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeDisabled();

      await dialog.getByRole('textbox', { name: /メモ/ }).fill('電話で依頼');
      await dialog.getByRole('button', { name: '取り消す' }).click();

      await expect.poll(() => cancelBodies).toEqual([
        { status: 'cancelled', reason: 'other', note: '電話で依頼', notifyCustomer: true },
      ]);
    });

    test('払込票が有効な注文は「キャンセル」を押せず、払込期限が表示される', async ({ page }) => {
      // FREQ-413-AC-04
      await mockAdminApis(page, []);
      await openOrders(page);

      const voucher = page.getByRole('row', { name: /order-voucher/ });
      await expect(voucher.getByRole('button', { name: 'キャンセル' })).toHaveCount(0);
      await expect(
        voucher.getByText(/払込票の期限切れが確定するまで取り消せません（払込期限 2026\/09\/30 23:59）/),
      ).toBeVisible();
    });

    test('Stripe の状態を確かめられない入金待ちの注文は「キャンセル」を押せず、確かめられない旨が表示される', async ({
      page,
    }) => {
      // FREQ-413-AC-06
      await mockAdminApis(page, []);
      await openOrders(page);

      const unknown = page.getByRole('row', { name: /order-unknown/ });
      await expect(unknown.getByRole('button', { name: 'キャンセル' })).toHaveCount(0);
      await expect(unknown.getByText('支払いの状態を確かめられないため、今は取り消せません')).toBeVisible();
    });

    test('失敗の注文の取消では、お知らせの選択肢を出さない', async ({ page }) => {
      // FREQ-413-AC-05
      await mockAdminApis(page, []);
      await openOrders(page);

      await page.getByRole('row', { name: /order-failed/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });

      // 画面が開いていることを先に確かめる（開いていなければ「チェックボックスが無い」は常に成り立つ）
      await expect(dialog.getByLabel('取消の理由')).toBeVisible();
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, []);
      await openOrders(page);
      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      await expect(page.getByRole('dialog', { name: '注文を取り消す' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
