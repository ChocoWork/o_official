/**
 * FR-ADMIN-076 注文の支払いの言葉（詳細の「支払いと返金」）
 * 対応 FREQ: FREQ-458（AC-01・AC-03）
 *
 * 管理画面の注文の詳細（/admin/orders/[id]）を、窓口を差し替えて確かめる（実装計画 P16）。窓口の答えは共通の約束（C-2）の形。
 * 支払いの言葉6つが、進み具合の言葉・小さな印・操作のボタンの字と1つも重ならないこと（Task 12 の T12-3）は、
 * 詳細の中の言葉を exact: true で探す今の E2E（FR-ADMIN-051・063・070）が1つに決まったままである前提なので、ここで守る。
 * G-4 で旧い注文の一覧は撤去した。旧い一覧の確かめのうち、「支払い」の列の見出し（AC-02）は列が無くなったので削除し、
 * 返金・キャンセルのボタンの出方（AC-04）は FR-ADMIN-051・075（詳細頁）が、CSV の列（AC-05）は FR-ADMIN-121 ⑦（12列の新しい CSV）が持つ。
 */
import { expect, test, type Page } from '@playwright/test';
import {
  adminOrder,
  adminOrderDetail,
  detailSection,
  mockAdminSession,
  mockOrderDetail,
  openOrderDetail,
  viewports,
} from './order-fulfillment-test-utils';
import { formatYen } from './refund-test-utils';

const PAYMENT_WORDS = ['未入金', '支払い済み', '一部返金', '返金済み', '支払いの失敗', '支払いなし'] as const;

/** 8つの注文。支払いの言葉の6つが全部出る */
const ORDERS = {
  unpaid: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000001', customerName: '未入金 太郎', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid',
    canShip: false, canCancel: true, cancelKind: 'unpaid', paymentStatusKey: 'unpaid', refundedAmountLabel: '-',
  }),
  failed: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000002', customerName: '失敗 次郎', status: '決済失敗', orderStatus: 'failed', progressKey: 'failed',
    canShip: false, paymentStatusKey: 'failed', refundedAmountLabel: '-',
  }),
  abandoned: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000003', customerName: '放棄 三郎', status: '放棄', orderStatus: 'abandoned', progressKey: 'abandoned',
    canShip: false, paymentStatusKey: 'none', refundedAmountLabel: '-',
  }),
  paid: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000004', customerName: '入金 四郎', canShip: false, canRefund: true, canCancel: true, cancelKind: 'paid',
    paymentStatusKey: 'paid', refundedAmountLabel: '-',
  }),
  partial: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000005', customerName: '一部 五郎', canShip: false, canRefund: true, canCancel: false, cancelKind: null,
    paymentStatusKey: 'partially_refunded', refundedAmountLabel: formatYen(5_000),
  }),
  refunded: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000006', customerName: '済み 六郎', status: 'キャンセル', orderStatus: 'cancelled', progressKey: 'cancelled',
    canShip: false, canRefund: false, canCancel: false, cancelKind: null, paymentStatusKey: 'refunded',
    refundedAmountLabel: formatYen(28_800),
  }),
  cancelPending: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000007', customerName: '手続き 七郎', status: 'キャンセルの手続き中', progressKey: 'cancel_pending',
    canShip: false, canRefund: false, canCancel: false, cancelKind: null, paymentStatusKey: 'paid', refundPending: true,
    refundedAmountLabel: '-',
  }),
  refundFailed: adminOrder({
    id: 'a6000000-0000-4000-8000-000000000008', customerName: '失敗の印 八郎', canShip: false, canRefund: true, canCancel: false,
    cancelKind: null, paymentStatusKey: 'paid', refundFailed: true, refundedAmountLabel: '-',
  }),
};

type OrderKey = keyof typeof ORDERS;

