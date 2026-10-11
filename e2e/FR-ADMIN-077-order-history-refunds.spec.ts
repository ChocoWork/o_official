/**
 * FR-ADMIN-077 注文の履歴の返金の行
 * 対応 FREQ: FREQ-447（AC-01〜AC-03）・FREQ-459（AC-01・AC-02。確保し直しの行も画面で確かめるが、FREQ-459-AC-03 は受け付け基準の表で DB 結合・単体の基準）
 *
 * 履歴の画面は窓口を差し替えて確かめる（実装計画 P16）。窓口の答えは共通の約束（C-2）の形。
 * 返金を数える決まり（受け取った額を超える返金は断る・エラーと失敗の返金は返せる額に数えない。AC-02・AC-03）は、
 * 手元の DB の関数を直に呼んで確かめる。履歴の画面は、目で見るために3つの画面幅の写しを test-results/group-e2/ に残す。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import type {
  OrderHistoryEmailEntry,
  OrderHistoryRefundEntry,
  OrderHistoryRefundRereserveEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
import {
  beginRefund,
  createActor,
  createOrderWithLines,
  expectDbError,
  markRefundError,
  recordRefundResult,
  refundLineRows,
  refundableAmountOf,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder,
  fulfillJson,
  historyOf,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';
import { formatJst, formatYen } from './refund-test-utils';

const ORDER_ID = 'a7b2c3d4-1111-2222-8333-444455556666';
const BLOUSE_NAME = 'シルクブラウス（ホワイト / M）';
const COAT_NAME = 'ウールコート（ブラック / L）';

/** 管理画面からの返金。返事待ち → 保留 → 成功と進み、ブラウス1つを在庫に戻した。照会番号つき */
const ADMIN_REFUND = {
  type: 'refund',
  at: '2026-10-11T01:00:00.000Z',
  refundId: 'e7b2c3d4-0000-4000-8000-000000000001',
  source: 'admin',
  sourceLabel: '管理画面',
  actorEmail: 'admin@example.com',
  amount: 12_800,
  shippingAmount: 800,
  items: [{ name: BLOUSE_NAME, quantity: 1, beforeShipment: true, restockedQuantity: 1 }],
  steps: [
    { status: 'awaiting_response', label: '返事待ち', at: '2026-10-11T01:00:00.000Z' },
    { status: 'pending', label: '保留', at: '2026-10-11T01:00:02.000Z' },
    { status: 'succeeded', label: '成功', at: '2026-10-16T05:30:00.000Z' },
  ],
  failureReasonLabel: null,
  referenceNumber: '123456789012',
  customerActionExpiresAt: null,
  note: '色違いで再注文',
  stripeReasonLabel: 'お客様の希望',
  cancelReasonLabel: null,
} satisfies OrderHistoryRefundEntry;

/** 支払い済みの注文のキャンセル。コンビニ払いで、口座の入力の期限が過ぎて失敗した。ブラウスは在庫に戻し、コートは受注生産で戻らない */
const CANCEL_REFUND = {
  type: 'refund',
  at: '2026-10-12T02:00:00.000Z',
  refundId: 'e7b2c3d4-0000-4000-8000-000000000002',
  source: 'order_cancel',
  sourceLabel: '注文のキャンセル',
  actorEmail: 'admin@example.com',
  amount: 42_800,
  shippingAmount: 800,
  items: [
    { name: BLOUSE_NAME, quantity: 1, beforeShipment: true, restockedQuantity: 1 },
    { name: COAT_NAME, quantity: 1, beforeShipment: true, restockedQuantity: 0 },
  ],
  steps: [
    { status: 'awaiting_response', label: '返事待ち', at: '2026-10-12T02:00:00.000Z' },
    { status: 'pending', label: '保留', at: '2026-10-12T02:00:03.000Z' },
    { status: 'failed', label: '失敗', at: '2026-11-26T15:00:00.000Z' },
  ],
  failureReasonLabel: '口座の入力の期限が過ぎました',
  referenceNumber: null,
  customerActionExpiresAt: '2026-11-25T14:59:59.000Z',
  note: '入荷が遅れるため',
  stripeReasonLabel: null,
  cancelReasonLabel: '在庫切れ',
} satisfies OrderHistoryRefundEntry;

