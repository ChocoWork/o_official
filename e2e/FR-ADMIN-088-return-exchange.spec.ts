/**
 * FR-ADMIN-088 交換の品（在庫から・作って送る・在庫不足・手数料のお支払い待ち・支払いを待たずに送る・発送）
 * 対応 FREQ: FREQ-465（AC-01〜AC-07）、FREQ-467（AC-04・AC-05）、FREQ-469（AC-03・AC-05）
 *
 * 画面（受け取りの画面の交換の品・手数料の画面・発送の画面の交換の印）は窓口の答えを差し替えて確かめ、交換の品の行・在庫の台帳・注文の状態・
 * 手数料のお支払い待ち・メールは、窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼んで確かめる（実装計画 P11）。
 * 交換の色・サイズは、同じ商品の別の色・サイズを手元の DB に足して使う（addVariant）。理由は、その理由の設定の「在庫の無い交換」で選ぶ
 * （最初の値: 破損・不良は作って送る、サイズが小さいは受けない。試験は設定を書き換えない）。
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import {
  createFulfillment,
  expectDbError,
  orderState,
  recordCompletion,
  runWorkerUntil,
  variantStockState,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder,
  fulfillJson,
  mockOrderList,
  openOrderTab,
  orderNumberOf,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  RETURN_MAIL,
  RETURN_TEXT,
  UNIT_STATES,
  addVariant,
  chooseRefundChoice,
  confirmButton,
  createReturnInDb,
  createShippedOrder,
  exchangeItemRows,
  exchangeMaterialLine,
  exchangeOf,
  exchangeOrderLine,
  formatYen,
  lineProgressOf,
  mockReturnRoutes,
  newReturnRouteState,
  openOperationDialog,
  openReceiveDialog,
  openReturnsDialog,
  orderWithReturns,
  receiptUnitRows,
  receiveReturnInDb,
  recordFeePaymentInDb,
  releaseExchangeInDb,
  returnCard,
  returnDetailOf,
  returnLabelOf,
  returnLedger,
  returnLineOf,
  returnRowOf,
  returnSummaryOf,
  returnSummaryRow,
  returnsDialogName,
  sentReturnMailCount,
  setUnitState,
  waitForMails,
  type ReturnRouteState,
} from './return-test-utils';
import type { OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const ORDER_ID = 'a8b2c3d4-0088-4000-8000-000000000088';
const SHIRT = 'c8b2c3d4-0000-4000-8000-000000000001';
const SKIRT = 'c8b2c3d4-0000-4000-8000-000000000002';
const EXCHANGE_ITEM = 'e8b2c3d4-0000-4000-8000-000000000001';
const LINE_A = 'd8b2c3d4-0000-4000-8000-000000000001';
const LINE_B = 'd8b2c3d4-0000-4000-8000-000000000002';
const RETURN_ID = 'b8b2c3d4-0000-4000-8000-000000000001';
const LABEL = returnLabelOf(ORDER_ID, 1);
const RECEIPT = {
  id: '00000000-0000-4000-8000-0000000000e8',
  kind: 'receive' as const,
  refundChoice: 'none' as const,
  createdAt: '2026-10-11T01:00:00.000Z',
  actorEmail: 'admin@example.com',
};

/** 一覧の窓口と返品の窓口を差し替えて、ORDER タブを開く */
async function openList(page: Page, returns: ReturnType<typeof returnDetailOf>[], summary: Parameters<typeof returnSummaryOf>[0]): Promise<ReturnRouteState> {
  const state = newReturnRouteState({ orderId: ORDER_ID, returns, returnableUnits: 0, refundableAmount: 20_000 });
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => [orderWithReturns({ id: ORDER_ID, summary: returnSummaryOf(summary) })]);
  await mockReturnRoutes(page, ORDER_ID, state);
  await openOrderTab(page);
  return state;
}

