/**
 * FR-ADMIN-089 お返し（条件に合わない品を、返金も交換もせずにお客様へお返しする）
 * 対応 FREQ: FREQ-466（AC-01〜AC-05）、FREQ-469（AC-04）
 *
 * 画面（受け取りの「お返し」の欄・確かめ）は窓口の答えを差し替えて確かめ、お返しの DB の動き（返金・在庫・数え方）とメールは、
 * 窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼んで確かめる（実装計画 P11）。
 */
import { expect, test, type Page } from '@playwright/test';
import {
  expectDbError,
  mailBodies,
  recordRefundResult,
  runWorkerUntil,
  sentOutboxCount,
  variantStockState,
  withLocalDb,
} from './order-email-test-utils';
import { UUID_PATTERN, mockOrderList, openOrderTab, orderNumberOf, viewports } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  RETURN_MAIL,
  RETURN_TEXT,
  UNIT_STATES,
  confirmButton,
  createReturnInDb,
  createShippedOrder,
  lineProgressOf,
  mockReturnRoutes,
  newReturnRouteState,
  openReceiveDialog,
  openReturnsDialog,
  orderWithReturns,
  receiveReturnInDb,
  returnEmailRows,
  returnLabelOf,
  returnLedger,
  returnLineOf,
  returnDetailOf,
  returnRefundRows,
  returnRowOf,
  returnSummaryOf,
  returnableByItem,
  sentReturnMailCount,
  setUnitState,
  unitTotal,
  waitForMails,
} from './return-test-utils';

const ORDER_ID = 'a9b2c3d4-0089-4000-8000-000000000089';
const SHIRT = 'c9b2c3d4-0000-4000-8000-000000000001';
const LINE = 'd9b2c3d4-0000-4000-8000-000000000001';
const RETURN_ID = 'b9b2c3d4-0000-4000-8000-000000000001';
const LABEL = returnLabelOf(ORDER_ID, 1);
const MESSAGE = 'タグが外れ、着用の跡があったため、お返しします。';

