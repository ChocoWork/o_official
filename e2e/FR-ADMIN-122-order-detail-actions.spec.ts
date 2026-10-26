/**
 * G-4 Task 11 / FREQ-539・FREQ-541。①〜⑧⑩⑪は窓口を固定する画面の契約。
 * ⑨だけは固有の会員・注文・返品を作り、実際のお客様の頁とAPIを通す。
 * 管理の認可・writer・メール送信の実測は123/既存DB試験へ分担する。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { OrderHistoryEmailEntry, OrderHistoryResponse } from '@/lib/orders/email/order-history';
import type { AttentionException } from '@/lib/orders/order-payment-types';
import type { OrderReturnSummary } from '@/lib/orders/returns/return-types';
import { confirmedDetail } from '../tests/unit/lib/orders/shipment-slips/shipment-slip-fixtures';
import { dialogHeaderClose } from './admin-test-utils';
import {
  ADMIN_DETAIL_PERMISSIONS, SUPPORTER_DETAIL_PERMISSIONS, adminOrderDetail, detailSection,
  emptyOrderItemList, fulfillJson, historyOf, mockOrderDetail, mockOrderItemList,
  openOrderDetail, orderNumberOf, viewports, type OrderDetailOverrides,
} from './order-fulfillment-test-utils';
import {
  materialLineOf, mockAdminSessionAs, mockRefundRoutes, newRefundRouteState,
  openDetailPaidCancelDialog, openDetailRefundDialog, refundMaterialsOf,
} from './refund-test-utils';
import {
  createReturnInDb, createShippedOrder, mockReturnRoutes, newReturnRouteState,
  openDetailReturnsDialog, returnSummaryOf,
} from './return-test-utils';
import { openDetailCancel } from './return-request-test-utils';
import { loginCustomer, openCustomerOrder, orderDetailHistory } from './delivery-tracking-test-utils';
import { mockOrderAttention, mockOrderDetailBridge, withOrderAdminScenario } from './order-admin-test-utils';
import {
  isolateOrderStatusApiIp, openOrderStatusPage, prepareOrderStatusTestLink,
  readOrderStatusPrivate, verifyOrderStatusInPage,
} from './order-status-test-utils';
import { DEFAULT_SHIP_TO, expectNoPageOverflow } from './shipping-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ timeout: 180_000 });

const ORDER_ID = 'a1220000-1111-4222-8333-444455556666';
const SLIP_ID = 'c1220000-1111-4222-8333-444455556666';
const NUMBER = orderNumberOf(ORDER_ID);
const SLIP_NUMBER = 'SL-20261025-0122';
const REGIONS = ['注文情報', '支払いと返金', '品物', '発送', '返品とキャンセルの申し込み', '要対応', '変更履歴'];

async function mockDetail(page: Page, overrides: Partial<OrderDetailOverrides> = {}, role: 'admin' | 'supporter' = 'admin') {
  await mockAdminSessionAs(page, role);
  const current = adminOrderDetail({
    id: ORDER_ID, canRefund: true, canCancel: true, cancelKind: 'paid', paymentStatusKey: 'paid',
    returnSummary: returnSummaryOf({ orderId: ORDER_ID }), cancelRequestOpen: true,
    permissions: role === 'admin' ? ADMIN_DETAIL_PERMISSIONS : SUPPORTER_DETAIL_PERMISSIONS,
    ...overrides,
  });
  const reads = await mockOrderDetail(page, () => current);
  const refund = newRefundRouteState(refundMaterialsOf({ orderId: ORDER_ID, lines: [materialLineOf({ orderItemId: 'b1220000-1111-4222-8333-444455556666' })] }));
  await mockRefundRoutes(page, ORDER_ID, refund);
  await mockReturnRoutes(page, ORDER_ID, newReturnRouteState({ orderId: ORDER_ID, canRefund: role === 'admin' }));
  await page.route(`**/api/admin/orders/${ORDER_ID}/cancel-requests`, (route) => fulfillJson(route, {
    data: { cancelRequests: [], orderStatus: current.order.status, shippedUnits: 0, unshippedUnits: 1 },
  }));
  return { current, reads, refund };
}

async function closeWithBack(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const EMAIL: OrderHistoryEmailEntry = {
  type: 'email', at: '2026-10-25T01:00:00Z', emailId: 'e1220000-1111-4222-8333-444455556666',
  kind: 'paid', kindLabel: '注文確認', manual: false, requestedByEmail: null, stateLabel: '送信済み',
  warning: false, attempts: 1, errorLabel: null, sentAt: '2026-10-25T01:00:00Z', deliveryEventAt: null,
  canViewContent: true, bodyErased: false, resendable: true, fulfillmentId: null, fulfillmentNumber: null,
};

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-122 order detail actions (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize(viewport); });

    test('詳細は注文情報・支払いと返金・品物・発送・返品とキャンセルの申し込み・要対応・変更履歴の7つの欄をこの順に出す', async ({ page }) => {
      // FREQ-539-AC-01
      await mockDetail(page);
      await openOrderDetail(page, ORDER_ID);
      await orderDetailHistory(page);
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(REGIONS);
      for (const name of REGIONS) await expect(detailSection(page, name)).toHaveCount(1);
    });

    test('返金・キャンセル〔未入金の取消／支払い済み〕・返品・キャンセルの申し込みの入口が詳細にあり、サポーターの旗では返金と支払い済みのキャンセルと「額を決めて返金する」が出ず、受け取る/返品・未入金の取消・キャンセルの申し込みは出る（旧 091 ②）', async ({ page }) => {
      // FREQ-539-AC-02、FREQ-468-AC-02（091②の全8組を保持）
      const summaries: Array<{ value: Partial<OrderReturnSummary>; admin: string | null; supporter: string | null }> = [
        { value: { displayStatus: 'requested', nextAction: 'review_request', requestedReturns: 1, hasReturnable: false }, admin: '申し込みを確かめる', supporter: '申し込みを確かめる' },
        { value: { displayStatus: 'in_progress', marks: ['awaiting_items'], nextAction: 'receive', hasReturnable: false }, admin: '受け取る', supporter: '受け取る' },
        { value: { displayStatus: 'in_progress', marks: ['partially_received', 'awaiting_fee'], nextAction: 'receive', hasReturnable: false }, admin: '受け取る', supporter: '受け取る' },
        { value: { displayStatus: 'in_progress', marks: ['pending_inspection'], nextAction: 'none', hasReturnable: false }, admin: '返品', supporter: '返品' },
        { value: { displayStatus: 'refund_waiting', nextAction: 'refund', refundWaitingReturns: 1, hasReturnable: false }, admin: '額を決めて返金する', supporter: '返品' },
        { value: { displayStatus: 'returned', nextAction: 'none', hasReturnable: false }, admin: '返品', supporter: '返品' },
        { value: { displayStatus: null, nextAction: 'none', hasReturnable: true }, admin: '返品', supporter: '返品' },
        { value: { displayStatus: null, nextAction: 'none', hasReturnable: false }, admin: null, supporter: null },
      ];
      for (const role of ['admin', 'supporter'] as const) {
        const { current } = await mockDetail(page, {}, role);
        await openOrderDetail(page, ORDER_ID);
        const payment = detailSection(page, '支払いと返金');
        await expect(payment.getByRole('button', { name: '返金', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
        await expect(payment.getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
        if (role === 'admin') {
          await closeWithBack(page, await openDetailRefundDialog(page, ORDER_ID));
          await closeWithBack(page, await openDetailPaidCancelDialog(page, ORDER_ID));
        }
        for (const entry of summaries) {
          current.summary.returnSummary = returnSummaryOf({ orderId: ORDER_ID, ...entry.value });
          await openOrderDetail(page, ORDER_ID);
          const requests = detailSection(page, '返品とキャンセルの申し込み');
          for (const name of ['返品', '受け取る', '額を決めて返金する', '申し込みを確かめる']) {
            await expect(requests.getByRole('button', { name, exact: true })).toHaveCount(name === entry[role] ? 1 : 0);
          }
        }
        current.summary.returnSummary = returnSummaryOf({ orderId: ORDER_ID });
        await openOrderDetail(page, ORDER_ID);
        const returns = await openDetailReturnsDialog(page, ORDER_ID);
        await returns.getByRole('button', { name: '閉じる', exact: true }).last().click();
        await expect(returns).toHaveCount(0);
        const cancelRequest = await openDetailCancel(page, ORDER_ID);
        await cancelRequest.getByRole('button', { name: '閉じる', exact: true }).last().click();
        await expect(cancelRequest).toHaveCount(0);
        current.summary.cancelKind = 'unpaid';
        current.summary.canRefund = false;
        current.summary.status = '未決済';
        current.order.status = 'pending';
        await openOrderDetail(page, ORDER_ID);
        await payment.getByRole('button', { name: 'キャンセル', exact: true }).click();
        await closeWithBack(page, page.getByRole('dialog', { name: `注文を取り消す（注文 ${NUMBER}）`, exact: true }));
      }
    });

    test('J-12: 取消の画面の見出しに注文番号、返金・支払い済みのキャンセルの見出しに注文番号〔名前は出ない〕。390pxでは画面いっぱいに開き右上の×で何も送らずに閉じる', async ({ page }) => {
      // FREQ-539-AC-03、FREQ-510-AC-01〜04。未入金は見出し、全画面は107と同じ返金/支払い済み取消。
      const { current, refund } = await mockDetail(page);
      let unpaidPosts = 0;
      await page.route(`**/api/admin/orders/${ORDER_ID}/status`, (route) => { unpaidPosts++; return fulfillJson(route, {}); });
      for (const kind of ['refund', 'paid', 'unpaid'] as const) {
        if (kind === 'unpaid') { current.summary.cancelKind = 'unpaid'; current.summary.status = '未決済'; }
        await openOrderDetail(page, ORDER_ID);
        const dialog = kind === 'refund' ? await openDetailRefundDialog(page, ORDER_ID)
          : kind === 'paid' ? await openDetailPaidCancelDialog(page, ORDER_ID)
            : page.getByRole('dialog', { name: `注文を取り消す（注文 ${NUMBER}）`, exact: true });
        if (kind === 'unpaid') await detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル', exact: true }).click();
        await expect(dialog.getByRole('heading', { name: /注文 ORD-/ })).toContainText(NUMBER);
        await expect(dialog.getByRole('heading', { name: /注文 ORD-/ })).not.toContainText(current.order.customerName!);
        if (viewport.width === 390 && kind !== 'unpaid') {
          const box = await dialog.boundingBox();
          if (!box) throw new Error('確認画面の位置を読めない');
          expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
          expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);
          const close = dialogHeaderClose(dialog);
          await expect(close).toBeVisible();
          const cross = await close.boundingBox();
          if (!cross) throw new Error('閉じるボタンの位置を読めない');
          expect(cross.x).toBeGreaterThan(viewport.width / 2);
          expect(cross.y).toBeLessThan(80);
          await close.click();
          await expect(dialog).toHaveCount(0);
        } else await closeWithBack(page, dialog);
      }
      // unpaidPosts は後から登録した /status の窓口が数える（全部の status の送信）。返金の送信と合わせて何も送っていない
      expect(refund.refundPosts).toEqual([]);
      expect(unpaidPosts).toBe(0);
    });

    test('操作の後は詳細を読み直し、読み直しに失敗したら「最新の状態を読み込めませんでした。」と「この画面の内容は最新ではありません。」を出して成功の知らせを出さない。「読み込み直す」で直る', async ({ page }) => {
      // FREQ-539-AC-03。成功応答を受けても、読取失敗を成功の知らせで覆わない。
      const { current } = await mockDetail(page, { attention: { review: { reason: 'stock_not_reserved', markedAt: null } } });
      let fail = false;
      let reads = 0;
      let posts = 0;
      let historyReads = 0;
      await page.route(`**/api/admin/orders/${ORDER_ID}`, (route) => {
        reads++;
        return fulfillJson(route, fail ? { error: '読取に失敗しました。' } : { data: current }, fail ? 500 : 200);
      });
      await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) => {
        historyReads++;
        return fulfillJson(route, historyOf(ORDER_ID, []));
      });
      await page.route(`**/api/admin/orders/${ORDER_ID}/review`, (route) => {
        posts++; current.attention.review = null; fail = true;
        return fulfillJson(route, { success: true });
      });
      await openOrderDetail(page, ORDER_ID);
      await orderDetailHistory(page);
      const before = { reads, historyReads };
      await detailSection(page, '要対応').getByRole('button', { name: '確認済みにする', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '最新の状態を読み込めませんでした。' })).toBeVisible();
      await expect(page.getByText('この画面の内容は最新ではありません。', { exact: true })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: '確認済みにしました。' })).toHaveCount(0);
      expect(reads).toBeGreaterThan(before.reads);
      expect(posts).toBe(1);
      fail = false;
      await page.getByRole('button', { name: '読み込み直す', exact: true }).click();
      await expect(page.getByText('この画面の内容は最新ではありません。', { exact: true })).toHaveCount(0);
      await expect(detailSection(page, '要対応').getByText('要対応はありません。', { exact: true })).toBeVisible();
      await orderDetailHistory(page);
      expect(historyReads).toBeGreaterThan(before.historyReads);
    });

    test('履歴: 品物の状態の変化〔変更前後・理由・人または自動・発送票への参照〕とメールの再送が詳細の中で使える', async ({ page }) => {
      // FREQ-539-AC-04。品物の状態履歴と再送は同じ埋め込み欄。
      await mockDetail(page);
      let resent = false;
      const bodies: unknown[] = [];
      const history = (): OrderHistoryResponse => ({
        ...historyOf(ORDER_ID, [
          ...(resent ? [{ ...EMAIL, emailId: 'e1220001-1111-4222-8333-444455556666', manual: true, requestedByEmail: 'admin@example.com', stateLabel: '送信待ち', resendable: false }] : []),
          { ...EMAIL, resendable: !resent },
        ]),
        itemStates: [
          { id: 'state-1', at: '2026-10-25T02:00:00Z', orderItemId: 'item-1', itemName: 'シルクブラウス', quantity: 2, from: 'ready', to: 'shipped', reason: 'shipment_slip_confirm', reasonLabel: '発送の確定', actorEmail: 'admin@example.com', automatic: false, ref: { kind: 'shipment_slip', id: SLIP_ID, label: SLIP_NUMBER }, swap: null },
          { id: 'state-2', at: '2026-10-25T01:00:00Z', orderItemId: 'item-1', itemName: 'シルクブラウス', quantity: 2, from: 'in_production', to: 'ready', reason: 'fifo', reasonLabel: '古い注文から順の自動割当', actorEmail: null, automatic: true, ref: null, swap: null },
        ], itemStatesTruncated: false,
      });
      await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) => fulfillJson(route, history()));
      await page.route(`**/api/admin/orders/${ORDER_ID}/emails/resend`, (route) => {
        bodies.push(route.request().postDataJSON()); resent = true;
        return fulfillJson(route, { success: true, emailId: 'e1220001-1111-4222-8333-444455556666' });
      });
      await openOrderDetail(page, ORDER_ID);
      const panel = await orderDetailHistory(page);
      const changes = panel.getByRole('listitem').filter({ hasText: 'シルクブラウス2点' });
      await expect(changes).toHaveCount(2);
      await expect(changes.nth(0)).toContainText('発送準備中 → 発送済み（発送の確定／admin@example.com）');
      await expect(changes.nth(1)).toContainText('受注生産中 → 発送準備中（古い注文から順の自動割当／自動）');
      await expect(changes.nth(0).getByRole('link', { name: `発送票 ${SLIP_NUMBER}`, exact: true })).toHaveAttribute('href', `/admin/shipment-slips/${SLIP_ID}`);
      await panel.getByRole('button', { name: 'お客様へ再送', exact: true }).click();
      await expect(panel.getByText('注文確認のメールを、お客様（注文のメールアドレス）へもう一度送ります', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '再送する', exact: true }).click();
      await expect(panel.getByText('手で再送（admin@example.com）', { exact: true })).toBeVisible();
      expect(bodies).toEqual([{ kind: 'paid' }]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('要対応: 要確認の印と「確認済みにする」〔manage の旗がある時だけ〕、支払い・配送の要対応の言葉、「要対応の一覧で対応する」で /admin/orders#attention へ移る（旧 061 ①）', async ({ page }) => {
      // FREQ-539-AC-04、FREQ-412-AC-01（旧061①）。manage=falseの時も印は残る。
      const { current, reads } = await mockDetail(page, { attention: {
        review: { reason: 'stock_not_reserved', markedAt: null },
        paymentExceptions: [{ id: 'exception-1', reason: 'refund_failed', detectionCount: 2, firstDetectedAt: '2026-10-25T00:00:00Z' }],
        deliveries: [{ fulfillmentId: 'fulfillment-1', kind: 'attempted_delivery', openedAt: '2026-10-25T00:00:00Z' }],
      } });
      let posts = 0;
      await page.route(`**/api/admin/orders/${ORDER_ID}/review`, (route) => {
        posts++; current.attention.review = null;
        return fulfillJson(route, { success: true });
      });
      current.permissions.manage = false;
      await openOrderDetail(page, ORDER_ID);
      const attention = detailSection(page, '要対応');
      await expect(attention.getByRole('heading', { name: '要確認', exact: true })).toBeVisible();
      await expect(attention.getByRole('button', { name: '確認済みにする', exact: true })).toHaveCount(0);
      current.permissions.manage = true;
      await openOrderDetail(page, ORDER_ID);
      await expect(attention.getByText('在庫を確保できなかった注文', { exact: true })).toBeVisible();
      await expect(attention.getByText('返金の失敗（検知 2回）', { exact: true })).toBeVisible();
      await expect(attention.getByText('不在で持ち帰り', { exact: true })).toBeVisible();
      const before = reads.urls.length;
      await attention.getByRole('button', { name: '確認済みにする', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '確認済みにしました。' })).toBeVisible();
      await expect(attention.getByRole('heading', { name: '要確認', exact: true })).toHaveCount(0);
      expect(posts).toBe(1);
      expect(reads.urls.length).toBeGreaterThan(before);
      await mockOrderItemList(page, emptyOrderItemList);
      await mockOrderAttention(page);
      const link = attention.getByRole('link', { name: '要対応の一覧で対応する', exact: true });
      await expect(link).toHaveAttribute('href', '/admin/orders#attention');
      await link.click();
      await expect(page).toHaveURL(/\/admin\/orders#attention$/);
      await expect(page.getByRole('heading', { name: '注文一覧表', exact: true })).toBeVisible();
    });

    test('発送: 既存の発送票へのリンク〔票の頁が開く〕と注文別の発送、発送の操作〔発送・伝票訂正・手の配達済み〕が詳細に無い。同梱の注意文', async ({ page }) => {
      // FREQ-539-AC-05（発送の欄）。mockは実際の票の頁が読める形で返す。
      const slip = confirmedDetail({ id: SLIP_ID, number: SLIP_NUMBER });
      await mockDetail(page, {
        fulfillments: [{ id: 'd1220000-1111-4222-8333-444455556666', number: 1, shippedAt: '2026-10-25T04:00:00Z', deliveredAt: null, cancelledAt: null, carrier: 'yamato', trackingNumber: '1234-5678', slipId: SLIP_ID, slipNumber: SLIP_NUMBER }],
        slips: [{ slipId: SLIP_ID, number: SLIP_NUMBER, stage: 'confirmed' }],
      });
      await page.route(`**/api/admin/shipment-slips/${SLIP_ID}`, (route) => fulfillJson(route, { slip, canCorrectDate: false }));
      await openOrderDetail(page, ORDER_ID);
      const shipping = detailSection(page, '発送');
      await expect(shipping.getByRole('heading', { name: '1回目の発送', exact: true })).toBeVisible();
      await expect(shipping.getByText(/1234-5678/)).toBeVisible();
      await expect(shipping.getByText('同梱された発送票の配送の要対応は、代表の注文にだけ表示されます。詳しくは発送票を開いてください。', { exact: true })).toBeVisible();
      await expect(shipping.getByRole('link', { name: '荷作り表を開く', exact: true })).toHaveAttribute('href', '/admin/packing');
      for (const name of ['発送', '発送済みにする', '伝票番号を直す', '配達済みにする']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      const link = shipping.getByRole('link', { name: `発送票 ${SLIP_NUMBER}`, exact: true });
      await expect(link).toHaveAttribute('href', `/admin/shipment-slips/${SLIP_ID}`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/admin/shipment-slips/${SLIP_ID}$`));
      await expect(page.getByRole('heading', { name: `発送票 ${SLIP_NUMBER}`, exact: true })).toBeVisible();
    });

    test('要対応の欄の「もう一度返金する」は /admin/orders/{id}?open=refund へ移り返金の画面が開く。返品の返金は ?open=returns', async ({ page }) => {
      // FREQ-539-AC-02・04。通常返金と返品返金を別のopen値へ結ぶ。
      await mockDetail(page);
      await mockOrderItemList(page, emptyOrderItemList);
      for (const isReturn of [false, true]) {
        const exception = {
          id: 'f1220000-1111-4222-8333-444455556666', reason: 'refund_failed', reasonLabel: '返金の失敗', detail: null,
          orderId: ORDER_ID, orderNumber: NUMBER, orderStatus: 'paid', paymentRef: 're_e2e122',
          firstDetectedAt: '2026-10-25T00:00:00Z', lastDetectedAt: '2026-10-25T00:00:00Z', detectionCount: 1,
          canCancelOrder: false, canRetryRefund: true,
          refundFailure: { amount: 5000, failureReasonLabel: '失敗', shortages: [], ...(isReturn ? { returnId: 'b1220000-1111-4222-8333-444455556666' } : {}) },
        } satisfies AttentionException;
        await mockOrderAttention(page, { exceptions: [exception] });
        await page.goto('/admin/orders');
        // 「もう一度返金する」は href の無いボタン。押すと router.push で詳細頁へ移る。詳細頁は開いた直後に ?open= を消すので、押す前に遷移を待ち受ける
        const opened = page.waitForURL(new RegExp(`/admin/orders/${ORDER_ID}\\?open=${isReturn ? 'returns' : 'refund'}$`), { waitUntil: 'commit' });
        await page.getByRole('button', { name: 'もう一度返金する', exact: true }).click();
        await opened;
        await expect(page.getByRole('dialog', { name: isReturn ? `返品（${NUMBER}）` : `返金（注文 ${NUMBER}）`, exact: true })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/admin/orders/${ORDER_ID}$`));
      }
    });

    test('E-5 の回帰: お客様の注文画面・注文状況の頁の言葉と公開範囲が変わらない〔110 ⑥ と同じ入り方で、同じ注文が管理の詳細で返品受付中でも客向けの画面に管理の言葉が出ない〕', async ({ page, browser }) => {
      // FREQ-541-AC-05。110⑥と同じ実際のリンク→電話下4桁。会員の注文の頁も同じ注文で確かめる。
      test.setTimeout(240_000);
      await withOrderAdminScenario(async (ctx) => {
        const member = await loginCustomer(page, 'g4-detail-122');
        const fx = await createShippedOrder(ctx.client, 'g4-detail-122', [{ name: 'E2E詳細回帰', quantity: 2, fulfillmentType: 'stock' }], { userId: member.userId, email: member.email });
        await createReturnInDb(ctx.client, fx, { lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }], notify: false });
        const token = await prepareOrderStatusTestLink(ctx.client, fx.orderId);
        const adminPage = await page.context().newPage();
        try {
          await mockAdminSessionAs(adminPage, 'admin');
          await mockOrderDetailBridge(adminPage, ctx.client, ctx.actorId, { id: fx.orderId, status: '配送中', orderStatus: 'shipped', returnSummary: returnSummaryOf({ orderId: fx.orderId, displayStatus: 'in_progress' }) });
          await openOrderDetail(adminPage, fx.orderId);
          await expect(detailSection(adminPage, '品物').getByText('返品受付中', { exact: true })).toBeVisible();
          await expect((await orderDetailHistory(adminPage)).getByRole('listitem').filter({ hasText: '返品の作成' }).first()).toBeVisible();
          // 詳細と履歴の描画後だけ同じ接続を読む。1SQLの同一時点で対象明細の数量を確かめる。
          const facts = (await ctx.client.query(`select status, sum(unit_to-unit_from)::int quantity from private.group_g_item_state_ranges(array[$1::uuid]) group by status order by status`, [fx.orderId])).rows;
          expect(facts).toEqual([{ status: 'return_in_progress', quantity: 1 }, { status: 'shipped', quantity: 1 }]);
        } finally { await adminPage.close(); }
        const forbidden = ['返品受付中', 'キャンセル申請中', '支払い期限切れ', '割当の入替', '要対応の一覧で対応する'];
        await openCustomerOrder(page, fx.orderId);
        await expect(page.getByTestId('order-return-status')).toHaveText('返品の受付済み');
        let body = await page.locator('body').innerText();
        for (const word of forbidden) expect(body.includes(word), `会員の頁に管理の言葉が無い: ${word}`).toBe(false);
        const anonymous = await browser.newContext({ viewport });
        try {
          const statusPage = await anonymous.newPage();
          await isolateOrderStatusApiIp(statusPage);
          expect(await openOrderStatusPage(statusPage, token)).toBe(200);
          await expect(statusPage.getByRole('heading', { name: 'ご注文の状況', exact: true })).toBeVisible();
          await expect(statusPage.getByRole('heading', { name: 'お届け先', exact: true })).toHaveCount(0);
          // 返品の状況はリンクだけで見える公開の範囲（FREQ-498-AC-03）。確かめる前の頁にも管理の言葉は出ない
          await expect(statusPage.getByTestId('order-return-status')).toHaveText('返品の受付済み');
          body = await statusPage.locator('body').innerText();
          for (const word of forbidden) expect(body.includes(word), `確かめる前の注文状況の頁に管理の言葉が無い: ${word}`).toBe(false);
          const locked = await readOrderStatusPrivate(statusPage, token);
          expect(locked.status).toBe(200);
          expect(locked.body.access).toBe('none');
          expect(Object.keys(locked.body).sort()).toEqual(['access', 'reason', 'verifiable']);
          await verifyOrderStatusInPage(statusPage, DEFAULT_SHIP_TO.phone.slice(-4));
          await expect(statusPage.getByTestId('order-return-status')).toHaveText('返品の受付済み');
          const unlocked = await readOrderStatusPrivate(statusPage, token);
          expect(unlocked.status).toBe(200);
          expect(unlocked.body.access).toBe('verified');
          body = await statusPage.locator('body').innerText();
          for (const word of forbidden) expect(body.includes(word), `注文状況の頁に管理の言葉が無い: ${word}`).toBe(false);
          await expectNoPageOverflow(statusPage);
        } finally { await anonymous.close(); }
      }, { returnSettings: true });
    });

    test('ORDER タブは注文一覧表への入口だけ。旧い一覧・各 dialog の入口・旧CSVは出ない', async ({ page }) => {
      // FREQ-539-AC-05。旧一覧と旧dialog/CSVの入口を出さず、旧APIも読まない。
      await mockAdminSessionAs(page, 'admin');
      const legacy: string[] = [];
      await page.route((url) => url.pathname === '/api/admin/orders', (route) => { legacy.push('old-list'); return fulfillJson(route, {}, 404); });
      await page.goto('/admin?tab=ORDER');
      const menu = page.getByRole('navigation', { name: '注文メニュー', exact: true });
      await expect(menu.getByRole('link')).toHaveCount(1);
      await expect(menu.getByRole('link', { name: '注文一覧表', exact: true })).toHaveAttribute('href', '/admin/orders');
      await expect(page.getByRole('table')).toHaveCount(0);
      for (const name of ['返金', 'キャンセル', '返品', '履歴', 'CSV出力', '発送済みにする']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(legacy).toEqual([]);
    });

    test('頁全体が横にはみ出さず、表は見出しを保ったスクロール領域に収まる', async ({ page }) => {
      // FREQ-539-AC-01・03。表だけがスクロールし、見出しが残る。
      const { current } = await mockDetail(page);
      const row = current.rows[0];
      current.rows = Array.from({ length: 30 }, (_, i) => ({ ...row, orderItemId: `line-${i}`, itemName: `長い商品名のシルクブラウス ${i}` }));
      await openOrderDetail(page, ORDER_ID);
      await orderDetailHistory(page);
      const region = page.getByRole('region', { name: `${NUMBER} 明細の表`, exact: true });
      await expect(region).toHaveAttribute('tabindex', '0');
      await expect(region).toHaveCSS('overflow-x', 'auto');
      await expect(region.getByRole('rowgroup').first()).toHaveCSS('position', 'sticky');
      await expect(region.getByRole('rowgroup').first()).toHaveCSS('top', '0px');
      await expect(region.getByRole('columnheader')).toHaveText(['商品名', '色', 'サイズ', 'ステータス', '数量', '単価', '合計金額', '返金額', '補足']);
      await region.evaluate((node) => { node.scrollLeft = node.scrollWidth; node.scrollTop = node.scrollHeight; });
      await expect(region.getByRole('columnheader', { name: '補足', exact: true })).toBeVisible();
      await expectNoPageOverflow(page);
    });
  });
}
