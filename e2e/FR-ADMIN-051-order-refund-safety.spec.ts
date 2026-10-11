import { expect, test, type Page } from '@playwright/test';
import type { OrderItem, OrderLineItem } from '@/components/OrderSection';
import { mockAdminSession, mockOrderList, openOrderTab, viewports } from './order-fulfillment-test-utils';
import {
  REFUND_TEXT,
  formatYen,
  materialLineOf,
  mockRefundRoutes,
  newRefundRouteState,
  openRefundDialog,
  quantityInput,
  refundMaterialsOf,
} from './refund-test-utils';

// FREQ-404: 入金済み注文は返金結果を正本として状態を更新する。
// グループ E-2（2026-10-11）: 返金は確かめ付きの返金の画面（FREQ-448）から行う形に変わった。FREQ-404 の基準は、キャンセルの出る条件（FREQ-449）・
// 返金の記録（FREQ-447）・Stripe の画面からの返金の取り込み（FREQ-450）に引き継いだ。詳しい動きは FR-ADMIN-074・075・080 が確かめ、
// ここには「ボタンが出る条件」と「返金を受け付けても注文は入金済みのまま、一覧を読み直す」を残す。

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

async function openOrders(page: Page) {
  await openOrderTab(page);
  await expect(page.getByText('決済 花子')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-051 order refund safety (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('未決済にだけキャンセル、入金済みと発送済みに返金を表示する', async ({ page }) => {
      // FREQ-404-AC-01
      await mockAdminSession(page);
      await mockOrderList(page, () => ORDERS);
      await openOrders(page);

      const orderTable = page.getByRole('table');
      await expect(orderTable.getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(1);
      await expect(orderTable.getByRole('button', { name: '返金', exact: true })).toHaveCount(2);
      await expect(orderTable.getByRole('button', { name: '発送済みにする', exact: true })).toHaveCount(1);
    });

    test('返金は確かめ付きの返金の画面から行い、保留で受け付けても注文は入金済みのまま、一覧を読み直して知らせる', async ({ page }) => {
      // FREQ-404-AC-02
      // ブラウザの確認の画面（window.confirm）は使わない。出たら、記録して閉じる（閉じるだけでは返金が止まって見えるので、最後に空を確かめる）
      const nativeDialogs: string[] = [];
      page.on('dialog', async (dialog) => {
        nativeDialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await mockAdminSession(page);
      const list = await mockOrderList(page, () => ORDERS);
      const state = newRefundRouteState(
        refundMaterialsOf({
          orderId: 'order-paid',
          lines: [materialLineOf({ orderItemId: LINE.id, name: 'ブラウス', itemPrice: 10_000 })],
        }),
      );
      await mockRefundRoutes(page, 'order-paid', state);
      await openOrders(page);

      const dialog = await openRefundDialog(page, 'order-paid');
      await quantityInput(dialog, '発送前の商品', 'ブラウス（ホワイト / M）').fill('1');
      await dialog.getByRole('button', { name: `${formatYen(10_000)} を返金する`, exact: true }).click();

      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticePending })).toBeVisible();
      expect(state.refundPosts).toHaveLength(1);
      // 返金を受け付けても注文は入金済みのまま（画面の言葉は「発送準備中」のまま）。一覧の表の中の状態の印だけを数える
      await expect(page.getByRole('table').getByText('発送準備中', { exact: true })).toHaveCount(1);
      await expect.poll(() => list.urls.length).toBe(2);
      expect(nativeDialogs).toEqual([]);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminSession(page);
      await mockOrderList(page, () => ORDERS);
      await openOrders(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