/** 受け取り待ちの返品1つ（交換の行を渡す。手数料を使う時は fees）の受け取りの画面まで開く */
async function openExchangeReceive(page: Page, lines: OrderReturnLineDetail[], fees?: { exchangeFee: number; exchangeShippingFee: number }) {
  const detail = returnDetailOf({ orderId: ORDER_ID, id: RETURN_ID, lines, fees });
  const state = await openList(page, [detail], {
    orderId: ORDER_ID,
    displayStatus: 'in_progress',
    marks: ['awaiting_items'],
    nextAction: 'receive',
    hasReturnable: false,
  });
  await openReturnsDialog(page, ORDER_ID, '受け取る');
  const dialog = await openReceiveDialog(page, ORDER_ID, LABEL);
  return { state, dialog };
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-088 return exchange (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('受け取りの画面の「交換の品」の欄に、交換の色・サイズ・数と「在庫から（在庫 n）」「作って送る（お届けの目安 n日）」が出て、確定のボタンが交換の言葉になる', async ({ page }) => {
      // FREQ-465-AC-01
      const stockLine = returnLineOf({
        id: LINE_A,
        orderItemId: SHIRT,
        itemName: 'E2Eシャツ',
        exchange: exchangeOf({ variantId: 9102, size: 'L', method: 'stock', stockQuantity: 3, outOfStockExchange: 'decline' }),
      });
      const makeLine = returnLineOf({
        id: LINE_B,
        orderItemId: SKIRT,
        itemName: 'E2Eスカート',
        exchange: exchangeOf({ variantId: 9103, size: 'XL', method: 'make', stockQuantity: 0, madeToOrderLeadDays: 5, outOfStockExchange: 'make' }),
      });
      const { state, dialog } = await openExchangeReceive(page, [stockLine, makeLine]);

      // 届いた品を選ぶと、「交換の品」の欄に、交換先の色・サイズと数と方法が出る
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      const exchange = dialog.getByRole('region', { name: RETURN_TEXT.exchangeHeading, exact: true });
      await expect(
        exchange.getByRole('group', { name: 'E2Eシャツ（ホワイト / L） × 1', exact: true }).getByText(RETURN_TEXT.stockOf(3)),
      ).toBeVisible();
      await expect(
        exchange.getByRole('group', { name: 'E2Eスカート（ホワイト / XL） × 1', exact: true }).getByText(RETURN_TEXT.makeOf(5)),
      ).toBeVisible();
      // 返金の品が無いので、返金の欄は出ない。手数料も付かないので、お支払い待ちの見込みも出ない
      await expect(dialog.getByRole('group', { name: '返金', exact: true })).toHaveCount(0);
      await expect(dialog.getByText('お支払い待ち', { exact: false })).toHaveCount(0);

      await confirmButton(dialog, RETURN_TEXT.receiveAllExchange).click();
      await expect.poll(() => state.posts.receive.length).toBe(1);
      // 返金の品が無い受け取りなので、返金の選びは「なし」
      expect(state.posts.receive[0].body).toMatchObject({ refundChoice: 'none' });
    });

    test('交換だけの受け取りで手数料が付く時は、押す前に「お支払い待ち ￥n（交換の品は、お支払いを確かめてから送ります）」が出る', async ({ page }) => {
      // FREQ-467-AC-04
      const line = returnLineOf({
        id: LINE_A,
        orderItemId: SHIRT,
        itemName: 'E2Eシャツ',
        exchange: exchangeOf({ variantId: 9102, size: 'L', method: 'stock', stockQuantity: 3 }),
      });
      const { state, dialog } = await openExchangeReceive(page, [line], { exchangeFee: 500, exchangeShippingFee: 300 });

      await setUnitState(dialog, 0, UNIT_STATES.keep);
      // 返金の品が無いので、付く手数料の合計（交換の手数料 500円 + 交換の送料 300円）がお支払い待ちになる
      await expect(dialog.getByText(RETURN_TEXT.awaitingPayment(formatYen(800)))).toBeVisible();

      await confirmButton(dialog, RETURN_TEXT.receiveAllExchange).click();
      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].body).toMatchObject({ refundChoice: 'none' });
    });

    test('在庫が足りない交換は、設定が「作って送る」なら理由の文が出て、「受けない」なら店長が「作って送る」を選べて、窓口へ届く', async ({ page }) => {
      // FREQ-465-AC-02
      const declined = returnLineOf({
        id: LINE_A,
        orderItemId: SHIRT,
        itemName: 'E2Eシャツ',
        exchange: exchangeOf({ variantId: 9102, size: 'L', method: 'stock', stockQuantity: 0, outOfStockExchange: 'decline' }),
      });
      const automatic = returnLineOf({
        id: LINE_B,
        orderItemId: SKIRT,
        itemName: 'E2Eスカート',
        exchange: exchangeOf({ variantId: 9103, size: 'XL', method: 'stock', stockQuantity: 0, madeToOrderLeadDays: 4, outOfStockExchange: 'make' }),
      });
      const { state, dialog } = await openExchangeReceive(page, [declined, automatic]);

      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      // 設定が「作って送る」の品は、自動で作って送るに変わる旨が出て、選びは「作って送る」が最初の値（店長には「返金に変える」も出る。
      // 仕様書 6-5「店長は返金に変えることもできる」）。「受けない」の品は、店長が選ぶまで確定できない
      const exchange = dialog.getByRole('region', { name: RETURN_TEXT.exchangeHeading, exact: true });
      const automaticRow = exchange.getByRole('group', { name: 'E2Eスカート（ホワイト / XL） × 1', exact: true });
      const declinedRow = exchange.getByRole('group', { name: 'E2Eシャツ（ホワイト / L） × 1', exact: true });
      await expect(automaticRow.getByText(RETURN_TEXT.stockMake)).toBeVisible();
      await expect(automaticRow.getByRole('radio', { name: '作って送る', exact: true })).toBeChecked();
      await expect(automaticRow.getByRole('radio', { name: '返金に変える', exact: true })).toBeVisible();
      await expect(declinedRow.getByText(RETURN_TEXT.stockDeclineManager)).toBeVisible();
      await expect(declinedRow.getByRole('radio', { name: '作って送る', exact: true })).not.toBeChecked();
      // 選ぶまでは確定できない
      await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
      await declinedRow.getByRole('radio', { name: '作って送る', exact: true }).check();
      await expect(dialog.locator('button[type="submit"]')).toBeEnabled();

      await confirmButton(dialog, RETURN_TEXT.receiveAllExchange).click();
      await expect.poll(() => state.posts.receive.length).toBe(1);
      // 自動で作って送るの品は最初の値のままなので、選びは届かない（make の理由の行に送れるのは「返金に変える」だけ）
      expect(state.posts.receive[0].body).toMatchObject({ exchangeOverrides: [{ returnLineId: LINE_A, action: 'make' }] });
    });

    test('在庫が足りず自動で作って送るになる品も、店長は「返金に変える」を選べて、その品は返金の品になり、窓口へ返金に変える選びと相談が届く', async ({ page }) => {
      // FREQ-465-AC-02
      const automatic = returnLineOf({
        id: LINE_B,
        orderItemId: SKIRT,
        itemName: 'E2Eスカート',
        exchange: exchangeOf({ variantId: 9103, size: 'XL', method: 'stock', stockQuantity: 0, madeToOrderLeadDays: 4, outOfStockExchange: 'make' }),
      });
      const { state, dialog } = await openExchangeReceive(page, [automatic]);
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      const row = dialog
        .getByRole('region', { name: RETURN_TEXT.exchangeHeading, exact: true })
        .getByRole('group', { name: 'E2Eスカート（ホワイト / XL） × 1', exact: true });
      await expect(row.getByRole('radio', { name: '作って送る', exact: true })).toBeChecked();

      await row.getByRole('radio', { name: '返金に変える', exact: true }).check();
      // 返金の品になったので、返金の欄が出る。額は相談してから決める
      await chooseRefundChoice(dialog, 'consult');
      await confirmButton(dialog, RETURN_TEXT.consultButton).click();

      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].body).toMatchObject({
        refundChoice: 'consult',
        exchangeOverrides: [{ returnLineId: LINE_B, action: 'refund' }],
      });
    });

    test('発送の画面で交換の品に「交換の品」の印と手数料待ちの知らせが出て、手数料待ちの断りの文は発送の画面の中に出る', async ({ page }) => {
      // FREQ-465-AC-03
      const state = { onHold: 1, posts: 0 };
      await mockAdminSessionAs(page, 'admin');
      await mockOrderList(page, () => [
        adminOrder({
          id: ORDER_ID,
          status: '発送準備中',
          orderStatus: 'paid',
          items: [exchangeOrderLine({ id: EXCHANGE_ITEM, name: 'E2Eシャツ', color: 'ホワイト', size: 'L', quantity: 1, readyUnshipped: 1 })],
        }),
      ]);
      await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments`, async (route: Route) => {
        if (route.request().method() === 'GET') {
          await fulfillJson(
            route,
            shipMaterials({ orderId: ORDER_ID, lines: [exchangeMaterialLine({ orderItemId: EXCHANGE_ITEM, onHold: state.onHold })] }),
          );
          return;
        }
        state.posts += 1;
        await fulfillJson(route, { error: RETURN_TEXT.shipHoldRefusal, code: 'fulfillment_exchange_on_hold' }, 409);
      });
      await openOrderTab(page);
      await page.getByRole('button', { name: '発送済みにする' }).click();
      const dialog = page.getByRole('dialog', { name: '発送済みにする' });

      // 手数料のお支払いを待っている交換の品: 印と知らせが出て、送れる数は0
      await expect(dialog.getByText('交換の品', { exact: true })).toBeVisible();
      await expect(dialog.getByText(RETURN_TEXT.shipHold(1))).toBeVisible();
      await expect(dialog.getByLabel('今回送る数')).toHaveValue('0');
      await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // お支払い待ちが始まる前に開いた画面で押した時: 窓口の断りの文が画面の中に出る
      state.onHold = 0;
      await page.getByRole('button', { name: '発送済みにする' }).click();
      const again = page.getByRole('dialog', { name: '発送済みにする' });
      await expect(again.getByText('交換の品', { exact: true })).toBeVisible();
      await expect(again.getByText(RETURN_TEXT.shipHold(1))).toHaveCount(0);
      await again.getByLabel('追跡番号').fill('E2E-HOLD');
      await again.getByRole('button', { name: '発送する' }).click();
      await expect(again.getByRole('alert').filter({ hasText: RETURN_TEXT.shipHoldRefusal })).toBeVisible();
      expect(state.posts).toBe(1);
      await expect(again).toBeVisible();
    });

    test('手数料のお支払い待ちの返品に、店長だけの「手数料の受け取りを記録する」と「支払いを待たずに送る」が出て、それぞれの画面から窓口へ届く', async ({ page }) => {
      // FREQ-465-AC-06
      const detail = returnDetailOf({
        orderId: ORDER_ID,
        id: RETURN_ID,
        marks: ['awaiting_fee'],
        firstReceiptDone: true,
        firstExchangeReceiptDone: true,
        fees: { exchangeFee: 500, exchangeShippingFee: 300, feeDueAmount: 800 },
        receipts: [RECEIPT],
        lines: [
          returnLineOf({
            id: LINE_A,
            orderItemId: SHIRT,
            itemName: 'E2Eシャツ',
            exchange: exchangeOf({ method: 'stock' }),
            progress: { notRestocked: 1, exchanged: 1 },
          }),
        ],
        exchangeItems: [
          { orderItemId: EXCHANGE_ITEM, itemName: 'E2Eシャツ', color: 'ホワイト', size: 'L', quantity: 1, fulfillmentType: 'stock', shipped: 0 },
        ],
      });
      const state = await openList(page, [detail], { orderId: ORDER_ID, displayStatus: 'in_progress', marks: ['awaiting_fee'], hasReturnable: false });
      const returns = await openReturnsDialog(page, ORDER_ID);
      await expect(returnCard(returns, LABEL).getByText(`お支払い待ち ${formatYen(800)}`)).toBeVisible();

      // 手数料の受け取りを記録する: 確かめの文・メモの欄。「戻る」では何も送らない
      const fee = await openOperationDialog(page, ORDER_ID, LABEL, '手数料の受け取りを記録する', RETURN_TEXT.feeTitle);
      await expect(fee.getByText(RETURN_TEXT.feeBody(formatYen(800)))).toBeVisible();
      await fee.getByRole('button', { name: '戻る', exact: true }).click();
      expect(state.posts['fee-payment']).toHaveLength(0);
      const feeAgain = await openOperationDialog(page, ORDER_ID, LABEL, '手数料の受け取りを記録する', RETURN_TEXT.feeTitle);
      await expect(feeAgain.getByRole('button', { name: RETURN_TEXT.feeWaiveButton, exact: true })).toBeVisible();
      await feeAgain.getByRole('textbox', { name: RETURN_TEXT.feeMemoLabel, exact: true }).fill('銀行振込');
      await feeAgain.getByRole('button', { name: RETURN_TEXT.feeRecordButton, exact: true }).click();
      await expect.poll(() => state.posts['fee-payment'].length).toBe(1);
      expect(state.posts['fee-payment'][0].returnId).toBe(RETURN_ID);
      expect(state.posts['fee-payment'][0].body).toMatchObject({ note: '銀行振込', waive: false });

      // いただかないで終える（実装計画 P27。仕様書 6-4「額を0に直す」）: 同じ画面のもう1つのボタン。窓口へ waive: true が届き、知らせが出る
      const feeWaive = await openOperationDialog(page, ORDER_ID, LABEL, '手数料の受け取りを記録する', RETURN_TEXT.feeTitle);
      await feeWaive.getByRole('button', { name: RETURN_TEXT.feeWaiveButton, exact: true }).click();
      await expect.poll(() => state.posts['fee-payment'].length).toBe(2);
      expect(state.posts['fee-payment'][1].returnId).toBe(RETURN_ID);
      expect(state.posts['fee-payment'][1].body).toMatchObject({ waive: true });
      await expect(
        page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true }).getByRole('status'),
      ).toContainText(RETURN_TEXT.feeWaivedNotice);

      // 支払いを待たずに送る: 確かめの文
      const release = await openOperationDialog(page, ORDER_ID, LABEL, '支払いを待たずに送る', RETURN_TEXT.releaseTitle);
      await expect(release.getByText(RETURN_TEXT.releaseBody)).toBeVisible();
      await release.getByRole('button', { name: '支払いを待たずに送る', exact: true }).click();
      await expect.poll(() => state.posts['release-exchange'].length).toBe(1);
      expect(state.posts['release-exchange'][0].returnId).toBe(RETURN_ID);
    });

    test('在庫から交換する受け取りは、交換の品の行（値段0・元の支払額つき）を足して在庫を確保し、注文を支払い済みに戻す。送ると発送済みに進む（手元の DB）', async () => {
      // FREQ-465-AC-04
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `exch-stock-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
        expect((await orderState(db, fx.orderId)).status).toBe('shipped');
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }] });

        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
        });
        expect(received).toMatchObject({ returnStatus: 'closed', feeDueAmount: 0, refundId: null });
        expect(received.exchangeOrderItemIds).toHaveLength(1);

        // 交換の品の行: 値段0・元の品の支払額を持つ・在庫から
        const [exchange] = await exchangeItemRows(db, fx.orderId);
        expect(exchange).toMatchObject({
          id: received.exchangeOrderItemIds[0],
          quantity: 1,
          item_price: 0,
          line_total: 0,
          line_kind: 'exchange',
          fulfillment_type: 'stock',
          exchange_paid_amount: PRICE,
        });
        expect(Number(exchange.variant_id)).toBe(variantL);
        // 在庫の台帳 exchange の −1 で確保し、元の品は戻さない（台帳に return は無い）
        expect(await returnLedger(db, fx.orderId)).toEqual([
          { reason: 'exchange', delta: -1, return_id: created.returnId, variant_id: variantL },
        ]);
        expect((await variantStockState(db, variantL)).stock).toBe(1);
        // 発送済みの注文に未発送ができたので、支払い済みに戻る。全部を送った時の値は空になる
        expect(await orderState(db, fx.orderId)).toMatchObject({ status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null });

        // 交換の品を送ると、発送済みに進む
        const shipped = await createFulfillment(db, fx.orderId, fx.actorId, {
          trackingNumber: 'E2E-EXCH-1',
          notify: false,
          lines: [{ orderItemId: exchange.id, quantity: 1 }],
        });
        expect(shipped).toMatchObject({ completesOrder: true, orderStatus: 'shipped' });
        expect((await orderState(db, fx.orderId)).status).toBe('shipped');
      });
    });

    test('作って送る交換は台帳を動かさず、仕上がりを記録するまで送れない。在庫不足で設定が「作って送る」なら自動で作って送るに変わる（手元の DB）', async () => {
      // FREQ-465-AC-05
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `exch-make-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 0 });

        // 最初から「作って送る」: 台帳は動かず、受注生産の行になる。仕上がりを記録してから送れる
        const planned = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'make' } }],
        });
        const first = await receiveReturnInDb(db, planned.returnId, fx.actorId, {
          units: [{ lineId: planned.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
        });
        const [made] = await exchangeItemRows(db, fx.orderId);
        expect(made).toMatchObject({ id: first.exchangeOrderItemIds[0], fulfillment_type: 'backorder', line_kind: 'exchange' });
        expect(await returnLedger(db, fx.orderId)).toEqual([]);
        await expectDbError(
          createFulfillment(db, fx.orderId, fx.actorId, { trackingNumber: 'E2E-MAKE-0', notify: false, lines: [{ orderItemId: made.id, quantity: 1 }] }),
          'QUANTITY_EXCEEDS_READY',
        );
        await recordCompletion(db, fx.orderId, fx.actorId, [{ orderItemId: made.id, quantity: 1 }]);
        expect(
          await createFulfillment(db, fx.orderId, fx.actorId, { trackingNumber: 'E2E-MAKE-1', notify: false, lines: [{ orderItemId: made.id, quantity: 1 }] }),
        ).toMatchObject({ completesOrder: true, orderStatus: 'shipped' });

        // 「在庫から」の予定でも、在庫が足りず、理由（破損・不良）の設定が「作って送る」なら、自動で作って送るに変わる
        const automatic = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, reason: 'defective', exchange: { variantId: variantL, method: 'stock' } }],
        });
        const second = await receiveReturnInDb(db, automatic.returnId, fx.actorId, {
          units: [{ lineId: automatic.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
        });
        const rows = await exchangeItemRows(db, fx.orderId);
        expect(rows.find((row) => row.id === second.exchangeOrderItemIds[0])).toMatchObject({ fulfillment_type: 'backorder' });
        expect(await receiptUnitRows(db, second.receiptId)).toEqual([
          { disposition: 'not_restocked', quantity: 1, resolution: 'exchange', exchange_method: 'make' },
        ]);
        expect(await returnLedger(db, fx.orderId)).toEqual([]);
      });
    });

    test('在庫が足りず設定が「受けない」の交換は、店長の選びが無いと断られ、「作って送る」か「返金に変える」を選んだ時だけ受け取れる（手元の DB）', async () => {
      // FREQ-465-AC-05
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `exch-decline-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 0 });
        // サイズが小さい: 在庫の無い交換は受けない（最初の値）
        const first = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
        });
        const units = [{ lineId: first.lineIds[shirt], disposition: 'not_restocked' as const, quantity: 1 }];

        await expectDbError(receiveReturnInDb(db, first.returnId, fx.actorId, { units, choice: 'none' }), 'RETURN_EXCHANGE_OUT_OF_STOCK');
        expect(await exchangeItemRows(db, fx.orderId)).toEqual([]);
        // 店長が「作って送る」を選ぶと受けられる
        const made = await receiveReturnInDb(db, first.returnId, fx.actorId, {
          units,
          choice: 'none',
          exchangeOverrides: [{ lineId: first.lineIds[shirt], action: 'make' }],
        });
        expect(made.exchangeOrderItemIds).toHaveLength(1);
        expect((await exchangeItemRows(db, fx.orderId))[0]).toMatchObject({ fulfillment_type: 'backorder' });

        // 「返金に変える」を選ぶと、交換の品は足さず、返金の品として相談の受け取りになる
        const second = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
        });
        const changed = await receiveReturnInDb(db, second.returnId, fx.actorId, {
          units: [{ lineId: second.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'consult',
          exchangeOverrides: [{ lineId: second.lineIds[shirt], action: 'refund' }],
        });
        expect(changed.exchangeOrderItemIds).toEqual([]);
        expect(await exchangeItemRows(db, fx.orderId)).toHaveLength(1);
        expect(await receiptUnitRows(db, changed.receiptId)).toEqual([
          { disposition: 'not_restocked', quantity: 1, resolution: 'refund', exchange_method: null },
        ]);
        expect((await lineProgressOf(db, second.returnId))[second.lineIds[shirt]]).toMatchObject({ refund_waiting: 1 });
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ has_returnable: false });
      });
    });

    test('手数料のお支払い待ちの交換の品は送れず、手数料の受け取りを記録すると送れて返品が完了する。支払いを待たずに送ると送れるが、手数料は残って返品は完了しない。いただかないで終えると、返品が完了し送れて、決着した額は fee_settled_amount に残る（手元の DB）', async () => {
      // FREQ-465-AC-07, FREQ-467-AC-04, FREQ-467-AC-05
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `exch-fee-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 4 });
        const exchangeFee = { exchangeFee: 500, exchangeShippingFee: 300 };
        const ship = (itemId: string, tracking: string) =>
          createFulfillment(db, fx.orderId, fx.actorId, { trackingNumber: tracking, notify: false, lines: [{ orderItemId: itemId, quantity: 1 }] });

        // 返品A: 交換だけの受け取り。手数料（500円 + 300円）は引く返金が無いので、そのままお支払い待ちになる
        const a = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          ...exchangeFee,
        });
        const receivedA = await receiveReturnInDb(db, a.returnId, fx.actorId, {
          units: [{ lineId: a.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
        });
        expect(receivedA).toMatchObject({ feeDueAmount: 800, returnStatus: 'open' });
        expect(await returnRowOf(db, a.returnId)).toMatchObject({ fee_due_amount: 800, fee_received_at: null, exchange_released_at: null });
        expect((await returnSummaryRow(db, fx.orderId)).marks).toContain('awaiting_fee');
        const itemA = receivedA.exchangeOrderItemIds[0];
        await expectDbError(ship(itemA, 'E2E-HOLD-A'), 'FULFILLMENT_EXCHANGE_ON_HOLD');

        // 手数料の受け取りを記録すると、送れて、返品は完了する
        await recordFeePaymentInDb(db, a.returnId, fx.actorId, '銀行振込');
        expect(await returnRowOf(db, a.returnId)).toMatchObject({ status: 'closed' });
        expect((await returnRowOf(db, a.returnId)).fee_received_at).not.toBeNull();
        expect(await ship(itemA, 'E2E-HOLD-A')).toMatchObject({ completesOrder: true, orderStatus: 'shipped' });

        // 返品B: 同じ形。支払いを待たずに送ると送れるが、手数料は残り、返品は完了しない
        const b = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          ...exchangeFee,
        });
        const receivedB = await receiveReturnInDb(db, b.returnId, fx.actorId, {
          units: [{ lineId: b.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
        });
        const itemB = receivedB.exchangeOrderItemIds[0];
        await expectDbError(ship(itemB, 'E2E-HOLD-B'), 'FULFILLMENT_EXCHANGE_ON_HOLD');
        await releaseExchangeInDb(db, b.returnId, fx.actorId);
        expect(await ship(itemB, 'E2E-HOLD-B')).toMatchObject({ completesOrder: true, orderStatus: 'shipped' });
        const rowB = await returnRowOf(db, b.returnId);
        expect(rowB).toMatchObject({ status: 'open', fee_due_amount: 800, fee_received_at: null });
        expect(rowB.exchange_released_at).not.toBeNull();
        // 手数料の受け取りを記録するまで、返品Bは完了にならない
        await recordFeePaymentInDb(db, b.returnId, fx.actorId, null);
        expect(await returnRowOf(db, b.returnId)).toMatchObject({ status: 'closed', fee_due_amount: 0, fee_settled_amount: 800, fee_waived: false });

        // 返品C: 同じ形。「いただかないで終える」（実装計画 P27）と、返品は完了し、交換の品を送れる。
        // 決着した額（800円）は fee_settled_amount に移り、fee_due_amount は0になる。受け取った物ではなく「いただかないことにした」印（fee_waived）が付く
        const c = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          ...exchangeFee,
        });
        const receivedC = await receiveReturnInDb(db, c.returnId, fx.actorId, {
          units: [{ lineId: c.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
        });
        const itemC = receivedC.exchangeOrderItemIds[0];
        await expectDbError(ship(itemC, 'E2E-HOLD-C'), 'FULFILLMENT_EXCHANGE_ON_HOLD');
        expect(await recordFeePaymentInDb(db, c.returnId, fx.actorId, '常連のお客様のため', true)).toBe('closed');
        const rowC = await returnRowOf(db, c.returnId);
        expect(rowC).toMatchObject({ status: 'closed', fee_due_amount: 0, fee_settled_amount: 800, fee_waived: true });
        expect(rowC.fee_received_at).not.toBeNull();
        expect((await returnSummaryRow(db, fx.orderId)).marks).not.toContain('awaiting_fee');
        expect(await ship(itemC, 'E2E-HOLD-C')).toMatchObject({ completesOrder: true, orderStatus: 'shipped' });
      });
    });

    test('交換の品を受け取ったお知らせに、交換の品・手数料のお支払い待ちの文が入る（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-03
      test.setTimeout(180_000);
      const { fx, label } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `exch-mail-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
        const created = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          exchangeFee: 500,
          exchangeShippingFee: 300,
        });
        await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
          notify: true,
        });
        return { fx, label: returnLabelOf(fx.orderId, created.number) };
      });

      const mails = await waitForMails(request, fx.email, RETURN_MAIL.received);
      await runWorkerUntil(request, async () => (await sentReturnMailCount(fx.orderId, 'return_received')) >= 1, '返品をお受け取りしましたが送信済みになること');
      expect(mails).toHaveLength(1);
      expect(mails[0].Subject).toBe(`【Le Fil des Heures】${RETURN_MAIL.received}（${orderNumberOf(fx.orderId)}）`);
      const text = mails[0].Text;
      expect(text).toContain(RETURN_MAIL.received1(label));
      expect(text).toContain('交換の品をお送りします:');
      expect(text).toContain('・E2Eシャツ（ホワイト / L） × 1');
      expect(text).toContain(RETURN_MAIL.payLater(formatYen(800)));
      // 返金は無いので、返金の額の案内（相談の文）は入らない
      expect(text).not.toContain(RETURN_MAIL.consult);
    });

    test('作って送る交換の品がある受け取りのお知らせに「お作りしてお送りします。」が入り、商品に目安の日数がある時だけ「お届けの目安は n日ほどです。」が続く（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-03
      test.setTimeout(240_000);
      const leadDays = 12;
      // 作って送る交換の受け取りを、目安の日数がある商品と、無い商品（空）で1つずつ作る
      const receiveMake = (tag: string, days: number | null) =>
        withLocalDb(async (db) => {
          const fx = await createShippedOrder(db, `exch-make-${tag}-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }]);
          const shirt = fx.orderItemIds[0];
          const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 0 });
          if (days !== null) await db.query('update public.items set made_to_order_lead_days = $2 where id = $1', [fx.itemId, days]);
          const created = await createReturnInDb(db, fx, {
            lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'make' } }],
          });
          await receiveReturnInDb(db, created.returnId, fx.actorId, {
            units: [{ lineId: created.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
            choice: 'none',
            notify: true,
          });
          return { fx, label: returnLabelOf(fx.orderId, created.number) };
        });
      const withDays = await receiveMake('days', leadDays);
      const withoutDays = await receiveMake('nodays', null);

      const [daysMail] = await waitForMails(request, withDays.fx.email, RETURN_MAIL.received);
      const row = daysMail.Text.indexOf('・E2Eシャツ（ホワイト / L） × 1');
      expect(daysMail.Text).toContain(RETURN_MAIL.received1(withDays.label));
      expect(daysMail.Text).toContain('交換の品をお送りします:');
      expect(row).toBeGreaterThan(0);
      // 目安の一文は、作って送る品の行の後に入る。手数料は無いので、お支払い待ちの文は入らない
      expect(daysMail.Text.indexOf(RETURN_MAIL.makeNote(leadDays))).toBeGreaterThan(row);
      expect(daysMail.Text).not.toContain('のお支払いを確かめてからお送りします');

      // 目安の日数が無い商品は「お作りしてお送りします。」だけで、日数は書かない（実装計画 C-6）
      const [plainMail] = await waitForMails(request, withoutDays.fx.email, RETURN_MAIL.received);
      expect(plainMail.Text).toContain(RETURN_MAIL.received1(withoutDays.label));
      expect(plainMail.Text).toContain(RETURN_MAIL.makeShort);
      expect(plainMail.Text).not.toContain('お届けの目安');
    });

    test('交換の品を送った発送のお知らせに、交換の一文が入り、交換の品の行の末尾に「（交換の品）」が付く（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-05
      test.setTimeout(180_000);
      const fx = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `exch-ship-mail-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }]);
        // 交換の品の行の品名は、受け取りの時に商品の名前（items.name）を写す（Task 3）。道具が作る商品の名前は fx-… なので、
        // 発送のお知らせの行を品名で探せるよう、元の品と同じ名前にしておく（商品の名前に一意の決まりは無い）
        await db.query('update public.items set name = $2 where id = $1', [fx.itemId, 'E2Eシャツ']);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
        const created = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          notify: false,
        });
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
          notify: false,
        });
        // お知らせを入れて、交換の品だけを送る
        await createFulfillment(db, fx.orderId, fx.actorId, {
          trackingNumber: 'E2E-EXCH-MAIL',
          notify: true,
          lines: [{ orderItemId: received.exchangeOrderItemIds[0], quantity: 1 }],
        });
        return fx;
      });

      const mails = await waitForMails(request, fx.email, RETURN_MAIL.shipped);
      expect(mails).toHaveLength(1);
      const text = mails[0].Text;
      expect(text).toContain('E2E-EXCH-MAIL');
      const sentence = text.indexOf(RETURN_MAIL.exchangeShipped);
      expect(sentence).toBeGreaterThanOrEqual(0);
      // 交換の一文は、発送の品の行より前に入る。その行の末尾に「（交換の品）」が付く
      expect(text.indexOf('E2Eシャツ')).toBeGreaterThan(sentence);
      expect(text).toMatch(/E2Eシャツ[^\n]*x1[^\n]*（交換の品）/);
    });
  });
}