/** 受け取り待ちの返品（シャツ1点）の受け取りの画面まで開く */
async function openReceive(page: Page) {
  const detail = returnDetailOf({
    orderId: ORDER_ID,
    id: RETURN_ID,
    lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ' })],
  });
  const state = newReturnRouteState({ orderId: ORDER_ID, returns: [detail], returnableUnits: 0, refundableAmount: 20_000 });
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => [
    orderWithReturns({
      id: ORDER_ID,
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
  test.describe(`FR-ADMIN-089 return sent back (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('「条件に合わないのでお返しする」を選ぶとお返しの欄が出て、押す前に確かめが出る。確かめの後に、メッセージ・配送業者・伝票番号が窓口へ届く', async ({ page }) => {
      // FREQ-466-AC-01
      const { state, dialog } = await openReceive(page);
      await setUnitState(dialog, 0, UNIT_STATES.sentBack);

      await expect(dialog.getByRole('textbox', { name: RETURN_TEXT.sentBackMessageLabel, exact: true })).toBeVisible();
      await expect(dialog.getByRole('combobox', { name: RETURN_TEXT.sentBackCarrierLabel, exact: true })).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: RETURN_TEXT.sentBackTrackingLabel, exact: true })).toBeVisible();
      await expect(confirmButton(dialog, RETURN_TEXT.receiveAllSentBack)).toBeVisible();
      await dialog.getByRole('textbox', { name: RETURN_TEXT.sentBackMessageLabel, exact: true }).fill(MESSAGE);
      await dialog.getByRole('combobox', { name: RETURN_TEXT.sentBackCarrierLabel, exact: true }).selectOption({ label: 'ヤマト運輸' });
      await dialog.getByRole('textbox', { name: RETURN_TEXT.sentBackTrackingLabel, exact: true }).fill('ABC-123');

      // 押す前の確かめ。「戻る」では何も送らない
      await confirmButton(dialog, RETURN_TEXT.receiveAllSentBack).click();
      await expect(dialog.getByText(RETURN_TEXT.sentBackConfirm)).toBeVisible();
      await dialog.getByRole('button', { name: '戻る', exact: true }).click();
      expect(state.posts.receive).toHaveLength(0);

      await confirmButton(dialog, RETURN_TEXT.receiveAllSentBack).click();
      await dialog.getByRole('button', { name: 'お返しする', exact: true }).click();
      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].returnId).toBe(RETURN_ID);
      expect(state.posts.receive[0].body).toMatchObject({
        refundChoice: 'none',
        notifyCustomer: true,
        sentBackMessage: MESSAGE,
        sentBackCarrier: 'yamato',
        sentBackTrackingNumber: 'ABC-123',
      });
      expect(unitTotal(state.posts.receive[0].body, LINE, 'sent_back')).toBe(1);
      expect(String(state.posts.receive[0].body.requestKey)).toMatch(UUID_PATTERN);
    });

    test('お返しを含む時は、「お客様に知らせる」が入ったまま外せない', async ({ page }) => {
      // FREQ-466-AC-02
      const { dialog } = await openReceive(page);
      const notify = dialog.getByRole('checkbox', { name: RETURN_TEXT.notifyLabel, exact: true });
      await expect(notify).toBeChecked();
      await expect(notify).toBeEnabled();

      await setUnitState(dialog, 0, UNIT_STATES.sentBack);
      await expect(notify).toBeChecked();
      await expect(notify).toBeDisabled();

      // お返しをやめて「在庫に戻す」に替えると、外せるようになる
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await expect(notify).toBeEnabled();
    });

    test('お返しは返金も交換もせず、在庫を動かさない。メッセージが無いと断られ、断られた操作は何も残さない（手元の DB）', async () => {
      // FREQ-466-AC-03
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `sent-back-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        const lineId = created.lineIds[shirt];
        const units = [{ lineId, disposition: 'sent_back' as const, quantity: 1 }];

        await expectDbError(
          receiveReturnInDb(db, created.returnId, fx.actorId, { units, choice: 'none', notify: true }),
          'RETURN_SENT_BACK_MESSAGE_REQUIRED',
        );
        expect((await lineProgressOf(db, created.returnId))[lineId]).toMatchObject({ sent_back: 0, unprocessed: 1 });

        const sent = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units,
          choice: 'none',
          notify: true,
          sentBack: { message: MESSAGE, carrier: 'yamato', trackingNumber: 'ABC-123' },
        });
        // 返金の記録も交換の品も作らず、在庫の台帳も動かさない。品は「お返し」の数になり、返品は完了する
        expect(sent).toMatchObject({ refundId: null, refundAmount: null, exchangeOrderItemIds: [], returnStatus: 'closed', feeDueAmount: 0 });
        expect(await returnRefundRows(db, fx.orderId)).toEqual([]);
        expect(await returnLedger(db, fx.orderId)).toEqual([]);
        expect((await variantStockState(db, fx.variantId)).stock).toBe(0);
        expect((await lineProgressOf(db, created.returnId))[lineId]).toMatchObject({ sent_back: 1, unprocessed: 0, refund_waiting: 0 });
        expect((await returnRowOf(db, created.returnId)).status).toBe('closed');
      });
    });

    test('お返しした品は、同じ品でもう一度返品できない（返品できる数から外れる）（手元の DB）', async () => {
      // FREQ-466-AC-04
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `sent-back-again-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'sent_back', quantity: 1 }],
          choice: 'none',
          notify: true,
          sentBack: { message: MESSAGE },
        });

        // 完了した返品でも、お返しした1点は数え続ける。返品できるのは残りの1点だけ
        expect(await returnableByItem(db, fx.orderId)).toEqual({ [shirt]: 1 });
        await expectDbError(createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }] }), 'RETURN_QUANTITY_EXCEEDS');
        expect(await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }] })).toMatchObject({ number: 2, status: 'open' });
      });
    });

    test('一部をお返しして残りを返金すると、返金のお知らせにお返しの節が入り、お客様へのメールは返金のお知らせの1通だけになる（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-466-AC-05
      test.setTimeout(240_000);
      const { fx, label } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `sent-back-mix-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }], notify: false });
        const lineId = created.lineIds[shirt];
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [
            { lineId, disposition: 'sent_back', quantity: 1 },
            { lineId, disposition: 'restocked', quantity: 1 },
          ],
          choice: 'now',
          notify: true,
          sentBack: { message: MESSAGE, carrier: 'yamato', trackingNumber: 'ABC-123' },
        });
        // 返金は、戻した1点の分だけ（お返しの1点は返金しない）
        expect(received).toMatchObject({ refundAmount: 5_000, returnStatus: 'closed' });
        await recordRefundResult(db, received.refundId as string);
        return { fx, label: returnLabelOf(fx.orderId, created.number) };
      });

      await runWorkerUntil(request, async () => (await sentOutboxCount(fx.orderId, 'refund')) >= 1, '返金のお知らせが送信済みになること');
      const refundMails = await waitForMails(request, fx.email, RETURN_MAIL.refund);
      expect(refundMails).toHaveLength(1);
      const text = refundMails[0].Text;
      expect(text).toContain(RETURN_MAIL.received1(label));
      expect(text).toContain('お返しする商品:');
      expect(text).toContain('当店より:');
      expect(text).toContain(MESSAGE);
      expect(text).toContain(RETURN_MAIL.sentBackTracking('ヤマト運輸', 'ABC-123'));
      // お返しだけのメールや、受け取りのお知らせは、別に届かない
      expect(await mailBodies(request, fx.email, RETURN_MAIL.sentBack)).toHaveLength(0);
      expect(await mailBodies(request, fx.email, RETURN_MAIL.received)).toHaveLength(0);
      expect((await withLocalDb((db) => returnEmailRows(db, fx.orderId))).map((row) => row.kind)).toEqual(['refund']);
    });

    test('全部をお返しすると「品物をお返しします」が1通届き、お店のメッセージと伝票番号が入る（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-04
      test.setTimeout(180_000);
      const { fx, label } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `sent-back-mail-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId: created.lineIds[shirt], disposition: 'sent_back', quantity: 1 }],
          choice: 'none',
          notify: true,
          sentBack: { message: MESSAGE, carrier: 'yamato', trackingNumber: 'ABC-123' },
        });
        return { fx, label: returnLabelOf(fx.orderId, created.number) };
      });

      const mails = await waitForMails(request, fx.email, RETURN_MAIL.sentBack);
      await runWorkerUntil(request, async () => (await sentReturnMailCount(fx.orderId, 'return_sent_back')) >= 1, '品物をお返ししますが送信済みになること');
      expect(mails).toHaveLength(1);
      expect(mails[0].Subject).toBe(`【Le Fil des Heures】${RETURN_MAIL.sentBack}（${orderNumberOf(fx.orderId)}）`);
      const text = mails[0].Text;
      expect(text).toContain(RETURN_MAIL.sentBackLead(label));
      expect(text).toContain('お返しする商品:');
      expect(text).toContain('・E2Eシャツ（ホワイト / M） × 1');
      expect(text).toContain('当店より:');
      expect(text).toContain(MESSAGE);
      expect(text).toContain(RETURN_MAIL.sentBackTracking('ヤマト運輸', 'ABC-123'));
    });
  });
}