async function mockDetails(page: Page): Promise<void> {
  const byId = new Map(Object.values(ORDERS).map((order) => [order.id, order]));
  await mockAdminSession(page);
  await mockOrderDetail(page, (orderId) => {
    const order = byId.get(orderId);
    if (!order) throw new Error(`試験の注文が無い: ${orderId}`);
    return adminOrderDetail(order);
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-076 order payment words (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('詳細の「支払いと返金」に6つの言葉のどれかが1つだけ出て、進み具合の言葉と重ならない', async ({ page }) => {
      // FREQ-458-AC-01
      await mockDetails(page);
      const expectedPayment: Record<OrderKey, (typeof PAYMENT_WORDS)[number]> = {
        unpaid: '未入金',
        failed: '支払いの失敗',
        abandoned: '支払いなし',
        paid: '支払い済み',
        partial: '一部返金',
        refunded: '返金済み',
        cancelPending: '支払い済み',
        refundFailed: '支払い済み',
      };
      for (const [key, word] of Object.entries(expectedPayment) as Array<[OrderKey, (typeof PAYMENT_WORDS)[number]]>) {
        await openOrderDetail(page, ORDERS[key].id);
        const payment = detailSection(page, '支払いと返金');
        for (const candidate of PAYMENT_WORDS) {
          await expect(payment.getByText(candidate, { exact: true }), `${key} の「${candidate}」`).toHaveCount(candidate === word ? 1 : 0);
        }
      }

      // 進み具合の言葉は、支払いの言葉とは別に、注文情報に1つだけ出る
      const expectedProgress: Partial<Record<OrderKey, string>> = {
        unpaid: '未決済',
        failed: '決済失敗',
        abandoned: '放棄',
        paid: '発送準備中',
        refunded: 'キャンセル',
        cancelPending: 'キャンセルの手続き中',
      };
      for (const [key, word] of Object.entries(expectedProgress) as Array<[OrderKey, string]>) {
        expect(PAYMENT_WORDS as readonly string[], `進み具合の「${word}」は支払いの言葉と重ならない`).not.toContain(word);
        await openOrderDetail(page, ORDERS[key].id);
        await expect(detailSection(page, '注文情報').getByText(word, { exact: true }), `${key} の「${word}」`).toHaveCount(1);
        for (const candidate of PAYMENT_WORDS) {
          await expect(detailSection(page, '注文情報').getByText(candidate, { exact: true }), `${key} の注文情報の「${candidate}」`).toHaveCount(0);
        }
      }
    });

    test('「返金の手続き中」と「返金の失敗」の小さな印は、その注文の詳細にだけ付く', async ({ page }) => {
      // FREQ-458-AC-03。「返金の手続き中」は金額の見出し（dt）にも同じ字があるので、見出しを除いた印だけを数える
      await mockDetails(page);
      const badge = (text: '返金の手続き中' | '返金の失敗') =>
        detailSection(page, '支払いと返金').getByText(text, { exact: true }).and(page.locator(':not(dt)'));

      for (const key of ['unpaid', 'failed', 'abandoned', 'paid', 'partial', 'refunded'] as const) {
        await openOrderDetail(page, ORDERS[key].id);
        await expect(badge('返金の手続き中'), `${key} の返金の手続き中`).toHaveCount(0);
        await expect(badge('返金の失敗'), `${key} の返金の失敗`).toHaveCount(0);
      }
      await openOrderDetail(page, ORDERS.cancelPending.id);
      await expect(badge('返金の手続き中')).toBeVisible();
      await expect(badge('返金の失敗')).toHaveCount(0);
      await openOrderDetail(page, ORDERS.refundFailed.id);
      await expect(badge('返金の失敗')).toBeVisible();
      await expect(badge('返金の手続き中')).toHaveCount(0);
      // 返金の失敗の印が付いた注文も、支払いの言葉は「支払い済み」のまま
      await expect(detailSection(page, '支払いと返金').getByText('支払い済み', { exact: true })).toHaveCount(1);
    });

    test('支払いと返金の欄を出しても、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockDetails(page);
      await openOrderDetail(page, ORDERS.cancelPending.id);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
