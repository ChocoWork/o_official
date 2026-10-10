import { test, expect, Page } from '@playwright/test';
import type { CreateFulfillmentResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  adminOrder,
  fulfillJson,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';

// FREQ-267: 決済完了の注文を、配送業者と追跡番号を添えて発送済みにできる。
// 2026-10-10（FREQ-439）: 発送は商品と数を選ぶ1回ごとの記録になった。発送の画面は、開く時に
// GET /api/admin/orders/[id]/fulfillments で材料を読み、POST で発送する。一覧の言葉は、送る前は「発送準備中」、全部を送ると「配送中」。
// FREQ-267-AC-01/02/03 は FREQ-439-AC-01/03/04 に引き継いだ（requirements.md の注記）。

const LINE_ID = 'c1000000-0000-4000-8000-000000000001';

const PAID = adminOrder({ id: 'order-paid', items: [orderLine({ id: LINE_ID })] });
const PAID_SHIPPED = adminOrder({
  id: 'order-paid',
  status: '配送中',
  orderStatus: 'shipped',
  progressKey: 'in_transit',
  canShip: false,
  items: [orderLine({ id: LINE_ID, shipped: 1, readyUnshipped: 0 })],
});
const OTHERS = [
  adminOrder({
    id: 'order-missing-shipping',
    customerName: '配送先 未登録',
    customerEmail: 'missing@example.com',
    totalAmount: '¥18,000',
    canShip: false,
    missingShippingFields: ['address'],
  }),
  adminOrder({
    id: 'order-pending',
    customerName: '佐藤 太郎',
    customerEmail: 'taro@example.com',
    totalAmount: '¥32,000',
    status: '未決済',
    orderStatus: 'pending',
    progressKey: 'unpaid',
    canShip: false,
  }),
  adminOrder({
    id: 'order-shipped',
    customerName: '鈴木 次郎',
    customerEmail: 'jiro@example.com',
    totalAmount: '¥58,000',
    status: '配送中',
    orderStatus: 'shipped',
    progressKey: 'in_transit',
    canShip: false,
    items: [orderLine({ id: 'c1000000-0000-4000-8000-000000000002', shipped: 1, readyUnshipped: 0 })],
  }),
];

async function mockAdminApis(page: Page): Promise<void> {
  let shipped = false;
  await mockAdminSession(page);
  await mockOrderList(page, () => [shipped ? PAID_SHIPPED : PAID, ...OTHERS]);
  await page.route('**/api/admin/orders/*/fulfillments', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, shipMaterials({ orderId: 'order-paid', lines: [materialLine({ orderItemId: LINE_ID })] }));
      return;
    }
    shipped = true;
    await fulfillJson(route, {
      fulfillmentId: 'f0000000-0000-4000-8000-000000000001',
      number: 1,
      completesOrder: true,
      orderStatus: 'shipped',
      replayed: false,
    } satisfies CreateFulfillmentResponse);
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-050 order shipping (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('配送先が揃った決済完了注文にだけ発送ボタンが出る', async ({ page }) => {
      // FREQ-267-AC-01 / AC-02, FREQ-365-AC-09
      await openOrderTab(page);

      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(1);
      await expect(page.getByText('配送先要確認')).toBeVisible();
    });

    test('配送業者と追跡番号を入力して発送できる', async ({ page }) => {
      // FREQ-267-AC-02 / AC-03, FREQ-439-AC-03
      await openOrderTab(page);

      await page.getByRole('button', { name: '発送済みにする' }).click();
      // 発送の画面は材料を読み終えてから入力する
      await expect(page.getByLabel('今回送る数')).toHaveCount(1);
      await expect(page.getByLabel('配送業者')).toBeVisible();
      await page.getByLabel('配送業者').selectOption('yamato');
      await page.getByLabel('追跡番号').fill('1234-5678-9012');
      await page.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('row', { name: /order-paid/ }).getByText('配送中', { exact: true })).toBeVisible();
      await expect(page.getByRole('row', { name: /order-shipped/ }).getByText('配送中', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await openOrderTab(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
