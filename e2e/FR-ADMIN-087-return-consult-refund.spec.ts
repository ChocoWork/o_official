/**
 * FR-ADMIN-087 額を相談して受け取り、あとで額を決めて返金する（返金しないで終える・失敗の後の返し直しを含む）
 * 対応 FREQ: FREQ-464（AC-06〜AC-10・AC-16・AC-17）、FREQ-467（AC-03）、FREQ-469（AC-03・AC-07）
 *
 * 画面（受け取りの「相談」・返品の欄の「額を決めて返金する」・その画面）は窓口の答えを差し替えて確かめ、返金待ち・手数料・返金の記録・
 * 返金しないで終える・メールは、窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼んで確かめる（実装計画 P11）。
 * Stripe には頼まず、返金の結果はこちらで書く。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  expectDbError,
  markRefundError,
  recordRefundResult,
  runWorkerUntil,
  sentOutboxCount,
  withLocalDb,
} from './order-email-test-utils';
import { UUID_PATTERN, fulfillJson, mockOrderList, openOrderTab, orderNumberOf, viewports } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  RETURN_MAIL,
  RETURN_TEXT,
  UNIT_STATES,
  chooseRefundChoice,
  confirmButton,
  createReturnInDb,
  createShippedOrder,
  formatYen,
  mockReturnRoutes,
  newReturnRouteState,
  openReceiveDialog,
  openReturnRefundDialog,
  openReturnsDialog,
  orderWithReturns,
  readReturnBreakdown,
  receiptRows,
  receiptUnitRows,
  receiveReturnInDb,
  refundData,
  refundReturnInDb,
  returnCard,
  returnDetailOf,
  returnEmailRows,
  returnLabelOf,
  returnLineOf,
  returnRefundRows,
  returnRowOf,
  returnSummaryOf,
  returnSummaryRow,
  returnsDialogName,
  setUnitState,
  waitForMails,
  type ReturnRouteState,
} from './return-test-utils';
import type { AttentionException } from '@/lib/orders/order-payment-types';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

const ORDER_ID = 'a7b2c3d4-0087-4000-8000-000000000087';
const SHIRT = 'c7b2c3d4-0000-4000-8000-000000000001';
const LINE = 'd7b2c3d4-0000-4000-8000-000000000001';
const SECOND_LINE = 'd7b2c3d4-0000-4000-8000-000000000002';
const THIRD_LINE = 'd7b2c3d4-0000-4000-8000-000000000003';
const RETURN_ID = 'b7b2c3d4-0000-4000-8000-000000000001';
const SECOND_RETURN_ID = 'b7b2c3d4-0000-4000-8000-000000000002';
const THIRD_RETURN_ID = 'b7b2c3d4-0000-4000-8000-000000000003';
const LABEL = returnLabelOf(ORDER_ID, 1);
const SECOND_LABEL = returnLabelOf(ORDER_ID, 2);
const THIRD_LABEL = returnLabelOf(ORDER_ID, 3);
const RECEIVED_RECEIPT = {
  id: '00000000-0000-4000-8000-0000000000e1',
  kind: 'receive' as const,
  refundChoice: 'consult' as const,
  createdAt: '2026-10-11T01:00:00.000Z',
  actorEmail: 'admin@example.com',
};

/** 受け取り済みで返金待ち（額は相談）の返品。シャツ1点・単価5,000円 */
function waitingReturn(overrides: Partial<Parameters<typeof returnDetailOf>[0]> = {}): OrderReturnDetail {
  return returnDetailOf({
    orderId: ORDER_ID,
    id: RETURN_ID,
    displayStatus: 'refund_waiting',
    marks: [],
    firstReceiptDone: true,
    receipts: [RECEIVED_RECEIPT],
    lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ', progress: { restocked: 1, refundWaiting: 1 } })],
    ...overrides,
  });
}

