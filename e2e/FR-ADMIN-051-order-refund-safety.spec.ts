import { expect, Page, test } from '@playwright/test';
import type { OrderItem, OrderLineItem } from '@/components/OrderSection';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-404: 入金済み注文は返金結果を正本として状態を更新する。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const LINE = {
  id: 'c1000000-0000-4000-8000-000000000001',
  color: 'ホワイト',
  size: 'M',
  quantity: 1,
  fulfillmentType: 'stock',
  shipped: 0,
  inProduction: 0,
  readyUnshipped: 1,
} satisfies Omit<OrderLineItem, 'name'>;

const ORDERS = [
  {
    id: 'order-paid',
    customerName: '決済 花子',
    customerEmail: 'paid@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [{ ...LINE, name: 'ブラウス' }],
    totalAmount: '¥10,000',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    partiallyShipped: false,
    canRefund: true,
    canShip: true,
  },
  {
    id: 'order-pending',
    customerName: '未決済 太郎',
    customerEmail: 'pending@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [{ ...LINE, name: 'スカート' }],
    totalAmount: '¥12,000',
    status: '未決済',
    orderStatus: 'pending',
    progressKey: 'unpaid',
    canRefund: false,
    canCancel: true,
  },
  {
    id: 'order-shipped',
    customerName: '発送 次郎',
    customerEmail: 'shipped@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [{ ...LINE, name: 'コート', shipped: 1, readyUnshipped: 0 }],
    totalAmount: '¥30,000',
    status: '配送中',
    orderStatus: 'shipped',
    progressKey: 'in_transit',
    canRefund: true,
  },
] satisfies OrderItem[];

async function mockAdminApis(page: Page) {
  let orderListRequests = 0;
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true,
      user: { id: 'admin-1', email: 'admin@example.com', role: 'admin', mfaVerified: true },
    }),
  }));
  await page.route('**/api/admin/orders**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/refund')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          refundStatus: 'requires_action',
          orderStatus: 'paid',
        }),
      });
    }

    orderListRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: ORDERS,
        pagination: { page: 1, pageSize: 20, total: ORDERS.length, totalPages: 1 },
      }),
    });
  });

  return { getOrderListRequests: () => orderListRequests };
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
  await expect(page.getByText('決済 花子')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-051 order refund safety (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('未決済にだけキャンセル、入金済みと発送済みに返金を表示する', async ({ page }) => {
      // FREQ-404-AC-01
      await mockAdminApis(page);
      await openOrders(page);

      const orderTable = page.getByRole('table');
      await expect(orderTable.getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(1);
      await expect(orderTable.getByRole('button', { name: '返金', exact: true })).toHaveCount(2);
      await expect(orderTable.getByRole('button', { name: '発送済みにする', exact: true })).toHaveCount(1);
    });

    test('非同期返金は一覧を再取得し、決済完了を維持して通知する', async ({ page }) => {
      // FREQ-404-AC-02
      const api = await mockAdminApis(page);
      await openOrders(page);
      page.once('dialog', (dialog) => dialog.accept());

      await page.getByRole('table').getByRole('button', { name: '返金', exact: true }).first().click();

      await expect(page.getByRole('status').filter({ hasText: '返金処理を受け付けました' })).toBeVisible();
      // 返金を受け付けても注文は入金済みのまま（画面の言葉は「発送準備中」のまま）。一覧の表の中の状態の印だけを数える
      await expect(page.getByRole('table').getByText('発送準備中', { exact: true })).toHaveCount(1);
      await expect.poll(api.getOrderListRequests).toBe(2);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page);
      await openOrders(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