/** 店が Stripe の画面で返した返金。商品の行は未発送の全部 */
const DASHBOARD_REFUND = {
  type: 'refund',
  at: '2026-10-13T03:00:00.000Z',
  refundId: 'e7b2c3d4-0000-4000-8000-000000000003',
  source: 'stripe_dashboard',
  sourceLabel: 'Stripe の画面',
  actorEmail: null,
  amount: 15_000,
  shippingAmount: 0,
  items: [
    { name: 'E2Eシャツ（ホワイト / M）', quantity: 1, beforeShipment: true, restockedQuantity: 1 },
    { name: 'E2Eスカート（ホワイト / M）', quantity: 1, beforeShipment: true, restockedQuantity: 1 },
  ],
  steps: [
    { status: 'awaiting_response', label: '返事待ち', at: '2026-10-13T03:00:00.000Z' },
    { status: 'succeeded', label: '成功', at: '2026-10-13T03:00:00.000Z' },
  ],
  failureReasonLabel: null,
  referenceNumber: null,
  customerActionExpiresAt: null,
  note: null,
  stripeReasonLabel: null,
  cancelReasonLabel: null,
} satisfies OrderHistoryRefundEntry;

/** 取り消した注文に入金が届き、自動で全額を返した返金。商品の行は無い */
const AUTO_REFUND = {
  type: 'refund',
  at: '2026-10-14T04:00:00.000Z',
  refundId: 'e7b2c3d4-0000-4000-8000-000000000004',
  source: 'auto_cancelled_order_payment',
  sourceLabel: '自動の返金（取り消した注文への入金）',
  actorEmail: null,
  amount: 89_000,
  shippingAmount: 0,
  items: [],
  steps: [
    { status: 'awaiting_response', label: '返事待ち', at: '2026-10-14T04:00:00.000Z' },
    { status: 'succeeded', label: '成功', at: '2026-10-14T04:00:02.000Z' },
  ],
  failureReasonLabel: null,
  referenceNumber: null,
  customerActionExpiresAt: null,
  note: null,
  stripeReasonLabel: null,
  cancelReasonLabel: null,
} satisfies OrderHistoryRefundEntry;

/** 切り替えの前に Stripe で作られた返金の写し */
const LEGACY_REFUND = {
  type: 'refund',
  at: '2026-10-09T05:00:00.000Z',
  refundId: 'e7b2c3d4-0000-4000-8000-000000000005',
  source: 'legacy',
  sourceLabel: '前からの写し',
  actorEmail: null,
  amount: 3_000,
  shippingAmount: 0,
  items: [],
  steps: [{ status: 'succeeded', label: '成功', at: '2026-10-09T05:00:00.000Z' }],
  failureReasonLabel: null,
  referenceNumber: null,
  customerActionExpiresAt: null,
  note: null,
  stripeReasonLabel: null,
  cancelReasonLabel: null,
} satisfies OrderHistoryRefundEntry;

/** 失敗した返金の確保し直し。ブラウスは1つ確保し直せたが1つ足りず、コートは2つ確保し直せた */
const REFUND_RERESERVE = {
  type: 'refund_rereserve',
  at: '2026-11-26T15:00:05.000Z',
  refundId: CANCEL_REFUND.refundId,
  items: [
    { name: BLOUSE_NAME, quantity: 1, shortage: 1 },
    { name: COAT_NAME, quantity: 2, shortage: 0 },
  ],
} satisfies OrderHistoryRefundRereserveEntry;

const REFUND_MAIL = {
  type: 'email',
  at: '2026-10-11T01:00:03.000Z',
  emailId: 'f7b2c3d4-0000-4000-8000-000000000001',
  kind: 'refund',
  kindLabel: '返金のお知らせ',
  manual: false,
  requestedByEmail: null,
  stateLabel: '配達済み',
  warning: false,
  attempts: 1,
  errorLabel: null,
  sentAt: '2026-10-11T01:00:05.000Z',
  deliveryEventAt: '2026-10-11T01:01:00.000Z',
  canViewContent: true,
  bodyErased: false,
  resendable: false,
  fulfillmentId: null,
  fulfillmentNumber: null,
} satisfies OrderHistoryEmailEntry;

/** 新しい順 */
const ENTRIES: OrderHistoryResponse['entries'] = [
  REFUND_RERESERVE,
  CANCEL_REFUND,
  AUTO_REFUND,
  DASHBOARD_REFUND,
  ADMIN_REFUND,
  REFUND_MAIL,
  LEGACY_REFUND,
  { type: 'created', at: '2026-10-08T00:59:00.000Z' },
];

async function openHistory(page: Page): Promise<Locator> {
  await mockAdminSession(page);
  await mockOrderList(page, () => [adminOrder({ id: ORDER_ID, canShip: false })]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) => fulfillJson(route, historyOf(ORDER_ID, ENTRIES)));
  await openOrderTab(page);
  await page.getByRole('button', { name: `${orderNumberOf(ORDER_ID)} の履歴` }).click();
  const dialog = page.getByRole('dialog', { name: 'この注文の履歴', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('listitem').filter({ hasText: `返金 ${formatYen(12_800)}` })).toHaveCount(1);
  return dialog;
}

