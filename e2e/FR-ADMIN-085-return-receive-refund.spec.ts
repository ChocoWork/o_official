/**
 * FR-ADMIN-085 受け取りと、受け取りと一緒の返金（今返金）
 * 対応 FREQ: FREQ-463（AC-01・AC-02）、FREQ-464（AC-01〜AC-05・AC-15）、FREQ-467（AC-01・AC-02）、FREQ-469（AC-02・AC-03）
 *
 * 受け取りの画面は窓口の答えを差し替えて確かめ（窓口に届く本文と、答えが分からない時の確かめ直し）、受け取りが DB に書くもの
 * （受け取りの行・在庫の台帳・返金の記録・返品の状態・メールの予定）は、窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼んで確かめる
 * （実装計画 P11）。Stripe には頼まず、返金の結果はこちらで書く（Stripe に頼む部分は単体の試験と DB 結合が確かめる）。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  expectDbError,
  markRefundError,
  recordRefundResult,
  refundLineRows,
  runWorkerUntil,
  sentOutboxCount,
  variantStockState,
  withLocalDb,
} from './order-email-test-utils';
import {
  UUID_PATTERN,
  fulfillJson,
  mockOrderList,
  openOrderTab,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';
import { MINUS, mockAdminSessionAs } from './refund-test-utils';
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
  openReturnsDialog,
  orderWithReturns,
  readReturnBreakdown,
  receiptRows,
  receiptUnitRows,
  receiveData,
  receiveReturnInDb,
  returnDetailOf,
  returnEmailRows,
  returnLabelOf,
  returnLedger,
  returnLineOf,
  returnRefundRows,
  returnRowOf,
  returnSummaryOf,
  returnSummaryRow,
  returnsDialogName,
  setUnitState,
  unitTotal,
  waitForMails,
} from './return-test-utils';
import type { OrderReturnDetail, ReturnMethod } from '@/lib/orders/returns/return-types';

const ORDER_ID = 'a5b2c3d4-0085-4000-8000-000000000085';
const SHIRT = 'c5b2c3d4-0000-4000-8000-000000000001';
const LINE = 'd5b2c3d4-0000-4000-8000-000000000001';
const RETURN_ID = 'b5b2c3d4-0000-4000-8000-000000000001';
const LABEL = returnLabelOf(ORDER_ID, 1);

type ReceiveSetup = {
  /** 返品の数（既定 2） */
  quantity?: number;
  /** すでに受け取って処理した数（その分は未処理から外れる） */
  processed?: number;
  returnMethod?: ReturnMethod;
  fees?: Partial<OrderReturnDetail['fees']>;
  firstReceiptDone?: boolean;
};

