/**
 * FR-ADMIN-090 サポートの人の受け取り
 * 対応 FREQ: FREQ-464（AC-11〜AC-13）、FREQ-465（AC-02 のサポートの分）、FREQ-469（AC-06）、FREQ-471（AC-06）
 *
 * サポートの人（役割 supporter）は、返品の受け取りはできるが、返金に関わる操作（今返金・額を直す・額を決めて返金・手数料の受け取りの記録・
 * 支払いを待たずに送る）はできない。画面は窓口の答えを差し替えて確かめ、DB の関数の断り・店への知らせ・店長の返金は、
 * 窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼んで確かめる（実装計画 P11）。窓口の権限の組合せは単体の試験（return-routes）が確かめる。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  expectDbError,
  recordRefundResult,
  runWorkerUntil,
  runWorkerOnce,
  sentOutboxCount,
  variantStockState,
  withLocalDb,
} from './order-email-test-utils';
import { mockOrderList, openOrderTab, orderNumberOf, viewports } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  RETURN_MAIL,
  RETURN_TEXT,
  UNIT_STATES,
  addVariant,
  confirmButton,
  createReturnInDb,
  createShippedOrder,
  exchangeOf,
  formatYen,
  mockReturnRoutes,
  newReturnRouteState,
  openReceiveDialog,
  openReturnsDialog,
  orderWithReturns,
  receiptRows,
  receiveReturnInDb,
  refundReturnInDb,
  returnCard,
  returnDetailOf,
  returnEmailRows,
  returnLabelOf,
  returnLedger,
  returnLineOf,
  returnSummaryOf,
  returnSummaryRow,
  setUnitState,
  shopAlertsFor,
  waitForMails,
} from './return-test-utils';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const ORDER_ID = 'a0b2c3d4-0090-4000-8000-000000000090';
const SHIRT = 'c0b2c3d4-0000-4000-8000-000000000001';
const LINE = 'd0b2c3d4-0000-4000-8000-000000000001';
const SECOND_LINE = 'd0b2c3d4-0000-4000-8000-000000000002';
const THIRD_LINE = 'd0b2c3d4-0000-4000-8000-000000000003';
const RETURN_ID = 'b0b2c3d4-0000-4000-8000-000000000001';
const SECOND_RETURN_ID = 'b0b2c3d4-0000-4000-8000-000000000002';
const THIRD_RETURN_ID = 'b0b2c3d4-0000-4000-8000-000000000003';
const LABEL = returnLabelOf(ORDER_ID, 1);
const SECOND_LABEL = returnLabelOf(ORDER_ID, 2);
const THIRD_LABEL = returnLabelOf(ORDER_ID, 3);

/** サポートの人として、受け取り待ちの返品（渡した行）の受け取りの画面まで開く */
async function openSupportReceive(page: Page, lines: OrderReturnLineDetail[]) {
  const detail = returnDetailOf({ orderId: ORDER_ID, id: RETURN_ID, lines });
  const state = newReturnRouteState({ orderId: ORDER_ID, returns: [detail], returnableUnits: 0, refundableAmount: 20_000, canRefund: false });
  await mockAdminSessionAs(page, 'supporter');
  await mockOrderList(page, () => [
    orderWithReturns({
      id: ORDER_ID,
      canRefund: false,
      summary: returnSummaryOf({ orderId: ORDER_ID, displayStatus: 'in_progress', marks: ['awaiting_items'], nextAction: 'receive', hasReturnable: false }),
    }),
  ]);
  await mockReturnRoutes(page, ORDER_ID, state);
  await openOrderTab(page);
  await openReturnsDialog(page, ORDER_ID, '受け取る');
  const dialog = await openReceiveDialog(page, ORDER_ID, LABEL);
  return { state, dialog };
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-090 return support receive (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('サポートの人の受け取りの画面は、返金の欄が文だけで、確定のボタンが「受け取りだけ記録する（額は店長が決める）」になり、窓口へ相談が届く', async ({ page }) => {
      // FREQ-464-AC-11
      const { state, dialog } = await openSupportReceive(page, [
        returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ' }),
      ]);
      await setUnitState(dialog, 0, UNIT_STATES.restock);

      await expect(dialog.getByText(RETURN_TEXT.supportRefundNote)).toBeVisible();
      // 返金額の入力も、「計算どおり」の選びも出ない
      await expect(dialog.getByLabel(/^返金額（返せる額/)).toHaveCount(0);
      await expect(dialog.getByRole('radio', { name: RETURN_TEXT.nowOption })).toHaveCount(0);
      await expect(confirmButton(dialog, RETURN_TEXT.supportConsultButton)).toBeVisible();
      await confirmButton(dialog, RETURN_TEXT.supportConsultButton).click();

      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].body).toMatchObject({ refundChoice: 'consult' });
      await expect(
        page.getByRole('dialog', { name: `返品（${orderNumberOf(ORDER_ID)}）`, exact: true }).getByRole('status'),
      ).toContainText(RETURN_TEXT.noticeRecorded);
    });

    test('在庫が足りない交換の品は、サポートの人には「この品は店長が受け取ります。」と出て、受け取りに選べない。自動で作って送るになる品は文だけで、選びは出ない', async ({ page }) => {
      // FREQ-465-AC-02
      const { dialog } = await openSupportReceive(page, [
        returnLineOf({
          id: LINE,
          orderItemId: SHIRT,
          quantity: 1,
          itemName: 'E2Eシャツ',
          exchange: exchangeOf({ method: 'stock', stockQuantity: 0, outOfStockExchange: 'decline' }),
        }),
        returnLineOf({
          id: SECOND_LINE,
          orderItemId: SHIRT,
          quantity: 1,
          itemName: 'E2Eスカート',
          exchange: exchangeOf({ method: 'stock', size: 'XL', stockQuantity: 0, outOfStockExchange: 'make' }),
        }),
      ]);

      await expect(dialog.getByText(RETURN_TEXT.stockDeclineSupport)).toBeVisible();
      // 在庫を超える交換の品の点は、「届いた」にできない。「作って送る」「返金に変える」の選びも出ない（店長だけ）
      await expect(dialog.getByRole('checkbox', { name: '届いた', exact: true })).toHaveCount(2);
      await expect(dialog.getByRole('checkbox', { name: '届いた', exact: true }).first()).toBeDisabled();
      await expect(dialog.getByRole('radio', { name: '作って送る', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('radio', { name: '返金に変える', exact: true })).toHaveCount(0);
      // 自動で作って送るになる品は、サポートの人も「届いた」にできる（選ぶ物が無い）。届いた点の状態を選ぶと、「交換の品」の欄に
      // 文だけが出る（Task 9: 在庫の足りなさは今回受け取る点で数え、交換の品の欄は受け取る点がある行だけに出す）
      await expect(dialog.getByRole('checkbox', { name: '届いた', exact: true }).nth(1)).toBeEnabled();
      await expect(dialog.getByText(RETURN_TEXT.stockMake)).toHaveCount(0);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      await expect(dialog.getByText(RETURN_TEXT.stockMake)).toBeVisible();
      await expect(dialog.getByRole('radio', { name: '作って送る', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('radio', { name: '返金に変える', exact: true })).toHaveCount(0);
    });

    test('サポートの人には、額を決めて返金する・手数料の受け取りの記録・支払いを待たずに送るが出ない。受け取り・取消は出る', async ({ page }) => {
      // FREQ-471-AC-06
      const waiting: OrderReturnDetail = returnDetailOf({
        orderId: ORDER_ID,
        id: RETURN_ID,
        displayStatus: 'refund_waiting',
        marks: [],
        firstReceiptDone: true,
        receipts: [{ id: randomUUID(), kind: 'receive', refundChoice: 'consult', createdAt: '2026-10-11T01:00:00.000Z', actorEmail: 'support@example.com' }],
        lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ', progress: { restocked: 1, refundWaiting: 1 } })],
      });
      const awaitingFee: OrderReturnDetail = returnDetailOf({
        orderId: ORDER_ID,
        id: SECOND_RETURN_ID,
        number: 2,
        marks: ['awaiting_fee'],
        firstReceiptDone: true,
        firstExchangeReceiptDone: true,
        fees: { exchangeFee: 500, exchangeShippingFee: 300, feeDueAmount: 800 },
        receipts: [{ id: randomUUID(), kind: 'receive', refundChoice: 'none', createdAt: '2026-10-11T02:00:00.000Z', actorEmail: 'support@example.com' }],
        lines: [
          returnLineOf({
            id: SECOND_LINE,
            orderItemId: SHIRT,
            quantity: 1,
            itemName: 'E2Eシャツ',
            exchange: exchangeOf({ method: 'stock' }),
            progress: { notRestocked: 1, exchanged: 1 },
          }),
        ],
        exchangeItems: [
          { orderItemId: SHIRT, itemName: 'E2Eシャツ', color: 'ホワイト', size: 'L', quantity: 1, fulfillmentType: 'stock', shipped: 0 },
        ],
      });
      const untouched: OrderReturnDetail = returnDetailOf({
        orderId: ORDER_ID,
        id: THIRD_RETURN_ID,
        number: 3,
        lines: [returnLineOf({ id: THIRD_LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ' })],
      });
      const state = newReturnRouteState({
        orderId: ORDER_ID,
        returns: [waiting, awaitingFee, untouched],
        returnableUnits: 0,
        canRefund: false,
      });
      await mockAdminSessionAs(page, 'supporter');
      await mockOrderList(page, () => [
        orderWithReturns({
          id: ORDER_ID,
          canRefund: false,
          summary: returnSummaryOf({ orderId: ORDER_ID, displayStatus: 'in_progress', marks: ['awaiting_items'], nextAction: 'receive', hasReturnable: false }),
        }),
      ]);
      await mockReturnRoutes(page, ORDER_ID, state);
      await openOrderTab(page);
      const returns = await openReturnsDialog(page, ORDER_ID, '受け取る');

      for (const label of [LABEL, SECOND_LABEL, THIRD_LABEL]) {
        await expect(returnCard(returns, label)).toBeVisible();
        for (const name of ['額を決めて返金する', '手数料の受け取りを記録する', '支払いを待たずに送る']) {
          await expect(returnCard(returns, label).getByRole('button', { name, exact: true }), `${label} の「${name}」`).toHaveCount(0);
        }
      }
      // サポートの人にも出る操作: 受け取る・何も受け取っていない返品の取消
      await expect(returnCard(returns, THIRD_LABEL).getByRole('button', { name: '受け取る', exact: true })).toBeVisible();
      await expect(returnCard(returns, THIRD_LABEL).getByRole('button', { name: RETURN_TEXT.cancelTitle, exact: true })).toBeVisible();
      // お支払い待ちの手数料の額は見える
      await expect(returnCard(returns, SECOND_LABEL).getByText(`お支払い待ち ${formatYen(800)}`)).toBeVisible();
    });

    test('サポートの人の受け取りは、今返金と額の直しを DB の関数が断り、相談なら受け取れて返金待ちになる。店への知らせは1通で、同じ番号の送り直しでも増えない（手元の DB）', async () => {
      // FREQ-464-AC-12, FREQ-471-AC-06
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `support-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        const units = [{ lineId: created.lineIds[shirt], disposition: 'restocked' as const, quantity: 1 }];

        // 今返金も、額を直すことも、サポートの人はできない。断られた受け取りは何も残さない
        await expectDbError(receiveReturnInDb(db, created.returnId, fx.actorId, { units, canRefund: false, choice: 'now' }), 'RETURN_FORBIDDEN');
        await expectDbError(
          receiveReturnInDb(db, created.returnId, fx.actorId, { units, canRefund: false, choice: 'consult', amount: 1_000 }),
          'RETURN_FORBIDDEN',
        );
        expect(await receiptRows(db, created.returnId)).toEqual([]);
        expect(await returnLedger(db, fx.orderId)).toEqual([]);
        expect((await variantStockState(db, fx.variantId)).stock).toBe(0);

        // 相談なら受け取れる。返金の記録は作らず、返金待ちになり、店への知らせの予定が1つ書かれる
        const key = randomUUID();
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, { units, canRefund: false, choice: 'consult', requestKey: key });
        expect(received).toMatchObject({ refundId: null, returnStatus: 'open', shopNoticeEnqueued: true, replayed: false });
        expect((await receiptRows(db, created.returnId))[0]).toMatchObject({ kind: 'receive', refund_choice: 'consult', actor_can_refund: false });
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'refund_waiting', next_action: 'refund' });
        expect((await variantStockState(db, fx.variantId)).stock).toBe(1);

        // 同じ番号で送り直しても、受け取りも店への知らせも増えない
        expect(await receiveReturnInDb(db, created.returnId, fx.actorId, { units, canRefund: false, choice: 'consult', requestKey: key })).toMatchObject({
          receiptId: received.receiptId,
          replayed: true,
        });
        expect(await receiptRows(db, created.returnId)).toHaveLength(1);
        expect((await returnEmailRows(db, fx.orderId)).filter((row) => row.kind === 'return_refund_pending_shop')).toHaveLength(1);
      });
    });

    test('サポートの人の交換の受け取りは、在庫が足りず設定が「受けない」なら断られ、「作って送る」の選びも店長だけができる（手元の DB）', async () => {
      // FREQ-465-AC-02
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `support-exch-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 0 });
        const created = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          notify: false,
        });
        const units = [{ lineId: created.lineIds[shirt], disposition: 'not_restocked' as const, quantity: 1 }];

        await expectDbError(
          receiveReturnInDb(db, created.returnId, fx.actorId, { units, canRefund: false, choice: 'none' }),
          'RETURN_EXCHANGE_OUT_OF_STOCK',
        );
        await expectDbError(
          receiveReturnInDb(db, created.returnId, fx.actorId, {
            units,
            canRefund: false,
            choice: 'none',
            exchangeOverrides: [{ lineId: created.lineIds[shirt], action: 'make' }],
          }),
          'RETURN_FORBIDDEN',
        );
        expect(await receiptRows(db, created.returnId)).toEqual([]);
      });
    });

    test('店への知らせ「返金待ちの返品があります」が1通届き、同じ番号の送り直しでも増えない。店長が額を直して返金すると、お客様に返金のお知らせが1通届く（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-464-AC-13, FREQ-469-AC-06
      test.setTimeout(240_000);
      const context = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `support-mail-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        const units = [{ lineId: created.lineIds[shirt], disposition: 'restocked' as const, quantity: 1 }];
        const key = randomUUID();
        await receiveReturnInDb(db, created.returnId, fx.actorId, { units, canRefund: false, choice: 'consult', requestKey: key, notify: true });
        await receiveReturnInDb(db, created.returnId, fx.actorId, { units, canRefund: false, choice: 'consult', requestKey: key, notify: true });
        return { fx, returnId: created.returnId, label: returnLabelOf(fx.orderId, created.number) };
      });
      const orderNumber = orderNumberOf(context.fx.orderId);

      // 店への知らせ: 1通。もう一度 worker を動かしても増えない
      await runWorkerUntil(request, async () => (await shopAlertsFor(request, orderNumber)).length >= 1, '店への知らせが届くこと');
      await runWorkerOnce(request);
      const alerts = await shopAlertsFor(request, orderNumber);
      expect(alerts).toHaveLength(1);
      // 店への知らせの件名には店の名前を付けない（C-6・Task 6 の composeReturnRefundPendingShop）
      expect(alerts[0].Subject).toBe(`${RETURN_MAIL.shopAlert}（${orderNumber}）`);
      expect(alerts[0].Text).toContain(`返品 ${context.label} の品を受け取りました（受け取った人: サポート）。`);
      expect(alerts[0].Text).toContain('受け取った返金の品:');
      expect(alerts[0].Text).toContain('・E2Eシャツ（ホワイト / M） × 1');
      expect(alerts[0].Text).toContain(`計算どおりの額: ${formatYen(5_000)}`);
      expect(alerts[0].Text).toContain(RETURN_MAIL.shopAlertNext);

      // 店長が額を直して返金する。Stripe が受け付けると、お客様に返金のお知らせが1通届く（返品の書き分け）
      await withLocalDb(async (db) => {
        const refund = await refundReturnInDb(db, context.returnId, context.fx.actorId, { amount: 4_000, notify: true });
        expect(refund).toMatchObject({ amount: 4_000, status: 'awaiting_response' });
        await recordRefundResult(db, refund.refundId as string);
      });
      await runWorkerUntil(request, async () => (await sentOutboxCount(context.fx.orderId, 'refund')) >= 1, '返金のお知らせが送信済みになること');
      const mails = await waitForMails(request, context.fx.email, RETURN_MAIL.refund);
      expect(mails).toHaveLength(1);
      expect(mails[0].Text).toContain(RETURN_MAIL.refundLater(context.label));
      expect(mails[0].Text).toContain(formatYen(4_000));
    });
  });
}