const entryOf = (dialog: Locator, amount: number) => dialog.getByRole('listitem').filter({ hasText: `返金 ${formatYen(amount)}` });

/** 状態の移り変わり。「返事待ち（日時） → 保留（日時） → 成功（日時）」 */
function stepsText(entry: OrderHistoryRefundEntry): string {
  return entry.steps.map((step) => `${step.label}（${formatJst(step.at)}）`).join(' → ');
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-077 order history refunds (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('返金の行に、額・どこから・状態の移り変わり・送料・商品・在庫に戻した数・照会番号・理由・メモ・操作した人が出る。ボタンは無い', async ({ page }) => {
      // FREQ-447-AC-01, FREQ-459-AC-01
      const dialog = await openHistory(page);
      const entry = entryOf(dialog, 12_800);

      await expect(entry).toContainText('管理画面');
      await expect(entry).toContainText(stepsText(ADMIN_REFUND));
      await expect(entry).toContainText(`送料 ${formatYen(800)}`);
      await expect(entry).toContainText(`商品: ${BLOUSE_NAME} × 1`);
      await expect(entry).toContainText('在庫に戻した数: 1');
      await expect(entry).toContainText('照会番号: 123456789012');
      await expect(entry).toContainText('Stripe に伝えた理由: お客様の希望');
      await expect(entry).toContainText('メモ: 色違いで再注文');
      await expect(entry).toContainText('操作: admin@example.com');
      await expect(entry).not.toContainText('失敗の理由');
      await expect(entry).not.toContainText('取消の理由');
      await expect(entry).not.toContainText('口座の入力の期限');
      // 返金は取り消せないので、行にボタンは無い
      await expect(entry.getByRole('button')).toHaveCount(0);
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e2/order-history-refunds-${viewport.width}.png`, animations: 'disabled' });
    });

    test('キャンセルの行に、取消の理由・メモ・失敗の理由・口座の入力の期限が出る。在庫に戻さなかった商品の分は数えない', async ({ page }) => {
      // FREQ-459-AC-02
      const dialog = await openHistory(page);
      const entry = entryOf(dialog, 42_800);

      await expect(entry).toContainText('注文のキャンセル');
      await expect(entry).toContainText(stepsText(CANCEL_REFUND));
      await expect(entry).toContainText('取消の理由: 在庫切れ');
      await expect(entry).toContainText('メモ: 入荷が遅れるため');
      await expect(entry).toContainText('失敗の理由: 口座の入力の期限が過ぎました');
      await expect(entry).toContainText(`口座の入力の期限: ${formatJst('2026-11-25T14:59:59.000Z')}`);
      await expect(entry).toContainText(`商品: ${BLOUSE_NAME} × 1 / ${COAT_NAME} × 1`);
      // 在庫に戻したのはブラウスの1つだけ（コートは受注生産）
      await expect(entry).toContainText('在庫に戻した数: 1');
      await expect(entry).not.toContainText('照会番号');
      await expect(entry).not.toContainText('Stripe に伝えた理由');
    });

    test('Stripe の画面・自動の返金・前からの写しの返金は、どこからかの言葉が違い、商品や操作した人の行は出ない', async ({ page }) => {
      // FREQ-447-AC-01
      const dialog = await openHistory(page);

      const dashboard = entryOf(dialog, 15_000);
      await expect(dashboard).toContainText('Stripe の画面');
      await expect(dashboard).toContainText(stepsText(DASHBOARD_REFUND));
      await expect(dashboard).toContainText('商品: E2Eシャツ（ホワイト / M） × 1 / E2Eスカート（ホワイト / M） × 1');
      await expect(dashboard).toContainText('在庫に戻した数: 2');
      await expect(dashboard).not.toContainText('操作:');

      const auto = entryOf(dialog, 89_000);
      await expect(auto).toContainText('自動の返金（取り消した注文への入金）');
      await expect(auto).toContainText(stepsText(AUTO_REFUND));
      await expect(auto).not.toContainText('商品:');
      await expect(auto).not.toContainText('在庫に戻した数');
      await expect(auto).not.toContainText('操作:');

      const legacy = entryOf(dialog, 3_000);
      await expect(legacy).toContainText('前からの写し');
      await expect(legacy).toContainText(stepsText(LEGACY_REFUND));
      await expect(legacy).not.toContainText('商品:');
      await expect(legacy).not.toContainText('操作:');
    });

    test('失敗した返金の確保し直しの行が出て、足りなかった数は合計を約束の文の1行で出す。返金のお知らせのメールの行は再送のボタンが無い', async ({ page }) => {
      const dialog = await openHistory(page);

      const rereserve = dialog.getByRole('listitem').filter({ hasText: '返金の失敗で在庫を確保し直しました' });
      await expect(rereserve).toHaveCount(1);
      await expect(rereserve).toContainText(formatJst(REFUND_RERESERVE.at));
      await expect(rereserve).toContainText(`商品: ${BLOUSE_NAME} × 1 / ${COAT_NAME} × 2`);
      // 足りなかった数は、商品ごとの不足の合計（1 + 0）を、品名を付けない1つの要素で出す（Task 12 の T12-8。
      // どの商品が足りないかは、要対応の行の「確保し直せなかった商品」と店へのメールに出る）
      await expect(rereserve.getByText('足りなかった数: 1', { exact: true })).toBeVisible();
      await expect(rereserve.getByText(/足りなかった数/)).toHaveCount(1);

      const mail = dialog.getByRole('listitem').filter({ hasText: '返金のお知らせのメール' });
      await expect(mail).toHaveCount(1);
      await expect(mail.getByRole('button', { name: '中身を見る' })).toBeVisible();
      await expect(mail.getByRole('button', { name: 'お客様へ再送' })).toHaveCount(0);
    });

    test('受け取った額を超える返金は断られ、エラーと失敗の返金は返せる額に数えない。成功した返金の行は商品・在庫に戻した数・照会番号を持つ（手元の DB）', async () => {
      // FREQ-447-AC-02, FREQ-447-AC-03, FREQ-459-AC-01
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`refund-count-${viewport.name}`),
          [{ name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' }],
          { paidAmount: 'total' },
        );
        const [shirt] = order.orderItemIds;
        const full = PRICE * 3;

        // 受け取った額を超える返金は断られる
        await expectDbError(beginRefund(db, order.orderId, { actorId, amount: full + 1 }), 'REFUND_EXCEEDS_REFUNDABLE');

        // 1件目: シャツ1つ（在庫に戻す）が成功。照会番号つき
        const first = await beginRefund(db, order.orderId, {
          actorId,
          lines: [{ orderItemId: shirt, quantity: 1, beforeShipment: true }],
          amount: PRICE,
        });
        const done = await recordRefundResult(db, first.refundId, {
          referenceNumber: 'E2E-ARN-001',
          referenceType: 'acquirer_reference_number',
        });
        expect(done).toMatchObject({ status: 'succeeded', refundedAmount: PRICE, orderStatus: 'paid' });
        expect(await refundableAmountOf(db, order.orderId)).toBe(full - PRICE);
        expect(await refundLineRows(db, first.refundId)).toEqual([
          expect.objectContaining({
            order_item_id: shirt,
            quantity: 1,
            before_shipment: true,
            restock_type: 'cancel',
            amount: PRICE,
            released_quantity: 1,
            restocked_quantity: 1,
          }),
        ]);

        // 2件目: 額だけの返金が失敗。返事待ちの間は返せる額から引き、失敗になったら数えない
        const second = await beginRefund(db, order.orderId, { actorId, amount: 3_000 });
        expect(await refundableAmountOf(db, order.orderId)).toBe(full - PRICE - 3_000);
        const failed = await recordRefundResult(db, second.refundId, { stripeStatus: 'failed', failureReason: 'declined' });
        expect(failed).toMatchObject({ status: 'failed', newlyFailed: true, refundedAmount: PRICE });
        expect(await refundableAmountOf(db, order.orderId)).toBe(full - PRICE);

        // 3件目: Stripe に断られてエラー。数えない
        const third = await beginRefund(db, order.orderId, { actorId, amount: 2_000 });
        expect(await refundableAmountOf(db, order.orderId)).toBe(full - PRICE - 2_000);
        expect(await markRefundError(db, third.refundId, 'stripe_rejected')).toMatchObject({ outcome: 'errored' });
        expect(await refundableAmountOf(db, order.orderId)).toBe(full - PRICE);

        // 履歴が読む関数は、返金ごとの行を新しい順に返す（エラー → 失敗 → 成功）
        const listed = (await db.query('select * from public.list_order_refunds($1::uuid)', [order.orderId])).rows;
        expect(listed.map((row) => [row.status, row.amount])).toEqual([
          ['error', 2_000],
          ['failed', 3_000],
          ['succeeded', PRICE],
        ]);
        expect(listed[2]).toMatchObject({ source: 'admin', actor_email: expect.any(String), reference_number: 'E2E-ARN-001' });
        expect(listed[2].lines).toEqual([expect.objectContaining({ quantity: 1, before_shipment: true, restocked_quantity: 1 })]);
      });
    });

    test('返金の行が並んだ履歴の画面でも、横方向のページスクロールが発生しない', async ({ page }) => {
      const dialog = await openHistory(page);
      await expect(entryOf(dialog, 42_800)).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
