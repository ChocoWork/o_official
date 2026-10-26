/**
 * FR-ADMIN-075 支払い済みの注文のキャンセル
 * 対応 FREQ: FREQ-449（AC-01〜AC-04）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P16）。窓口の答えは共通の約束（C-2）の形。
 * 答えが分からない時の扱いは返金の画面と同じ（Review Focus 1。FR-ADMIN-074 が詳しく確かめる）。
 * 支払い済みのキャンセルの画面は、目で見るために3つの画面幅の写しを test-results/group-e2/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import type { OrderItem } from '@/lib/orders/admin-orders/admin-order-types';
import type { RefundErrorResponse, RefundMaterials, RefundPaymentMethod } from '@/lib/orders/refund/refund-types';
import {
  UUID_PATTERN,
  adminOrder, adminOrderDetail, detailSection, SUPPORTER_DETAIL_PERMISSIONS,
  fulfillJson,
  mockAdminSession,
  mockOrderDetail,
  openOrderDetail,
  orderLine,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';
import {
  REFUND_TEXT,
  TIMING_NOTES,
  acceptedRefund,
  formatYen,
  materialLineOf,
  mockAdminSessionAs,
  mockRefundRoutes,
  newRefundRouteState,
  openDetailPaidCancelDialog,
  paidCancelDialogTitle,
  refundErrorMessage,
  refundMaterialsOf,
  refuseRefund,
} from './refund-test-utils';

const PAID_ID = 'a5b2c3d4-1111-2222-8333-444455556666';
const PARTIAL_ID = 'a5b2c3d4-2222-2222-8333-444455556666';
const SHIPPED_ID = 'a5b2c3d4-3333-2222-8333-444455556666';
const UNPAID_ID = 'a5b2c3d4-4444-2222-8333-444455556666';
const BLOUSE = 'b5b2c3d4-0000-4000-8000-000000000001';
const COAT = 'b5b2c3d4-0000-4000-8000-000000000002';
const REFUND_ID = 'e5b2c3d4-0000-4000-8000-000000000001';
/** ブラウス 12,000 + コート 30,000 + 送料 800 */
const FULL = 42_800;
const CANCEL_BUTTON = `注文をキャンセルして ${formatYen(FULL)} を返金する`;

/** 支払い済みで、1つも発送していない。キャンセルできる */
const PAID_ROW = adminOrder({
  id: PAID_ID,
  canShip: false,
  canRefund: true,
  canCancel: true,
  cancelKind: 'paid',
  paymentStatusKey: 'paid',
  refundedAmountLabel: '-',
});
/** コンビニ払いのキャンセルを受け付けた後。返金が済むまで「キャンセルの手続き中」 */
const PENDING_ROW = adminOrder({
  id: PAID_ID,
  status: 'キャンセルの手続き中',
  progressKey: 'cancel_pending',
  canShip: false,
  canRefund: false,
  canCancel: false,
  cancelKind: null,
  paymentStatusKey: 'paid',
  refundPending: true,
  refundedAmountLabel: '-',
});
/** 返金が済んで、注文がキャンセルになった後 */
const CANCELLED_ROW = adminOrder({
  id: PAID_ID,
  status: 'キャンセル',
  orderStatus: 'cancelled',
  progressKey: 'cancelled',
  canShip: false,
  canRefund: false,
  canCancel: false,
  cancelKind: null,
  paymentStatusKey: 'refunded',
  refundedAmountLabel: formatYen(FULL),
});
/** 一部を発送した後。キャンセルできない（返金の画面を使う） */
const PARTIAL_ROW = adminOrder({
  id: PARTIAL_ID,
  items: [orderLine({ quantity: 2, shipped: 1, readyUnshipped: 1 })],
  partiallyShipped: true,
  canShip: false,
  canRefund: true,
  canCancel: false,
  cancelKind: null,
  paymentStatusKey: 'paid',
  refundedAmountLabel: '-',
});
const SHIPPED_ROW = adminOrder({
  id: SHIPPED_ID,
  items: [orderLine({ shipped: 1, readyUnshipped: 0 })],
  status: '配送中',
  orderStatus: 'shipped',
  progressKey: 'in_transit',
  canShip: false,
  canRefund: true,
  canCancel: false,
  cancelKind: null,
  paymentStatusKey: 'paid',
  refundedAmountLabel: '-',
});
/** 未入金。取り消せる（今の取消の画面） */
const UNPAID_ROW = adminOrder({
  id: UNPAID_ID,
  status: '未決済',
  orderStatus: 'pending',
  progressKey: 'unpaid',
  canShip: false,
  canRefund: false,
  canCancel: true,
  cancelKind: 'unpaid',
  paymentStatusKey: 'unpaid',
  refundedAmountLabel: '-',
});

type Phase = 'paid' | 'pending' | 'cancelled';