/** 要対応の欄の「返金の失敗」。失敗した返金が返品の返金なので、窓口は返品の番号（refundFailure.returnId）を付ける（実装計画 P21、Task 8） */
const RETURN_REFUND_FAILURE: AttentionException & { refundFailure: { returnId: string } } = {
  id: 'f7b2c3d4-0087-4000-8000-000000000001',
  reason: 'refund_failed',
  reasonLabel: '返金の失敗',
  detail: 'declined',
  orderId: ORDER_ID,
  orderNumber: orderNumberOf(ORDER_ID),
  orderStatus: 'paid',
  paymentRef: 're_e2eReturnFail1',
  firstDetectedAt: '2026-10-12T01:00:00.000Z',
  lastDetectedAt: '2026-10-12T01:00:00.000Z',
  detectionCount: 1,
  canCancelOrder: false,
  canRetryRefund: true,
  refundFailure: { amount: 5_000, failureReasonLabel: 'カードが使えません', shortages: [], returnId: RETURN_ID },
};

type ListOptions = {
  role?: 'admin' | 'supporter';
  summary?: Parameters<typeof returnSummaryOf>[0];
  state?: Partial<Parameters<typeof newReturnRouteState>[0]>;
  /** 要対応の欄に出す「返金の失敗」（省くと要対応は空のまま） */
  failures?: AttentionException[];
};

/** 一覧の窓口と返品の窓口を差し替えて、ORDER タブを開く */
async function openList(page: Page, returns: OrderReturnDetail[], options: ListOptions = {}): Promise<ReturnRouteState> {
  const state = newReturnRouteState({
    orderId: ORDER_ID,
    returns,
    returnableUnits: 0,
    refundableAmount: 20_000,
    refundableShipping: 800,
    canRefund: options.role !== 'supporter',
    ...options.state,
  });
  await mockAdminSessionAs(page, options.role ?? 'admin');
  await mockOrderList(page, () => [
    orderWithReturns({
      id: ORDER_ID,
      summary: returnSummaryOf(
        options.summary ?? { orderId: ORDER_ID, displayStatus: 'refund_waiting', nextAction: 'refund', hasReturnable: false, refundWaitingReturns: 1 },
      ),
      canRefund: options.role !== 'supporter',
    }),
  ]);
  await mockReturnRoutes(page, ORDER_ID, state);
  const failures = options.failures;
  if (failures) {
    // 後から登録した窓口が先に効く。管理画面が裏で読む要対応の空の答えを、この試験の答えで上書きする
    await page.route('**/api/admin/order-attention', (route) =>
      fulfillJson(route, { data: { exceptions: failures, reviews: [], counts: { exceptions: failures.length, reviews: 0 } } }));
  }
  await openOrderTab(page);
  return state;
}