/** 一覧の「受け取る」→ 返品の画面 → 受け取りの画面まで開く。窓口は差し替える（単価は5,000円、返せる額は20,000円） */
async function openReceive(page: Page, options: ReceiveSetup = {}) {
  const line = returnLineOf({
    id: LINE,
    orderItemId: SHIRT,
    quantity: options.quantity ?? 2,
    itemName: 'E2Eシャツ',
    progress: options.processed ? { restocked: options.processed } : undefined,
  });
  const detail = returnDetailOf({
    orderId: ORDER_ID,
    id: RETURN_ID,
    lines: [line],
    returnMethod: options.returnMethod,
    fees: options.fees,
    firstReceiptDone: options.firstReceiptDone,
    marks: options.processed ? ['partially_received'] : ['awaiting_items'],
  });
  const state = newReturnRouteState({ orderId: ORDER_ID, returns: [detail], returnableUnits: 0, refundableAmount: 20_000 });
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => [
    orderWithReturns({
      id: ORDER_ID,
      summary: returnSummaryOf({
        orderId: ORDER_ID,
        displayStatus: 'in_progress',
        marks: detail.marks,
        nextAction: 'receive',
        hasReturnable: false,
      }),
    }),
  ]);
  await mockReturnRoutes(page, ORDER_ID, state);
  await openOrderTab(page);
  await openReturnsDialog(page, ORDER_ID, '受け取る');
  const dialog = await openReceiveDialog(page, ORDER_ID, LABEL);
  return { state, dialog };
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-085 return receive and refund (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('受け取りの画面は品を1点ずつ1行に出し、状態を選ぶと進み具合とボタンの言葉が変わる。返金は「計算どおり」が最初に選ばれ、窓口へ「今返金」が届く', async ({ page }) => {
      // FREQ-463-AC-01, FREQ-464-AC-01
      const { state, dialog } = await openReceive(page);
      await expect(dialog.getByRole('combobox', { name: '品の状態', exact: true })).toHaveCount(2);
      await expect(dialog.getByText(RETURN_TEXT.progress(2, 0))).toBeVisible();

      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await expect(dialog.getByText(RETURN_TEXT.progress(2, 1))).toBeVisible();
      await expect(confirmButton(dialog, RETURN_TEXT.receivePart(1, formatYen(5_000)))).toBeVisible();
      await setUnitState(dialog, 1, UNIT_STATES.restock);
      await expect(dialog.getByText(RETURN_TEXT.progress(2, 2))).toBeVisible();
      await expect(dialog.getByRole('radio', { name: `計算どおり ${formatYen(10_000)} を返金する`, exact: true })).toBeChecked();

      state.answerAction = (route) =>
        fulfillJson(route, {
          data: receiveData({ returnStatus: 'closed', refundId: randomUUID(), refundAmount: 10_000, refundStatus: 'succeeded' }),
        });
      await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(10_000))).click();

      const returns = page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true });
      await expect(returns.getByRole('status')).toContainText(RETURN_TEXT.noticeRefunded);
      expect(state.posts.receive).toHaveLength(1);
      const post = state.posts.receive[0];
      expect(post.returnId).toBe(RETURN_ID);
      expect(post.body).toMatchObject({ refundChoice: 'now', notifyCustomer: true });
      expect(post.body.refundAmount ?? null).toBeNull();
      expect(String(post.body.requestKey)).toMatch(UUID_PATTERN);
      expect(unitTotal(post.body, LINE, 'restocked')).toBe(2);
    });

    test('見込みの内訳に、返送料と返品の手数料が出て、返金額とボタンの額が一致する。返送料は最初の受け取りだけに付く', async ({ page }) => {
      // FREQ-467-AC-01
      const first = await openReceive(page, { returnMethod: 'shop_label', fees: { returnShippingFee: 800, restockingFeePercent: 10 } });
      await setUnitState(first.dialog, 0, UNIT_STATES.restock);
      await setUnitState(first.dialog, 1, UNIT_STATES.restock);
      expect(await readReturnBreakdown(first.dialog)).toMatchObject({
        '商品': formatYen(10_000),
        '返送料': `${MINUS}${formatYen(800)}`,
        '返品の手数料': `${MINUS}${formatYen(1_000)}`,
        '返金額': formatYen(8_200),
      });
      await expect(confirmButton(first.dialog, RETURN_TEXT.receiveAll(formatYen(8_200)))).toBeVisible();

      // 1点を受け取った後の2回目: 返送料は引かず、返品の手数料だけを引く（画面を開き直す）
      const second = await openReceive(page, {
        returnMethod: 'shop_label',
        fees: { returnShippingFee: 800, restockingFeePercent: 10 },
        processed: 1,
        firstReceiptDone: true,
      });
      await setUnitState(second.dialog, 0, UNIT_STATES.restock);
      const breakdown = await readReturnBreakdown(second.dialog);
      expect(breakdown).toMatchObject({ '商品': formatYen(5_000), '返品の手数料': `${MINUS}${formatYen(500)}`, '返金額': formatYen(4_500) });
      expect(Object.keys(breakdown)).not.toContain('返送料');
      await expect(confirmButton(second.dialog, RETURN_TEXT.receiveAll(formatYen(4_500)))).toBeVisible();
    });

    test('店長は返金額を直せて、その額が窓口へ届く', async ({ page }) => {
      // FREQ-464-AC-02
      const { state, dialog } = await openReceive(page);
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await setUnitState(dialog, 1, UNIT_STATES.restock);
      await dialog.getByLabel(RETURN_TEXT.refundAmountLabel(formatYen(20_000)), { exact: true }).fill('7000');
      await expect(confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(7_000)))).toBeVisible();

      await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(7_000))).click();
      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].body).toMatchObject({ refundChoice: 'now', refundAmount: 7_000 });
    });

    test('答えが分からない時（通信の切れ）は入力を止め、「もう一度確かめる」と「閉じる」だけを出し、同じ二重防止の番号・同じ中身で確かめ直す', async ({ page }) => {
      // FREQ-464-AC-03
      // ここで確かめるのは通信の切れ。窓口が 500・502 を返した時の同じ動きは、単体の試験（OrderReturnReceiveDialog）が確かめる
      const { state, dialog } = await openReceive(page, { quantity: 1 });
      let attempt = 0;
      state.answerAction = async (route) => {
        attempt += 1;
        if (attempt === 1) {
          await route.abort('failed');
          return;
        }
        await fulfillJson(route, {
          data: receiveData({
            returnStatus: 'closed',
            refundId: randomUUID(),
            refundAmount: 5_000,
            refundStatus: 'succeeded',
            replayed: true,
          }),
        });
      };
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(5_000))).click();

      await expect(dialog.getByRole('alert')).toContainText(RETURN_TEXT.unknownReceive);
      await expect(confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(5_000)))).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'もう一度確かめる', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '閉じる', exact: true })).toBeVisible();
      await expect(dialog.getByRole('combobox', { name: '品の状態', exact: true })).toBeDisabled();

      await dialog.getByRole('button', { name: 'もう一度確かめる', exact: true }).click();
      await expect(page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true }).getByRole('status')).toContainText(
        RETURN_TEXT.noticeRefunded,
      );
      expect(state.posts.receive).toHaveLength(2);
      expect(state.posts.receive[1].body.requestKey).toBe(state.posts.receive[0].body.requestKey);
      expect(state.posts.receive[1].body).toEqual(state.posts.receive[0].body);
    });

    test('今返金の額が0円になる時（手数料が商品の額以上）は、確定のボタンが「…、返金なしで記録する」になり、窓口へ今返金が届く', async ({ page }) => {
      // FREQ-464-AC-15
      const { state, dialog } = await openReceive(page, { quantity: 1, fees: { restockingFeePercent: 100 } });
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await expect(confirmButton(dialog, RETURN_TEXT.receiveAllWaived())).toBeVisible();
      expect(await readReturnBreakdown(dialog)).toMatchObject({ '返金額': formatYen(0) });

      state.answerAction = (route) =>
        fulfillJson(route, {
          data: receiveData({ returnStatus: 'closed', refundId: null, refundAmount: 0, refundStatus: 'waived' }),
        });
      await confirmButton(dialog, RETURN_TEXT.receiveAllWaived()).click();
      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].body).toMatchObject({ refundChoice: 'now' });
      expect(unitTotal(state.posts.receive[0].body, LINE, 'restocked')).toBe(1);
    });

    test('返金の選びを「相談」に替えると、確定のボタンの言葉が替わる（受け取りの画面の選びが動くこと）', async ({ page }) => {
      // FREQ-464-AC-01
      const { dialog } = await openReceive(page, { quantity: 1 });
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await expect(dialog.getByRole('radio', { name: RETURN_TEXT.nowOption })).toBeChecked();
      await chooseRefundChoice(dialog, 'consult');
      await expect(confirmButton(dialog, RETURN_TEXT.consultButton)).toBeVisible();
      await chooseRefundChoice(dialog, 'now');
      await expect(confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(5_000)))).toBeVisible();
    });

    test('今返金の受け取りは、受け取りの行・在庫の台帳（返品の受け取り）・返金の記録（道 return・返品の番号つき）を1回で書き、品が全部処理されると返品が完了する（手元の DB）', async () => {
      // FREQ-463-AC-02, FREQ-464-AC-04
      // ここで確かめるのは、在庫に戻した品の台帳と受け取りの行。戻さない・お返しの品が在庫を動かさないことは、088・089 の試験が確かめる
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `now-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const [shirt] = fx.orderItemIds;
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }] });
        const lineId = created.lineIds[shirt];
        expect((await variantStockState(db, fx.variantId)).stock).toBe(0);

        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId, disposition: 'restocked', quantity: 2 }],
          choice: 'now',
        });
        expect(received).toMatchObject({ refundAmount: 10_000, returnStatus: 'closed', replayed: false });
        expect(received.refundId).not.toBeNull();
        const refundId = received.refundId as string;

        // 返金の記録: 道 return・返品の番号つき・商品の行の在庫の戻し方は return（在庫は受け取りで動かすので、返金では動かさない）
        expect(await returnRefundRows(db, fx.orderId)).toEqual([
          { id: refundId, return_id: created.returnId, source: 'return', status: 'awaiting_response', amount: 10_000 },
        ]);
        expect(await refundLineRows(db, refundId)).toEqual([
          expect.objectContaining({ order_item_id: shirt, quantity: 2, before_shipment: false, restock_type: 'return' }),
        ]);
        // 受け取りの記録と行（品ごとの扱い）
        expect(await receiptRows(db, created.returnId)).toEqual([
          expect.objectContaining({ id: received.receiptId, kind: 'receive', refund_choice: 'now', refund_id: refundId }),
        ]);
        expect(await receiptUnitRows(db, received.receiptId)).toEqual([
          { disposition: 'restocked', quantity: 2, resolution: 'refund', exchange_method: null },
        ]);
        // 在庫の台帳: 返品の受け取り（return）の +2 が、返品の番号つきで1行。すぐ出せる数が増える
        expect(await returnLedger(db, fx.orderId)).toEqual([
          { reason: 'return', delta: 2, return_id: created.returnId, variant_id: fx.variantId },
        ]);
        expect((await variantStockState(db, fx.variantId)).stock).toBe(2);

        // Stripe が受け付けた結果を書いても、在庫はもう一度動かず、返品は完了のまま
        expect(await recordRefundResult(db, refundId)).toMatchObject({ status: 'succeeded' });
        expect((await returnLedger(db, fx.orderId)).map((row) => row.delta)).toEqual([2]);
        expect((await returnRowOf(db, created.returnId)).status).toBe('closed');
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });
      });
    });

    test('今返金は返金額から手数料を引き、返送料は最初の受け取りにだけ付く。返品の手数料は受け取った品の額に対して毎回計算する（手元の DB）', async () => {
      // FREQ-467-AC-02
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `fees-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 2 }],
          method: 'shop_label',
          returnShippingFee: 800,
          restockingFeePercent: 10,
        });
        const lineId = created.lineIds[shirt];
        expect(await returnRowOf(db, created.returnId)).toMatchObject({
          return_method: 'shop_label',
          return_shipping_fee: 800,
          restocking_fee_percent: 10,
        });

        // 1回目: 5,000円 − 返送料 800円 − 返品の手数料 500円（5,000円の10%）
        const first = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId, disposition: 'restocked', quantity: 1 }],
          choice: 'now',
        });
        expect(first).toMatchObject({ refundAmount: 3_700, returnStatus: 'open', feeDueAmount: 0 });
        await recordRefundResult(db, first.refundId as string);

        // 2回目: 返送料は引かない。5,000円 − 返品の手数料 500円
        const second = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId, disposition: 'restocked', quantity: 1 }],
          choice: 'now',
        });
        expect(second).toMatchObject({ refundAmount: 4_500, returnStatus: 'closed', feeDueAmount: 0 });
        expect((await returnRefundRows(db, fx.orderId)).map((row) => row.amount)).toEqual([3_700, 4_500]);
      });
    });

    test('同じ二重防止の番号の送り直しは、受け取り・在庫・返金の記録を増やさず前の結果を返し、違う中身は断る（手元の DB）', async () => {
      // FREQ-464-AC-05
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `replay-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }] });
        const units = [{ lineId: created.lineIds[shirt], disposition: 'restocked' as const, quantity: 1 }];
        const requestKey = randomUUID();

        const first = await receiveReturnInDb(db, created.returnId, fx.actorId, { requestKey, units, choice: 'now' });
        const again = await receiveReturnInDb(db, created.returnId, fx.actorId, { requestKey, units, choice: 'now' });
        expect(again).toMatchObject({ receiptId: first.receiptId, refundId: first.refundId, replayed: true });
        expect(await receiptRows(db, created.returnId)).toHaveLength(1);
        expect(await returnRefundRows(db, fx.orderId)).toHaveLength(1);
        expect(await returnLedger(db, fx.orderId)).toHaveLength(1);
        expect((await variantStockState(db, fx.variantId)).stock).toBe(1);

        // Stripe の結果を書いた後の送り直しは、結果の状態を返す（もう一度頼まない）
        await recordRefundResult(db, first.refundId as string);
        expect((await receiveReturnInDb(db, created.returnId, fx.actorId, { requestKey, units, choice: 'now' })).refundStatus).toBe('succeeded');

        await expectDbError(
          receiveReturnInDb(db, created.returnId, fx.actorId, { requestKey, units, choice: 'consult' }),
          'RETURN_REQUEST_MISMATCH',
        );
        expect(await receiptRows(db, created.returnId)).toHaveLength(1);
      });
    });

    test('今返金の額が0円になる時は、返金の記録を作らず「返金しない」数として受け取りに残し、在庫は戻す。手数料が商品の額に収まる時は返品が完了し、超える時は引けなかった手数料がお支払い待ちに残る（手元の DB）', async () => {
      // FREQ-464-AC-15
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `waived-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        // 返品の手数料が100%なので、商品の額と同じ手数料が付き、返金は0円になる（引けなかった手数料は残らない）
        // メールの予定を種類で完全一致に比べるので、作る時の受付のお知らせ（return_accepted）は入れない
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], restockingFeePercent: 100, notify: false });
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'now',
        });

        expect(received).toMatchObject({
          refundId: null,
          refundAmount: 0,
          refundStatus: 'waived',
          feeDueAmount: 0,
          returnStatus: 'closed',
        });
        expect(await returnRefundRows(db, fx.orderId)).toEqual([]);
        expect(await receiptUnitRows(db, received.receiptId)).toEqual([
          { disposition: 'refund_waived', quantity: 1, resolution: null, exchange_method: null },
          { disposition: 'restocked', quantity: 1, resolution: 'refund', exchange_method: null },
        ]);
        expect((await returnLedger(db, fx.orderId)).map((row) => row.delta)).toEqual([1]);
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });
        // お客様へのメールの予定は、返金のお知らせではなく「返品をお受け取りしました」が1行（実装計画 P20・P24）
        expect((await returnEmailRows(db, fx.orderId)).map((row) => row.kind)).toEqual(['return_received']);

        // 手数料が商品の額を超える時（返送料 800円 + 返品の手数料 100%）も、返金は0円で記録を作らず、引けなかった手数料 800円は
        // お支払い待ち（fee_due_amount）に残り、返品は完了しない（シャツは2点なので、残りの1点で2つ目の返品を作る）
        const over = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1 }],
          method: 'shop_label',
          returnShippingFee: 800,
          restockingFeePercent: 100,
          notify: false,
        });
        const overReceived = await receiveReturnInDb(db, over.returnId, fx.actorId, {
          units: [{ lineId: over.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'now',
          notify: false,
        });
        expect(overReceived).toMatchObject({ refundId: null, refundAmount: 0, refundStatus: 'waived', feeDueAmount: 800, returnStatus: 'open' });
        expect(await returnRowOf(db, over.returnId)).toMatchObject({ fee_due_amount: 800, fee_received_at: null });
        expect(await returnRefundRows(db, fx.orderId)).toEqual([]);
      });
    });

    test('今返金の額が0円になる受け取りは、返金のお知らせを送らず、「返品をお受け取りしました」を1通送って「ご返金の額が0円のため、ご返金はございません。」と伝える（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-03
      test.setTimeout(180_000);
      const { fx, label } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `waived-mail-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        // メールの予定を種類で完全一致に比べるので、作る時の受付のお知らせ（return_accepted）は入れない
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], restockingFeePercent: 100, notify: false });
        await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'now',
          notify: true,
        });
        return { fx, label: returnLabelOf(fx.orderId, created.number) };
      });

      const mails = await waitForMails(request, fx.email, RETURN_MAIL.received);
      expect(mails).toHaveLength(1);
      expect(mails[0].Subject).toBe(`【Le Fil des Heures】${RETURN_MAIL.received}（${orderNumberOf(fx.orderId)}）`);
      expect(mails[0].Text).toContain(RETURN_MAIL.received1(label));
      expect(mails[0].Text).toContain(RETURN_MAIL.refundZero);
      // 相談の文は入らず、返金のお知らせの予定も書かれない（返金の記録が無いため）
      expect(mails[0].Text).not.toContain(RETURN_MAIL.consult);
      const rows = await withLocalDb((db) => returnEmailRows(db, fx.orderId));
      expect(rows.map((row) => row.kind)).toEqual(['return_received']);
    });

    test('今返金が Stripe に受け付けられずエラーになった受け取りは、返金のお知らせが出ないので、「返品をお受け取りしました」が1通届き、相談の文が入る（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-03（実装計画 P25）
      test.setTimeout(180_000);
      const { fx, label } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `error-mail-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        // メールの予定を種類で完全一致に比べるので、作る時の受付のお知らせ（return_accepted）は入れない
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'now',
          notify: true,
        });
        // Stripe の返事を待つ間は、お客様へのメールの予定は何も書かない
        expect(await returnEmailRows(db, fx.orderId)).toEqual([]);
        // Stripe が受け付けなかった（その場で断られた、または答えが分からないまま見回りがエラーにした）
        await markRefundError(db, received.refundId as string, 'stripe_rejected');
        return { fx, label: returnLabelOf(fx.orderId, created.number) };
      });

      const mails = await waitForMails(request, fx.email, RETURN_MAIL.received);
      expect(mails).toHaveLength(1);
      expect(mails[0].Text).toContain(RETURN_MAIL.received1(label));
      expect(mails[0].Text).toContain(RETURN_MAIL.consult);
      expect(mails[0].Text).not.toContain(RETURN_MAIL.refundZero);
      const rows = await withLocalDb((db) => returnEmailRows(db, fx.orderId));
      expect(rows.map((row) => row.kind)).toEqual(['return_received']);
    });

    test('受け取りと一緒に返金したお知らせに、返品の受け取りの文が入り、「返金した商品はお送りしません。」は入らない（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-02
      test.setTimeout(180_000);
      const { fx, label } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `refund-mail-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }] });
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'now',
          notify: true,
        });
        // Stripe が受け付けた時に、返金のお知らせの予定が1行書かれる
        expect(await recordRefundResult(db, received.refundId as string)).toMatchObject({ status: 'succeeded', emailEnqueued: true });
        return { fx, label: returnLabelOf(fx.orderId, created.number) };
      });
      const orderNumber = orderNumberOf(fx.orderId);

      await runWorkerUntil(request, async () => (await sentOutboxCount(fx.orderId, 'refund')) >= 1, '返金のお知らせが送信済みになること');
      const mails = await waitForMails(request, fx.email, RETURN_MAIL.refund);
      expect(mails).toHaveLength(1);
      expect(mails[0].Subject).toBe(`【Le Fil des Heures】${RETURN_MAIL.refund}（${orderNumber}）`);
      const text = mails[0].Text;
      const lead = text.indexOf(RETURN_MAIL.refundLead(orderNumber));
      const receivedLine = text.indexOf(RETURN_MAIL.received1(label));
      expect(lead).toBeGreaterThanOrEqual(0);
      expect(receivedLine).toBeGreaterThan(lead);
      expect(text).not.toContain(RETURN_MAIL.notShipping);
    });
  });
}
