/**
 * FR-ADMIN-072 発送の取消（履歴の画面）
 * 対応 FREQ: FREQ-443
 *
 * G-1: 発送の取消（履歴の「この発送を取り消す」と DB の関数）は停止した。G-3: この spec の取消の3つのケースは、発送票の取消へ移した（ケースは削除）。
 * - 取消の行が履歴に残り、取り消した発送には取消もメールの再送も出ない → FR-ADMIN-117 の ④（履歴の取消の行・メールの再送の入口が無いこと）と ⑧（履歴に取消の入口が無く、発送票へ移る）
 * - 「戻る」では取り消さず、取消を断られた時は理由がダイアログの中に出る → FR-ADMIN-117 の ④⑤
 * - 取り消すと商品が発送準備中に戻り、全部送っていた注文が決済完了に戻り、送る前のメールは取りやめになり、取消のメールは行かず、取り消した分の番号は使い回さない → FR-ADMIN-117 の ④
 *   （DB の戻りと拒否の優先は DB 結合 group_g3_cancel）
 * ここには、履歴の画面が横にはみ出さないことの確かめだけが残る。
 */
import { expect, test, type Page } from '@playwright/test';
import type {
  OrderHistoryEmailEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
import {
  adminOrder,
  fulfillJson,
  historyOf,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a3b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b3b2c3d4-0000-4000-8000-000000000001';
const SKIRT = 'b3b2c3d4-0000-4000-8000-000000000002';
const FULFILLMENT_ID = 'f3b2c3d4-0000-4000-8000-000000000001';

function entries(): OrderHistoryResponse['entries'] {
  const shipment = {
    type: 'fulfillment',
    at: '2026-10-10T03:00:00.000Z',
    fulfillmentId: FULFILLMENT_ID,
    number: 1,
    carrierLabel: 'ヤマト運輸',
    trackingNumber: '1234-5678-9012',
    items: [{ name: 'シルクブラウス', quantity: 2 }],
    actorEmail: 'admin@example.com',
    notifyCustomer: true,
    completesOrder: false,
    cancelled: false,
    cancellable: true,
    legacy: false,
    slipId: null,
    slipNumber: null,
  } satisfies OrderHistoryFulfillmentEntry;
  const mail = {
    type: 'email',
    at: '2026-10-10T03:00:01.000Z',
    emailId: 'e3b2c3d4-0000-4000-8000-000000000001',
    kind: 'shipped',
    kindLabel: '発送（1回目）',
    manual: false,
    requestedByEmail: null,
    stateLabel: '配達済み',
    warning: false,
    attempts: 1,
    errorLabel: null,
    sentAt: '2026-10-10T03:00:05.000Z',
    deliveryEventAt: '2026-10-10T03:01:00.000Z',
    canViewContent: true,
    bodyErased: false,
    resendable: true,
    fulfillmentId: FULFILLMENT_ID,
    fulfillmentNumber: 1,
  } satisfies OrderHistoryEmailEntry;
  return [
    mail,
    shipment,
    { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
    { type: 'created', at: '2026-10-09T00:59:00.000Z' },
  ];
}

async function mockHistoryApis(page: Page) {
  await mockAdminSession(page);
  await mockOrderList(page, () => [
    adminOrder({
      id: ORDER_ID,
      items: [
        orderLine({ id: BLOUSE, name: 'シルクブラウス', quantity: 2, shipped: 2, readyUnshipped: 0 }),
        orderLine({ id: SKIRT, name: 'プリーツスカート', quantity: 1, readyUnshipped: 1 }),
      ],
      partiallyShipped: true,
    }),
  ]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) => fulfillJson(route, historyOf(ORDER_ID, entries())));
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: `${orderNumberOf(ORDER_ID)} の履歴` }).click();
  const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-072 fulfillment cancel (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('履歴の画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      await mockHistoryApis(page);
      await openOrderTab(page);
      const dialog = await openHistory(page);
      await expect(dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