function rowsOf(phase: Phase): OrderItem[] {
  const first = phase === 'paid' ? PAID_ROW : phase === 'pending' ? PENDING_ROW : CANCELLED_ROW;
  return [first, PARTIAL_ROW, SHIPPED_ROW, UNPAID_ROW];
}

/** ブラウス（在庫）とコート（受注生産）が未発送。送料 800 */
function paidMaterials(paymentMethod: RefundPaymentMethod = 'card'): RefundMaterials {
  return refundMaterialsOf({
    orderId: PAID_ID,
    paymentMethod,
    shippingAmount: 800,
    lines: [
      materialLineOf({ orderItemId: BLOUSE, itemPrice: 12_000 }),
      materialLineOf({
        orderItemId: COAT, name: 'ウールコート', color: 'ブラック', size: 'L', fulfillmentType: 'backorder', itemPrice: 30_000,
      }),
    ],
  });
}

async function mockApis(page: Page, rows: () => OrderItem[], materials: RefundMaterials) {
  const state = newRefundRouteState(materials);
  await mockAdminSession(page);
  const list = await mockOrderDetail(page, (id) => adminOrderDetail(rows().find((row) => row.id === id)!));
  await mockRefundRoutes(page, PAID_ID, state);
  return { state, list };
}

const rowOf = (page: Page) => detailSection(page, '注文情報');

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-075 paid order cancel (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('キャンセルは、支払い済みで1つも発送していない注文と未入金の注文に出て、一部発送した後と発送済みの注文には出ない。支払い済みは新しい画面が開く', async ({ page }) => {
      // FREQ-449-AC-01, FREQ-449-AC-02
      await mockApis(page, () => rowsOf('paid'), paidMaterials());
      await openOrderDetail(page, PAID_ID);
      const cancelButton = () => detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル', exact: true });
      for (const [id, count] of [[PAID_ID, 1], [PARTIAL_ID, 0], [SHIPPED_ID, 0], [UNPAID_ID, 1]] as const) {
        await openOrderDetail(page, id);
        await expect(cancelButton()).toHaveCount(count);
      }
      await cancelButton().click();
      await expect(page.getByRole('dialog', { name: `注文を取り消す（注文 ${orderNumberOf(UNPAID_ID)}）`, exact: true })).toBeVisible();
      await page.getByRole('button', { name: '戻る', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await openOrderDetail(page, PAID_ID);
      await cancelButton().click();
      await expect(page.getByRole('dialog', { name: paidCancelDialogTitle(PAID_ID), exact: true })).toBeVisible();
    });

    test('サポートの人の詳細には、支払い済みの「キャンセル」と「返金」が出ず、未入金の取消は出る', async ({ page }) => {
      // FREQ-449-AC-01
      await mockAdminSessionAs(page, 'supporter');
      await mockOrderDetail(page, (id) => adminOrderDetail({ ...rowsOf('paid').find((row) => row.id === id)!, permissions: SUPPORTER_DETAIL_PERMISSIONS }));
      for (const id of [PAID_ID, SHIPPED_ID, UNPAID_ID]) {
        await openOrderDetail(page, id);
        const payment = detailSection(page, '支払いと返金');
        await expect(payment).toBeVisible();
        await expect(payment.getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(id === UNPAID_ID ? 1 : 0);
        await expect(payment.getByRole('button', { name: '返金', exact: true })).toHaveCount(0);
      }
    });

    test('全額と内訳とお金が戻る時期が出る。理由を選ぶまでは押せず、「その他」はメモも要る。在庫に戻すとお知らせは最初から入っている', async ({ page }) => {
      // FREQ-449-AC-03
      await mockApis(page, () => rowsOf('paid'), paidMaterials());
      await openOrderDetail(page, PAID_ID);
      const dialog = await openDetailPaidCancelDialog(page, PAID_ID);

      await expect(dialog.getByText(`返金する額: ${formatYen(FULL)}（全額）`)).toBeVisible();
      await expect(dialog.getByRole('list', { name: '返金の内訳', exact: true }).getByRole('listitem')).toHaveText([
        `商品 ${formatYen(42_000)}`,
        `送料 ${formatYen(800)}`,
      ]);
      await expect(dialog.getByText(TIMING_NOTES.card, { exact: true })).toBeVisible();
      await expect(dialog.getByText(REFUND_TEXT.cancelNoUndo)).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: '在庫に戻す' })).toBeChecked();
      await expect(dialog.getByRole('checkbox', { name: 'お客様にキャンセルのお知らせを送る' })).toBeChecked();

      // 理由を選ぶまでは押せない。「その他」はメモを入れるまで押せない
      const submit = dialog.getByRole('button', { name: CANCEL_BUTTON, exact: true });
      await expect(submit).toBeDisabled();
      const reason = dialog.getByRole('combobox', { name: '取消の理由', exact: true });
      await expect(reason.getByRole('option')).toHaveText([
        '選んでください', 'お客様の都合', '支払いの拒否', '不正', '在庫切れ', 'お店の誤り', 'その他',
      ]);
      await reason.selectOption('other');
      await expect(dialog.getByRole('textbox', { name: 'メモ（必須・店内のみ）', exact: true })).toBeVisible();
      await expect(submit).toBeDisabled();
      await dialog.getByRole('textbox', { name: 'メモ（必須・店内のみ）', exact: true }).fill('電話で依頼');
      await expect(submit).toBeEnabled();
      await reason.selectOption('customer_request');
      await expect(dialog.getByRole('textbox', { name: 'メモ（任意・店内のみ）', exact: true })).toBeVisible();
      await expect(submit).toBeEnabled();
      // 長い確定のボタンの字は、3つの画面幅とも切れずに全部が見える（Button の既定は折り返さず、はみ出しを隠す）
      expect(await submit.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e2/paid-cancel-dialog-${viewport.width}.png`, animations: 'disabled' });
    });

    test('受注生産の品だけの注文には「在庫に戻す」が出ない', async ({ page }) => {
      // FREQ-449-AC-03
      await mockApis(
        page,
        () => rowsOf('paid'),
        refundMaterialsOf({
          orderId: PAID_ID,
          lines: [
            materialLineOf({
              orderItemId: COAT, name: 'ウールコート', color: 'ブラック', size: 'L', fulfillmentType: 'backorder', itemPrice: 30_000,
            }),
          ],
        }),
      );
      await openOrderDetail(page, PAID_ID);
      const dialog = await openDetailPaidCancelDialog(page, PAID_ID);

      await expect(dialog.getByText(`返金する額: ${formatYen(30_000)}（全額）`)).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: '在庫に戻す' })).toHaveCount(0);
      await expect(dialog.getByRole('checkbox', { name: 'お客様にキャンセルのお知らせを送る' })).toBeChecked();
    });

    test('コンビニ払いのキャンセルは保留で受け付けられ、詳細の進み具合が「キャンセルの手続き中」になる。選びがそのまま窓口へ届く', async ({ page }) => {
      // FREQ-449-AC-03, FREQ-449-AC-04
      const phase = { current: 'paid' as Phase };
      const { state, list } = await mockApis(page, () => rowsOf(phase.current), paidMaterials('konbini'));
      state.answerStatus = async (route) => {
        phase.current = 'pending';
        await fulfillJson(route, acceptedRefund({ refundId: REFUND_ID, amount: FULL }));
      };
      await openOrderDetail(page, PAID_ID);
      const dialog = await openDetailPaidCancelDialog(page, PAID_ID);
      await expect(dialog.getByText(TIMING_NOTES.konbini, { exact: true })).toBeVisible();

      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('stock_unavailable');
      await dialog.getByRole('textbox', { name: 'メモ（任意・店内のみ）', exact: true }).fill('入荷が遅れるため');
      await dialog.getByRole('button', { name: CANCEL_BUTTON, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.statusPosts).toHaveLength(1);
      expect(state.statusPosts[0]).toMatchObject({
        status: 'cancelled',
        reason: 'stock_unavailable',
        note: '入荷が遅れるため',
        restock: true,
        notifyCustomer: true,
      });
      expect(state.statusPosts[0].requestKey).toMatch(UUID_PATTERN);
      // 受け付けた知らせと、一覧の読み直し。返金が済むまで、注文はキャンセルにならず「キャンセルの手続き中」と出る
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.cancelNoticePending })).toBeVisible();
      await expect.poll(() => list.urls.length).toBeGreaterThanOrEqual(2);
      const row = rowOf(page);
      await expect(row.getByText('キャンセルの手続き中', { exact: true })).toBeVisible();
      // 金額の一覧の見出し（dt）にも同じ文言があるので、dt 以外の印だけを数える。印が消えれば 0 件になって落ちる
      await expect(detailSection(page, '支払いと返金').getByText('返金の手続き中', { exact: true }).and(page.locator(':not(dt)'))).toHaveCount(1);
      await expect(detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(0);
      await expect(detailSection(page, '支払いと返金').getByRole('button', { name: '返金', exact: true })).toHaveCount(0);
    });

    test('カードのキャンセルは返金が済んで受け付けられ、外した選びがそのまま窓口へ届く。注文は「キャンセル」になる', async ({ page }) => {
      // FREQ-449-AC-03
      const phase = { current: 'paid' as Phase };
      const { state } = await mockApis(page, () => rowsOf(phase.current), paidMaterials());
      state.answerStatus = async (route) => {
        phase.current = 'cancelled';
        await fulfillJson(route, acceptedRefund({ refundId: REFUND_ID, amount: FULL, status: 'succeeded' }));
      };
      await openOrderDetail(page, PAID_ID);
      const dialog = await openDetailPaidCancelDialog(page, PAID_ID);

      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('customer_request');
      await dialog.getByRole('checkbox', { name: '在庫に戻す' }).uncheck();
      await dialog.getByRole('checkbox', { name: 'お客様にキャンセルのお知らせを送る' }).uncheck();
      await dialog.getByRole('button', { name: CANCEL_BUTTON, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.statusPosts).toHaveLength(1);
      expect(state.statusPosts[0]).toMatchObject({
        status: 'cancelled',
        reason: 'customer_request',
        restock: false,
        notifyCustomer: false,
      });
      // メモが空なら、窓口へは note を送らない
      expect(state.statusPosts[0]).not.toHaveProperty('note');
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.cancelNoticeSucceeded })).toBeVisible();
      const row = rowOf(page);
      await expect(row.getByText('キャンセル', { exact: true })).toBeVisible();
      await expect(detailSection(page, '支払いと返金').getByText('返金済み', { exact: true })).toBeVisible();
    });

    test('窓口が断ったら、断りの文を出して画面を開いたままにし、送り直しは新しい二重防止の番号になる', async ({ page }) => {
      // FREQ-449-AC-02
      const { state } = await mockApis(page, () => rowsOf('paid'), paidMaterials());
      let calls = 0;
      state.answerStatus = async (route) => {
        calls += 1;
        if (calls === 1) {
          // 画面を開いた後に、別の人が一部を発送した
          await refuseRefund(route, 'order_not_cancellable');
          return;
        }
        await fulfillJson(route, acceptedRefund({ amount: FULL }));
      };
      await openOrderDetail(page, PAID_ID);
      const dialog = await openDetailPaidCancelDialog(page, PAID_ID);
      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('customer_request');
      const submit = dialog.getByRole('button', { name: CANCEL_BUTTON, exact: true });

      await submit.click();
      await expect(dialog.getByRole('alert')).toHaveText(refundErrorMessage('order_not_cancellable'));
      await expect(dialog).toBeVisible();
      await expect(submit).toBeEnabled();

      await submit.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.statusPosts).toHaveLength(2);
      expect(state.statusPosts[1].requestKey).not.toBe(state.statusPosts[0].requestKey);
    });

    test('答えが分からない時は、入力を止めて「もう一度確かめる」だけを出し、同じ二重防止の番号と同じ中身で確かめ直す', async ({ page }) => {
      // FREQ-449-AC-03（Review Focus 1）
      const { state } = await mockApis(page, () => rowsOf('paid'), paidMaterials());
      // サーバーは1回目を記録していたのに、答えが「返金を頼んだか分からない」（502）だった
      state.answerStatus = async (route) => {
        await fulfillJson(
          route,
          { error: REFUND_TEXT.unknownOutcome, code: 'unknown_outcome', refundId: REFUND_ID } satisfies RefundErrorResponse,
          502,
        );
      };
      await openOrderDetail(page, PAID_ID);
      const dialog = await openDetailPaidCancelDialog(page, PAID_ID);
      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('customer_request');
      await dialog.getByRole('button', { name: CANCEL_BUTTON, exact: true }).click();

      await expect(dialog.getByRole('alert')).toHaveText(REFUND_TEXT.unknownOutcome);
      // 見出しの行の ×（768px 未満だけ見える）を除いた押せるボタン（「戻る」と「もう一度確かめる」）
      await expect(dialog.locator('button:not([disabled]):not([data-ui-dialog-close])')).toHaveCount(2);
      await expect(dialog.locator('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')).toHaveCount(0);

      state.answerStatus = async (route) => {
        await fulfillJson(route, acceptedRefund({ refundId: REFUND_ID, amount: FULL, replayed: true }));
      };
      await dialog.getByRole('button', { name: 'もう一度確かめる', exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.statusPosts).toHaveLength(2);
      expect(state.statusPosts[1]).toEqual(state.statusPosts[0]);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.cancelNoticePending })).toBeVisible();
    });

    test('支払い済みのキャンセルの画面を開いても横方向のページスクロールが発生しない。小さい画面では画面いっぱいに開く', async ({ page }) => {
      await mockApis(page, () => rowsOf('paid'), paidMaterials());
      await openOrderDetail(page, PAID_ID);
      const dialog = await openDetailPaidCancelDialog(page, PAID_ID);
      await expect(dialog.getByText(`返金する額: ${formatYen(FULL)}（全額）`)).toBeVisible();

      const box = await dialog.boundingBox();
      if (!box) throw new Error('支払い済みのキャンセルの画面の位置を取れなかった');
      if (viewport.width < 768) {
        expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
        expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);
      } else {
        expect(box.width).toBeLessThan(viewport.width);
      }
      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
