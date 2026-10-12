/**
 * FR-ADMIN-086 一部の受け取り・届かないで終える・開き直し・取消・検品
 * 対応 FREQ: FREQ-463（AC-03〜AC-09）
 *
 * 画面（受け取りの確かめ・届かないで終える・開き直し・取消・検品の画面）は窓口の答えを差し替えて確かめ、数・状態・在庫の台帳は、
 * 窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼んで確かめる（実装計画 P11）。返金は「相談」で受け取るので Stripe には関わらない。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectDbError, recordRefundResult, variantStockState, withLocalDb } from './order-email-test-utils';
import { UUID_PATTERN, fulfillJson, mockOrderList, openOrderTab, viewports } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  RETURN_TEXT,
  UNIT_STATES,
  cancelReturnInDb,
  closeMissingInDb,
  confirmButton,
  createReturnInDb,
  createShippedOrder,
  formatYen,
  inspectReturnInDb,
  lineProgressOf,
  mockReturnRoutes,
  newReturnRouteState,
  openOperationDialog,
  openReceiveDialog,
  openReturnsDialog,
  orderWithReturns,
  receiptRows,
  receiveReturnInDb,
  reopenReturnInDb,
  returnCard,
  returnDetailOf,
  returnLabelOf,
  returnLedger,
  returnLineOf,
  returnRowOf,
  returnSummaryOf,
  returnSummaryRow,
  returnableByItem,
  returnsDialogName,
  setUnitState,
  unitTotal,
  type ReturnRouteState,
} from './return-test-utils';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

const ORDER_ID = 'a6b2c3d4-0086-4000-8000-000000000086';
const SHIRT = 'c6b2c3d4-0000-4000-8000-000000000001';
const LINE = 'd6b2c3d4-0000-4000-8000-000000000001';
const SECOND_LINE = 'd6b2c3d4-0000-4000-8000-000000000002';
const RETURN_ID = 'b6b2c3d4-0000-4000-8000-000000000001';
const SECOND_RETURN_ID = 'b6b2c3d4-0000-4000-8000-000000000002';
const LABEL = returnLabelOf(ORDER_ID, 1);
const SECOND_LABEL = returnLabelOf(ORDER_ID, 2);

/** 一覧の窓口と返品の窓口を差し替えて、ORDER タブを開く。返品の欄に出す返品を渡す */
async function openList(page: Page, returns: OrderReturnDetail[], summary: Parameters<typeof returnSummaryOf>[0]) {
  const state: ReturnRouteState = newReturnRouteState({ orderId: ORDER_ID, returns, returnableUnits: 0, refundableAmount: 20_000 });
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => [orderWithReturns({ id: ORDER_ID, summary: returnSummaryOf(summary) })]);
  await mockReturnRoutes(page, ORDER_ID, state);
  await openOrderTab(page);
  return state;
}