/** 返金待ちの返品1つの「額を決めて返金する」の画面まで開く */
async function openRefund(page: Page) {
  const state = await openList(page, [waitingReturn()]);
  await openReturnsDialog(page, ORDER_ID, '額を決めて返金する');
  const dialog = await openReturnRefundDialog(page, ORDER_ID, LABEL);
  return { state, dialog };
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-087 return consult and refund (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('受け取りで「額を相談してから返金する」を選ぶと、確定のボタンが「受け取りだけ記録する（返金は額を決めてから）」になり、窓口へ相談が届く', async ({ page }) => {
      // FREQ-464-AC-06
      const detail = returnDetailOf({
        orderId: ORDER_ID,
        id: RETURN_ID,
        lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ' })],
      });
      const state = await openList(page, [detail], {
        summary: { orderId: ORDER_ID, displayStatus: 'in_progress', marks: ['awaiting_items'], nextAction: 'receive', hasReturnable: false },
      });
      await openReturnsDialog(page, ORDER_ID, '受け取る');
      const dialog = await openReceiveDialog(page, ORDER_ID, LABEL);

      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await expect(dialog.getByText(RETURN_TEXT.consultOption)).toBeVisible();
      await chooseRefundChoice(dialog, 'consult');
      await expect(confirmButton(dialog, RETURN_TEXT.consultButton)).toBeVisible();
      await confirmButton(dialog, RETURN_TEXT.consultButton).click();

      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].body).toMatchObject({ refundChoice: 'consult' });
      await expect(
        page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true }).getByRole('status'),
      ).toContainText(RETURN_TEXT.noticeRecorded);
    });

    test('返金待ちの返品（失敗の後に返金待ちへ戻った完了の返品を含む）の欄に、店長だけ「額を決めて返金する」が出る。サポートの人には出ない', async ({ page }) => {
      // FREQ-464-AC-07, FREQ-464-AC-17
      const waiting = waitingReturn();
      const failedAfterClose = waitingReturn({
        id: SECOND_RETURN_ID,
        number: 2,
        status: 'closed',
        lines: [returnLineOf({ id: SECOND_LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ', progress: { restocked: 1, refundWaiting: 1 } })],
        refunds: [{ id: randomUUID(), amount: 5_000, status: 'failed', createdAt: '2026-10-11T02:00:00.000Z' }],
      });
      const done = waitingReturn({
        id: THIRD_RETURN_ID,
        number: 3,
        status: 'closed',
        displayStatus: 'returned',
        lines: [returnLineOf({ id: THIRD_LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ', progress: { restocked: 1, refundCovered: 1 } })],
        refunds: [{ id: randomUUID(), amount: 5_000, status: 'succeeded', createdAt: '2026-10-11T03:00:00.000Z' }],
      });
      const state = await openList(page, [waiting, failedAfterClose, done]);
      const returns = await openReturnsDialog(page, ORDER_ID, '額を決めて返金する');
      const refundButton = (label: string) => returnCard(returns, label).getByRole('button', { name: '額を決めて返金する', exact: true });

      await expect(refundButton(LABEL)).toBeVisible();
      await expect(refundButton(SECOND_LABEL)).toBeVisible();
      await expect(refundButton(THIRD_LABEL)).toHaveCount(0);
      // 失敗した返金は「失敗」と出て、返品の状態は返金待ちのまま。返し直しは、同じ画面の「額を決めて返金する」
      await expect(returnCard(returns, SECOND_LABEL).getByText('返金待ち', { exact: true })).toBeVisible();
      await expect(returnCard(returns, SECOND_LABEL).getByText(`返金 ${formatYen(5_000)}（失敗）`)).toBeVisible();
      await refundButton(SECOND_LABEL).click();
      await expect(page.getByRole('dialog', { name: RETURN_TEXT.refundTitle(SECOND_LABEL), exact: true })).toBeVisible();
      expect(state.posts.refund).toHaveLength(0);

      // サポートの人の画面には、返金に関わるボタンが出ない（一覧のボタンも「返品」になる）
      await openList(page, [waiting, failedAfterClose, done], { role: 'supporter' });
      const supporterReturns = await openReturnsDialog(page, ORDER_ID, '返品');
      await expect(supporterReturns.getByRole('group', { name: LABEL, exact: true })).toBeVisible();
      await expect(supporterReturns.getByRole('button', { name: '額を決めて返金する', exact: true })).toHaveCount(0);
    });

    test('要対応の「返金の失敗」が返品の返金なら、店長の「もう一度返金する」はふつうの返金の画面ではなく返品の画面を開く。サポートの人には出ない', async ({ page }) => {
      // FREQ-464-AC-17
      await openList(page, [waitingReturn()], { failures: [RETURN_REFUND_FAILURE] });
      await expect(page.getByText(`返金の失敗（${orderNumberOf(ORDER_ID)}）`)).toBeVisible();

      await page.getByRole('button', { name: 'もう一度返金する', exact: true }).click();

      const returns = page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true });
      await expect(returns).toBeVisible();
      await expect(returnCard(returns, LABEL).getByRole('button', { name: '額を決めて返金する', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog', { name: '返金', exact: true })).toHaveCount(0);

      // サポートの人には返金の権限が無いので、返品の返金の失敗にも「もう一度返金する」を出さない（「解決済みにする」は出る）
      await openList(page, [waitingReturn()], { role: 'supporter', failures: [RETURN_REFUND_FAILURE] });
      await expect(page.getByText(`返金の失敗（${orderNumberOf(ORDER_ID)}）`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'もう一度返金する', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '解決済みにする', exact: true })).toBeVisible();
    });

    test('「額を決めて返金する」の画面に、内訳・返せる額・送料・メモ・知らせ・注意が出て、ボタンの額と窓口へ届く額が一致する', async ({ page }) => {
      // FREQ-464-AC-08
      const { state, dialog } = await openRefund(page);
      expect(await readReturnBreakdown(dialog)).toMatchObject({ '商品': formatYen(5_000), '返金額': formatYen(5_000) });
      await expect(dialog.getByLabel(RETURN_TEXT.refundAmountLabel(formatYen(20_000)), { exact: true })).toHaveValue('5000');
      await expect(dialog.getByLabel(RETURN_TEXT.shippingAmountLabel(formatYen(800)), { exact: true })).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: RETURN_TEXT.memoLabel, exact: true })).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: RETURN_TEXT.refundMailLabel, exact: true })).toBeChecked();
      await expect(dialog.getByText(RETURN_TEXT.refundNoUndo)).toBeVisible();

      state.answerAction = (route) => fulfillJson(route, { data: refundData({ amount: 5_000 }) });
      await confirmButton(dialog, RETURN_TEXT.refundButton(formatYen(5_000))).click();
      await expect.poll(() => state.posts.refund.length).toBe(1);
      expect(state.posts.refund[0].returnId).toBe(RETURN_ID);
      // 見込みどおりの額は送らない（DB が同じ式で計算し直す。Task 9 の額を決めて返金の画面）
      expect(state.posts.refund[0].body).toMatchObject({ amount: null, shippingAmount: 0, note: null, notifyCustomer: true });
      expect(String(state.posts.refund[0].body.requestKey)).toMatch(UUID_PATTERN);
    });

    test('窓口が「返金額は返せる額までにしてください。」と断った時は、その文が画面の中に出て、画面は閉じない', async ({ page }) => {
      // FREQ-464-AC-09
      const { state, dialog } = await openRefund(page);
      const refusal = '返金額は、返せる額までにしてください。';
      state.answerAction = (route) => fulfillJson(route, { error: refusal, code: 'RETURN_REFUND_AMOUNT_INVALID' }, 400);

      await dialog.getByLabel(RETURN_TEXT.refundAmountLabel(formatYen(20_000)), { exact: true }).fill('19000');
      await confirmButton(dialog, RETURN_TEXT.refundButton(formatYen(19_000))).click();

      await expect(dialog.getByRole('alert')).toContainText(refusal);
      await expect(dialog).toBeVisible();
      expect(state.posts.refund).toHaveLength(1);
      // 手で直した額は、ボタンの額のまま窓口へ届く（ボタンの額と窓口へ届く額が一致する）
      expect(state.posts.refund[0].body).toMatchObject({ amount: 19_000, shippingAmount: 0 });
      await expect(confirmButton(dialog, RETURN_TEXT.refundButton(formatYen(19_000)))).toBeEnabled();
    });

    test('返金額を0にすると、ボタンが「返金しないで終える」・注意が「返金しないで終えます。…」になり、窓口へ金額0が届いて「返金しないで終えました。」が出る', async ({ page }) => {
      // FREQ-464-AC-16
      const { state, dialog } = await openRefund(page);
      state.answerAction = (route) => fulfillJson(route, { data: refundData({ amount: 0, status: 'waived', refundId: null }) });

      await dialog.getByLabel(RETURN_TEXT.refundAmountLabel(formatYen(20_000)), { exact: true }).fill('0');
      await expect(confirmButton(dialog, RETURN_TEXT.refundWaiveButton)).toBeVisible();
      await expect(dialog.getByText(RETURN_TEXT.refundWaiveNote)).toBeVisible();
      await expect(dialog.getByText(RETURN_TEXT.refundNoUndo)).toHaveCount(0);
      await confirmButton(dialog, RETURN_TEXT.refundWaiveButton).click();

      await expect.poll(() => state.posts.refund.length).toBe(1);
      expect(state.posts.refund[0].body).toMatchObject({ amount: 0 });
      await expect(
        page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true }).getByRole('status'),
      ).toContainText(RETURN_TEXT.noticeWaived);
    });

    test('相談で受け取ると返金待ちになり、手数料は引くまで残る。額を決めて返金すると手数料を引いた額になり、Stripe が受け付けると返品が完了する（手元の DB）', async () => {
      // FREQ-464-AC-10, FREQ-467-AC-03
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `consult-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }], restockingFeePercent: 10 });

        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 2 }],
          choice: 'consult',
        });
        // 受け取りだけ記録する: 返金の記録は作らず、手数料（10,000円の10%）は引くまで残す
        expect(received).toMatchObject({ refundId: null, returnStatus: 'open', replayed: false });
        expect(await returnRowOf(db, created.returnId)).toMatchObject({ fee_pending_deduction: 1_000, fee_due_amount: 0 });
        expect(await returnRefundRows(db, fx.orderId)).toEqual([]);
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'refund_waiting', next_action: 'refund' });

        // 額を決めて返金（計算どおり）: 10,000円 − 手数料 1,000円。引いた手数料は0に戻る。返金は返品の返金として記録され、
        // 返金の品が返金の記録に覆われるので、返品は完了する（返事待ちの間も「返品済み」）
        const refund = await refundReturnInDb(db, created.returnId, fx.actorId);
        expect(refund).toMatchObject({ amount: 9_000, status: 'awaiting_response', replayed: false });
        expect(await returnRowOf(db, created.returnId)).toMatchObject({ status: 'closed', fee_pending_deduction: 0, fee_due_amount: 0 });
        expect(await returnRefundRows(db, fx.orderId)).toEqual([
          { id: refund.refundId, return_id: created.returnId, source: 'return', status: 'awaiting_response', amount: 9_000 },
        ]);
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });

        // 結果が成功になっても、返品は完了のまま
        await recordRefundResult(db, refund.refundId as string);
        expect((await returnRowOf(db, created.returnId)).status).toBe('closed');
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });
      });
    });

    test('返品の返金がエラーか失敗になると、その返金で引いた手数料が戻り、返し直しの「計算どおり」でもう一度引く。手数料が二重に引かれることも、引き忘れることもない（手元の DB）', async () => {
      // FREQ-467-AC-03（実装計画 P26）
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `fee-restore-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }], restockingFeePercent: 10 });

        // 今返金の受け取り: 10,000円 − 手数料 1,000円 = 9,000円
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 2 }],
          choice: 'now',
        });
        expect(received).toMatchObject({ refundAmount: 9_000, returnStatus: 'closed' });

        // Stripe が受け付けなかった（エラー）。返金待ちに戻り、返し直しの計算どおりの額は、また 9,000円（手数料を引き忘れない）
        await markRefundError(db, received.refundId as string, 'stripe_rejected');
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'refund_waiting', next_action: 'refund' });
        const retry = await refundReturnInDb(db, created.returnId, fx.actorId);
        expect(retry).toMatchObject({ amount: 9_000, status: 'awaiting_response' });

        // こんどは受け付けた後に失敗（銀行から戻されたなど）。もう一度返し直しても 9,000円で、手数料は二重に引かれない
        await recordRefundResult(db, retry.refundId as string, { stripeStatus: 'failed', failureReason: 'declined' });
        const second = await refundReturnInDb(db, created.returnId, fx.actorId);
        expect(second).toMatchObject({ amount: 9_000, status: 'awaiting_response' });
        await recordRefundResult(db, second.refundId as string);
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });
        expect((await returnRefundRows(db, fx.orderId)).map((row) => [row.status, row.amount])).toEqual([
          ['error', 9_000],
          ['failed', 9_000],
          ['succeeded', 9_000],
        ]);
      });
    });

    test('額を決めて返金で0円にすると、返金の記録も返金のメールも作らず、返品が完了する。同じ番号の送り直しは同じ結果で、違う額は断る（手元の DB）', async () => {
      // FREQ-464-AC-16
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `waive-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        // メールの予定を種類で完全一致に比べるので、作る時の受付のお知らせ（return_accepted）は入れない
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], restockingFeePercent: 10, notify: false });
        await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
        });
        const key = randomUUID();

        expect(await refundReturnInDb(db, created.returnId, fx.actorId, { requestKey: key, amount: 0 })).toEqual({
          refundId: null,
          amount: 0,
          status: 'waived',
          replayed: false,
        });
        expect(await refundReturnInDb(db, created.returnId, fx.actorId, { requestKey: key, amount: 0 })).toMatchObject({
          refundId: null,
          status: 'waived',
          replayed: true,
        });
        await expectDbError(refundReturnInDb(db, created.returnId, fx.actorId, { requestKey: key, amount: 1 }), 'RETURN_REQUEST_MISMATCH');

        // 返金の記録は作らず、返金しないことにした数を「返金しない」の受け取りとして残す。返品は完了する
        expect(await returnRefundRows(db, fx.orderId)).toEqual([]);
        const receipts = await receiptRows(db, created.returnId);
        expect(receipts.map((row) => row.kind)).toEqual(['receive', 'waive_refund']);
        expect(await receiptUnitRows(db, receipts[1].id)).toEqual([
          { disposition: 'refund_waived', quantity: 1, resolution: null, exchange_method: null },
        ]);
        expect(await returnRowOf(db, created.returnId)).toMatchObject({ status: 'closed', fee_pending_deduction: 0, fee_due_amount: 0 });
        // お客様に返金のメールの予定は書かない（書かれるのは、相談で受け取った時の「返品をお受け取りしました」だけ）
        expect((await returnEmailRows(db, fx.orderId)).map((row) => row.kind)).toEqual(['return_received']);
      });
    });

    test('返品の返金が失敗した後は、完了した返品でも返金待ちになり、同じ返品の画面から返し直せる。返し直しも返品の返金として記録される（手元の DB）', async () => {
      // FREQ-464-AC-17
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `retry-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }] });
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'now',
        });
        expect(received.returnStatus).toBe('closed');

        // Stripe が受け付けた後に失敗した（銀行から戻されたなど）。返品の記録の状態は戻さないが、画面の状態は返金待ちに戻る
        const accepted = await recordRefundResult(db, received.refundId as string, { stripeStatus: 'pending', pendingReason: 'processing' });
        await recordRefundResult(db, received.refundId as string, {
          stripeRefundId: accepted.stripeRefundId,
          stripeStatus: 'failed',
          failureReason: 'declined',
        });
        expect((await returnRowOf(db, created.returnId)).status).toBe('closed');
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'refund_waiting', next_action: 'refund' });

        // 同じ返品の「額を決めて返金する」で返し直す。道は return のまま、返品とのつながりを保つ
        const retry = await refundReturnInDb(db, created.returnId, fx.actorId);
        expect(retry).toMatchObject({ amount: 5_000, status: 'awaiting_response' });
        expect(await returnRefundRows(db, fx.orderId)).toEqual([
          expect.objectContaining({ id: received.refundId, return_id: created.returnId, source: 'return', status: 'failed' }),
          expect.objectContaining({ id: retry.refundId, return_id: created.returnId, source: 'return', status: 'awaiting_response' }),
        ]);
        await recordRefundResult(db, retry.refundId as string);
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });
      });
    });

    test('相談で受け取ると「返品をお受け取りしました」が1通届き、あとで額を決めて返金すると、返金のお知らせに「ご返品いただいた商品のご返金です」が入る（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-03, FREQ-469-AC-07
      test.setTimeout(240_000);
      const { fx, label, returnId } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `consult-mail-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }] });
        await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
          notify: true,
        });
        return { fx, label: returnLabelOf(fx.orderId, created.number), returnId: created.returnId };
      });
      const orderNumber = orderNumberOf(fx.orderId);

      const received = await waitForMails(request, fx.email, RETURN_MAIL.received);
      expect(received).toHaveLength(1);
      expect(received[0].Subject).toBe(`【Le Fil des Heures】${RETURN_MAIL.received}（${orderNumber}）`);
      expect(received[0].Text).toContain(RETURN_MAIL.received1(label));
      expect(received[0].Text).toContain('お受け取りした商品:');
      expect(received[0].Text).toContain('・E2Eシャツ（ホワイト / M） × 1');
      expect(received[0].Text).toContain(RETURN_MAIL.consult);

      // あとで店長が額を決めて返金する。Stripe が受け付けると、返金のお知らせの予定が書かれる
      await withLocalDb(async (db) => {
        const refund = await refundReturnInDb(db, returnId, fx.actorId);
        await recordRefundResult(db, refund.refundId as string);
      });
      await runWorkerUntil(request, async () => (await sentOutboxCount(fx.orderId, 'refund')) >= 1, '返金のお知らせが送信済みになること');
      const refundMails = await waitForMails(request, fx.email, RETURN_MAIL.refund);
      expect(refundMails).toHaveLength(1);
      expect(refundMails[0].Text).toContain(RETURN_MAIL.refundLead(orderNumber));
      expect(refundMails[0].Text).toContain(RETURN_MAIL.refundLater(label));
      expect(refundMails[0].Text).not.toContain(RETURN_MAIL.received1(label));
      expect(refundMails[0].Text).not.toContain(RETURN_MAIL.notShipping);
    });
  });
}