/** 受け付け中の返品1つ（シャツ2点・受け取り待ち）の受け取りの画面まで開く */
async function openReceive(page: Page) {
  const detail = returnDetailOf({
    orderId: ORDER_ID,
    id: RETURN_ID,
    lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 2, itemName: 'E2Eシャツ' })],
  });
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
  test.describe(`FR-ADMIN-086 return partial, missing, cancel (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('一部だけ届いた時は、押す前に確かめが出る。「戻る」では何も送らず、「記録する」で届いた分だけが窓口へ届く', async ({ page }) => {
      // FREQ-463-AC-03
      const { state, dialog } = await openReceive(page);
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await confirmButton(dialog, RETURN_TEXT.receivePart(1, formatYen(5_000))).click();

      await expect(dialog.getByText(RETURN_TEXT.partialConfirm(1))).toBeVisible();
      await dialog.getByRole('button', { name: '戻る', exact: true }).click();
      await expect(dialog.getByText(RETURN_TEXT.partialConfirm(1))).toHaveCount(0);
      expect(state.posts.receive).toHaveLength(0);

      await confirmButton(dialog, RETURN_TEXT.receivePart(1, formatYen(5_000))).click();
      await dialog.getByRole('button', { name: '記録する', exact: true }).click();
      await expect.poll(() => state.posts.receive.length).toBe(1);
      expect(state.posts.receive[0].returnId).toBe(RETURN_ID);
      expect(unitTotal(state.posts.receive[0].body, LINE, 'restocked')).toBe(1);
    });

    test('「残りは届かないものとして返品を終える」は、確かめの文が出て、「返品を終える」で窓口へ届く。「戻る」では何も送らない', async ({ page }) => {
      // FREQ-463-AC-04
      const { state, dialog } = await openReceive(page);
      await dialog.getByRole('button', { name: RETURN_TEXT.missingOption, exact: true }).click();

      await expect(dialog.getByText(RETURN_TEXT.missingConfirm(2))).toBeVisible();
      await dialog.getByRole('button', { name: '戻る', exact: true }).click();
      expect(state.posts['close-missing']).toHaveLength(0);

      await dialog.getByRole('button', { name: RETURN_TEXT.missingOption, exact: true }).click();
      await dialog.getByRole('button', { name: '返品を終える', exact: true }).click();
      await expect.poll(() => state.posts['close-missing'].length).toBe(1);
      expect(state.posts['close-missing'][0].returnId).toBe(RETURN_ID);
      expect(String(state.posts['close-missing'][0].body.requestKey)).toMatch(UUID_PATTERN);
      await expect(
        page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true }).getByRole('status'),
      ).toContainText(RETURN_TEXT.noticeClosedMissing);
    });

    test('届かない品がある完了した返品だけに「開き直す」が出て、確かめの文の後に窓口へ届く', async ({ page }) => {
      // FREQ-463-AC-05
      const withMissing = returnDetailOf({
        orderId: ORDER_ID,
        id: RETURN_ID,
        status: 'closed',
        displayStatus: 'returned',
        marks: [],
        lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 2, itemName: 'E2Eシャツ', progress: { restocked: 1, missing: 1 } })],
      });
      const complete = returnDetailOf({
        orderId: ORDER_ID,
        id: SECOND_RETURN_ID,
        number: 2,
        status: 'closed',
        displayStatus: 'returned',
        marks: [],
        lines: [returnLineOf({ id: SECOND_LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ', progress: { restocked: 1 } })],
      });
      const state = await openList(page, [withMissing, complete], { orderId: ORDER_ID, displayStatus: 'returned', hasReturnable: false });
      const returns = await openReturnsDialog(page, ORDER_ID);

      await expect(returnCard(returns, LABEL).getByRole('button', { name: '開き直す', exact: true })).toBeVisible();
      await expect(returnCard(returns, SECOND_LABEL).getByRole('button', { name: '開き直す', exact: true })).toHaveCount(0);

      const dialog = await openOperationDialog(page, ORDER_ID, LABEL, '開き直す', RETURN_TEXT.reopenTitle);
      await expect(dialog.getByText(RETURN_TEXT.reopenBody(1))).toBeVisible();
      await dialog.getByRole('button', { name: '戻る', exact: true }).click();
      expect(state.posts.reopen).toHaveLength(0);

      const again = await openOperationDialog(page, ORDER_ID, LABEL, '開き直す', RETURN_TEXT.reopenTitle);
      await again.getByRole('button', { name: '開き直す', exact: true }).click();
      await expect.poll(() => state.posts.reopen.length).toBe(1);
      expect(state.posts.reopen[0].returnId).toBe(RETURN_ID);
    });

    test('何も受け取っていない返品だけに「返品を取り消す」が出て、確かめの後に取り消せる。取り消した返品は返品の欄から消える', async ({ page }) => {
      // FREQ-463-AC-06
      const untouched = returnDetailOf({
        orderId: ORDER_ID,
        id: RETURN_ID,
        lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 1, itemName: 'E2Eシャツ' })],
      });
      const received = returnDetailOf({
        orderId: ORDER_ID,
        id: SECOND_RETURN_ID,
        number: 2,
        marks: ['partially_received'],
        firstReceiptDone: true,
        receipts: [{ id: randomUUID(), kind: 'receive', refundChoice: 'consult', createdAt: '2026-10-11T01:00:00.000Z', actorEmail: 'admin@example.com' }],
        lines: [returnLineOf({ id: SECOND_LINE, orderItemId: SHIRT, quantity: 2, itemName: 'E2Eシャツ', progress: { restocked: 1, refundWaiting: 1 } })],
      });
      const state = await openList(page, [untouched, received], {
        orderId: ORDER_ID,
        displayStatus: 'in_progress',
        marks: ['awaiting_items'],
        nextAction: 'receive',
        hasReturnable: false,
      });
      state.answerAction = async (route, action, post) => {
        state.returns = state.returns.filter((item) => item.id !== post.returnId);
        await fulfillJson(route, { data: { returnStatus: 'cancelled' } });
      };
      const returns = await openReturnsDialog(page, ORDER_ID, '受け取る');

      await expect(returnCard(returns, LABEL).getByRole('button', { name: RETURN_TEXT.cancelTitle, exact: true })).toBeVisible();
      await expect(returnCard(returns, SECOND_LABEL).getByRole('button', { name: RETURN_TEXT.cancelTitle, exact: true })).toHaveCount(0);

      const dialog = await openOperationDialog(page, ORDER_ID, LABEL, RETURN_TEXT.cancelTitle, RETURN_TEXT.cancelTitle);
      await expect(dialog.getByText(RETURN_TEXT.cancelBody)).toBeVisible();
      await dialog.getByRole('button', { name: RETURN_TEXT.cancelTitle, exact: true }).click();

      await expect.poll(() => state.posts.cancel.length).toBe(1);
      expect(state.posts.cancel[0].returnId).toBe(RETURN_ID);
      const reopened = page.getByRole('dialog', { name: returnsDialogName(ORDER_ID), exact: true });
      await expect(reopened).toBeVisible();
      await expect(reopened.getByRole('group', { name: LABEL, exact: true })).toHaveCount(0);
      await expect(reopened.getByRole('group', { name: SECOND_LABEL, exact: true })).toBeVisible();
    });

    test('検品待ちの品がある返品に「検品を終える」が出て、戻す・戻さないを選んで窓口へ届く', async ({ page }) => {
      // FREQ-463-AC-07
      const pending = returnDetailOf({
        orderId: ORDER_ID,
        id: RETURN_ID,
        marks: ['pending_inspection'],
        firstReceiptDone: true,
        receipts: [{ id: randomUUID(), kind: 'receive', refundChoice: 'consult', createdAt: '2026-10-11T01:00:00.000Z', actorEmail: 'admin@example.com' }],
        lines: [returnLineOf({ id: LINE, orderItemId: SHIRT, quantity: 2, itemName: 'E2Eシャツ', progress: { pendingInspection: 2, refundWaiting: 2 } })],
      });
      const state = await openList(page, [pending], {
        orderId: ORDER_ID,
        displayStatus: 'in_progress',
        marks: ['pending_inspection'],
        hasReturnable: false,
      });
      const returns = await openReturnsDialog(page, ORDER_ID);
      await expect(returnCard(returns, LABEL).getByText('検品待ち 2点')).toBeVisible();

      const dialog = await openOperationDialog(page, ORDER_ID, LABEL, '検品を終える', RETURN_TEXT.inspectTitle(LABEL));
      const choices = dialog.getByRole('combobox', { name: '品の状態', exact: true });
      await expect(choices).toHaveCount(2);
      await choices.nth(0).selectOption({ label: UNIT_STATES.restock });
      await choices.nth(1).selectOption({ label: UNIT_STATES.keep });
      await dialog.getByRole('button', { name: '検品を終える', exact: true }).click();

      await expect.poll(() => state.posts.inspect.length).toBe(1);
      expect(state.posts.inspect[0].returnId).toBe(RETURN_ID);
      expect(state.posts.inspect[0].body).toMatchObject({ lines: [{ returnLineId: LINE, restocked: 1, notRestocked: 1 }] });
      expect(String(state.posts.inspect[0].body.requestKey)).toMatch(UUID_PATTERN);
    });

    test('一部を受け取り、残りを届かないで終え、開き直して残りを受け取ると、数・状態・在庫の台帳が合う（手元の DB）', async () => {
      // FREQ-463-AC-08
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `flow-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 3 }] });
        const lineId = created.lineIds[shirt];
        const progress = async () => (await lineProgressOf(db, created.returnId))[lineId];

        // 1) 3点のうち1点だけ、今返金で受け取る。返金の記録が覆うので返金待ちは残らず、返品は受付中のまま（2点が未処理）
        const first = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId, disposition: 'restocked', quantity: 1 }],
          choice: 'now',
        });
        expect(first).toMatchObject({ refundAmount: 5_000, returnStatus: 'open' });
        await recordRefundResult(db, first.refundId as string);
        expect(await progress()).toMatchObject({ restocked: 1, unprocessed: 2, missing: 0, refund_waiting: 0 });

        // 2) 残りの2点は届かないものとして終える。全部が処理され、返金待ちなども無いので、返品は完了する
        await closeMissingInDb(db, created.returnId, fx.actorId);
        expect(await progress()).toMatchObject({ restocked: 1, missing: 2, unprocessed: 0, refund_waiting: 0 });
        expect((await returnRowOf(db, created.returnId)).status).toBe('closed');
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });
        expect((await receiptRows(db, created.returnId)).map((row) => row.kind)).toEqual(['receive', 'close_missing']);

        // 3) 開き直す（完了した返品で、届かないにした品が残っている時だけ）と、届かないにした2点がまた受け取れる
        await reopenReturnInDb(db, created.returnId, fx.actorId);
        expect((await returnRowOf(db, created.returnId)).status).toBe('open');
        expect(await progress()).toMatchObject({ restocked: 1, missing: 0, unprocessed: 2 });

        // 4) 残りの2点を、今返金で受け取る。品が全部処理され、返品は完了する
        const second = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId, disposition: 'restocked', quantity: 2 }],
          choice: 'now',
        });
        expect(second).toMatchObject({ refundAmount: 10_000, returnStatus: 'closed' });
        await recordRefundResult(db, second.refundId as string);
        expect(await progress()).toMatchObject({ restocked: 3, unprocessed: 0, missing: 0, refund_waiting: 0 });
        // 在庫の台帳は、受け取りごとに1行（+1、+2）。すぐ出せる数は合わせて +3
        expect((await returnLedger(db, fx.orderId)).map((row) => [row.reason, row.delta])).toEqual([
          ['return', 1],
          ['return', 2],
        ]);
        expect((await variantStockState(db, fx.variantId)).stock).toBe(3);
        expect((await receiptRows(db, created.returnId)).map((row) => row.kind)).toEqual(['receive', 'close_missing', 'reopen', 'receive']);
      });
    });

    test('受け取った後の取消は断られ、何も受け取る前の取消は通って、取り消した品はまた返品できる（手元の DB）', async () => {
      // FREQ-463-AC-06
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `cancel-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const [shirt, skirt] = fx.orderItemIds;
        const untouched = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }] });
        const touched = await createReturnInDb(db, fx, { lines: [{ orderItemId: skirt, quantity: 1 }] });
        expect(await returnableByItem(db, fx.orderId)).toEqual({ [shirt]: 0, [skirt]: 0 });

        await receiveReturnInDb(db, touched.returnId, fx.actorId, {
          units: [{ lineId: touched.lineIds[skirt], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
        });
        await expectDbError(cancelReturnInDb(db, touched.returnId, fx.actorId), 'RETURN_STATE_CONFLICT');
        expect((await returnRowOf(db, touched.returnId)).status).not.toBe('cancelled');

        expect(await cancelReturnInDb(db, untouched.returnId, fx.actorId)).toBe('cancelled');
        expect((await returnRowOf(db, untouched.returnId)).status).toBe('cancelled');
        // 取り消した返品の品は、またどの返品にも入れられる
        expect(await returnableByItem(db, fx.orderId)).toEqual({ [shirt]: 2, [skirt]: 0 });
        const again = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }] });
        expect(again).toMatchObject({ number: 3, status: 'open' });
      });
    });

    test('検品待ちで受け取った品を検品で決めると、戻す分だけ在庫が増え、返品が返金待ちになる（手元の DB）', async () => {
      // FREQ-463-AC-09
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `inspect-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }] });
        const lineId = created.lineIds[shirt];

        await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId, disposition: 'pending_inspection', quantity: 2 }],
          choice: 'consult',
        });
        // 検品待ちの間は在庫を動かさず、返金待ちにもならない（検品待ちの印が付いた返品中）
        expect((await variantStockState(db, fx.variantId)).stock).toBe(0);
        expect((await lineProgressOf(db, created.returnId))[lineId]).toMatchObject({ pending_inspection: 2, unprocessed: 0 });
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'in_progress' });
        expect((await returnSummaryRow(db, fx.orderId)).marks).toContain('pending_inspection');

        // 検品で、1点は戻し、1点は戻さない
        await inspectReturnInDb(db, created.returnId, fx.actorId, [{ lineId, restocked: 1, notRestocked: 1 }]);
        expect((await variantStockState(db, fx.variantId)).stock).toBe(1);
        expect((await returnLedger(db, fx.orderId)).map((row) => [row.reason, row.delta])).toEqual([['return', 1]]);
        expect((await lineProgressOf(db, created.returnId))[lineId]).toMatchObject({ pending_inspection: 0, processed: 2, unprocessed: 0 });
        expect(await returnSummaryRow(db, fx.orderId)).toMatchObject({ display_status: 'refund_waiting', next_action: 'refund' });
      });
    });
  });
}
