/**
 * FR-ADMIN-166 発送前の取り消し・発送後の品の返金・前の注文への戻し（手元に残る服の正しい値段）
 * 対応 FREQ: FREQ-642（AC-10・AC-27・AC-28）。設計: docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md
 *
 * 管理画面は本物のログイン（aal2 の管理者）で本番ビルドの画面を動かし、見込みの窓口も本物を通す。返金・受け取りの窓口だけ、
 * Stripe を偽物にした同じ入口に差し替える（unit-binding-test-utils）。額と着の状態は手元の DB から読む。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { amount } from '../tests/unit/lib/discounts/fixtures';
import { CHECKOUT_VIEWPORTS } from './checkout-flow-helpers';
import { installDiscountDbBridge, withDiscountScenario, type DiscountScenario } from './discount-test-utils';
import { detailSection, openOrderDetail } from './order-fulfillment-test-utils';
import { openDetailRefundDialog } from './refund-test-utils';
import {
  RETURN_TEXT, UNIT_STATES, confirmButton, formatYen, openReceiveDialog, readReturnBreakdown, returnLabelOf, setUnitState,
} from './return-test-utils';
import {
  createApprovedReturn, eventsOf, installReceiveBridge, installRefundBridge, refundedTotal, refundsOf, seedSnapshotOrder, slotStates, yenOf,
  type UbOrder,
} from './unit-binding-test-utils';

const ESTIMATING = '計算しています';

/** ジャケット 20,000円を2着。2着目は 3,000円引き（払った額は 17,000円・20,000円） */
async function repeatOrder(s: DiscountScenario, shipped: boolean): Promise<UbOrder> {
  const order = await seedSnapshotOrder(s.db, {
    actorId: s.admin.userId, shipped, lines: [{ price: 20_000, quantity: 2 }],
    definitions: ([jacket]) => [amount('repeat', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [jacket], repeatInOrder: true })],
  });
  await s.recordPaid(order.orderId);
  return order;
}

async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
}

const amountField = (dialog: Locator) => dialog.getByRole('spinbutton', { name: /^返金額/ });

async function openReceive(page: Page, order: UbOrder, number: number): Promise<Locator> {
  await openOrderDetail(page, order.orderId);
  await detailSection(page, '返品とキャンセルの申し込み').getByRole('button', { name: /^(返品|受け取る|額を決めて返金する)$/ }).first().click();
  return openReceiveDialog(page, order.orderId, returnLabelOf(order.orderId, number));
}

/** 窓口が本文を受け、入口が終わる（DB に書き終わる）まで待つ */
async function waitDone(state: { posts: unknown[]; results: unknown[] }, count: number): Promise<void> {
  await expect.poll(() => state.posts.length, { timeout: 60_000 }).toBe(count);
  await expect.poll(() => state.results.length, { timeout: 60_000 }).toBe(count);
}

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-166 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-27: 発送前の1着を取り消すと標準の額は17,000円で、その着が「お店の側で返した」になる', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub166-ac27-${viewport.name}`, async (s) => {
        const order = await repeatOrder(s, false);
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installRefundBridge(page, s.admin.userId);
        await openOrderDetail(page, order.orderId);
        const dialog = await openDetailRefundDialog(page, order.orderId);
        await dialog.getByRole('region', { name: '発送前の商品', exact: true }).getByLabel('返金する数', { exact: true }).first().fill('1');
        await expect(dialog.getByText(ESTIMATING, { exact: true })).toHaveCount(0);
        const rows = await readReturnBreakdown(dialog);
        expect(yenOf(rows['返金額'])).toBe(17_000);
        await expect(amountField(dialog)).toHaveValue('17000');
        await expectNoOverflow(page);
        await dialog.getByRole('button', { name: `${formatYen(17_000)} を返金する`, exact: true }).click();
        await waitDone(bridge, 1);
        expect(bridge.posts[0].lines).toEqual([{ orderItemId: order.orderItemIds[0], quantity: 1, beforeShipment: true }]);

        expect((await refundsOf(s.db, order.orderId)).map((r) => r.amount)).toEqual([17_000]);
        const slots = await slotStates(s.db, order.orderId);
        expect(slots.map((slot) => slot.state).sort()).toEqual(['kept', 'returned_shop']);
        const events = await eventsOf(s.db, order.orderId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'pre_shipment_cancel', standard_refund: 17_000, now_refund: 17_000 });
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-28: 発送後の品を返品なしで選ぶ返金は見込みの窓口を呼ばず、額は店長の額の欄だけで、着の状態と E は変わらない', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub166-ac28-${viewport.name}`, async (s) => {
        const order = await repeatOrder(s, true);
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installRefundBridge(page, s.admin.userId);
        const estimateCalls: string[] = [];
        page.on('request', (request) => { if (request.url().includes('/refund-estimate')) estimateCalls.push(request.url()); });
        await openOrderDetail(page, order.orderId);
        const dialog = await openDetailRefundDialog(page, order.orderId);
        await dialog.getByRole('region', { name: '発送済みの商品', exact: true }).getByLabel('返金する数', { exact: true }).first().fill('1');
        const field = amountField(dialog);
        await expect(field).toBeEnabled();
        await field.fill('12345'); // 店長が決めた額だけが額になる
        await expect(field).toHaveValue('12345');
        await expectNoOverflow(page);
        await dialog.getByRole('button', { name: `${formatYen(12_345)} を返金する`, exact: true }).click();
        await waitDone(bridge, 1);
        expect(estimateCalls).toEqual([]);
        expect(bridge.posts[0]).toMatchObject({ amount: 12_345, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1, beforeShipment: false }] });

        expect((await refundsOf(s.db, order.orderId)).map((r) => r.amount)).toEqual([12_345]);
        expect((await slotStates(s.db, order.orderId)).map((slot) => slot.state)).toEqual(['kept', 'kept']);
        expect(await eventsOf(s.db, order.orderId)).toEqual([]);
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-10: 前の注文の返品は17,000円、後の注文の着も返すと後の注文から17,000円・前の注文から3,000円で合計37,000円', async ({ page }) => {
      test.setTimeout(300_000);
      await withDiscountScenario(`ub166-ac10-${viewport.name}`, async (s) => {
        // 同じ会員の、前の注文（20,000円）と後の注文（前の注文があるので 17,000円）。どちらも払い済み・発送済み
        const first = await seedSnapshotOrder(s.db, {
          actorId: s.admin.userId, buyerUserId: s.memberId, createdAt: new Date(Date.now() - 3_600_000).toISOString(),
          lines: [{ price: 20_000, quantity: 1 }],
          definitions: ([jacket]) => [amount('repeatprev', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [jacket], repeatPrevious: true })],
        });
        await s.recordPaid(first.orderId);
        const second = await seedSnapshotOrder(s.db, {
          actorId: s.admin.userId, buyerUserId: s.memberId, lines: [{ price: 20_000, quantity: 1, catalog: first.catalogs[0] }],
          definitions: ([jacket]) => [amount('repeatprev', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [jacket], repeatPrevious: true })],
          priorUnitsByItem: ([jacket]) => ({ [String(jacket)]: 1 }),
        });
        await s.recordPaid(second.orderId);
        expect(first.paid).toEqual([[20_000]]);
        expect(second.paid).toEqual([[17_000]]);
        const returnFirst = await createApprovedReturn(s.db, { orderId: first.orderId, fulfillmentId: first.fulfillmentId!, actorId: s.admin.userId,
          groups: [{ orderItemId: first.orderItemIds[0], quantity: 1 }] });
        const returnSecond = await createApprovedReturn(s.db, { orderId: second.orderId, fulfillmentId: second.fulfillmentId!, actorId: s.admin.userId,
          groups: [{ orderItemId: second.orderItemIds[0], quantity: 1 }] });
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReceiveBridge(page, s.admin.userId);

        // 前の注文の着をお客様のご都合で返す: 手元に残るのは1着なので安い方の額 17,000円。外れた 3,000円は差し引く
        const firstDialog = await openReceive(page, first, returnFirst.number);
        await setUnitState(firstDialog, 0, UNIT_STATES.keep);
        await expect(firstDialog.getByText(ESTIMATING, { exact: true })).toHaveCount(0);
        expect(yenOf((await readReturnBreakdown(firstDialog))['返金額'])).toBe(17_000);
        await expectNoOverflow(page);
        await confirmButton(firstDialog, RETURN_TEXT.receiveAll(formatYen(17_000))).click();
        await waitDone(bridge, 1);
        expect((await refundsOf(s.db, first.orderId)).map((r) => r.amount)).toEqual([17_000]);
        // 後の注文の値段と返金の記録は直さない
        expect(await refundsOf(s.db, second.orderId)).toEqual([]);
        expect((await slotStates(s.db, second.orderId)).map((slot) => slot.currentPrice)).toEqual([17_000]);

        // 後の注文の着を返す: 後の注文から 17,000円、前の注文から差し引いた 3,000円
        await page.reload();
        const secondDialog = await openReceive(page, second, returnSecond.number);
        await setUnitState(secondDialog, 0, UNIT_STATES.keep);
        await expect(secondDialog.getByText(ESTIMATING, { exact: true })).toHaveCount(0);
        expect(yenOf((await readReturnBreakdown(secondDialog))['返金額'])).toBe(17_000);
        await confirmButton(secondDialog, RETURN_TEXT.receiveAll(formatYen(17_000))).click();
        await waitDone(bridge, 2);

        expect((await refundsOf(s.db, second.orderId)).map((r) => r.amount)).toEqual([17_000]);
        const firstRefunds = await refundsOf(s.db, first.orderId);
        expect(firstRefunds.map((r) => [r.source, r.amount])).toEqual([[firstRefunds[0].source, 17_000], ['unit_hold_release', 3_000]]);
        expect(await refundedTotal(s.db, first.orderId)).toBeLessThanOrEqual(20_000);
        expect(await refundedTotal(s.db, first.orderId) + await refundedTotal(s.db, second.orderId)).toBe(37_000);
      }, { returnSettings: true });
    });
  });
}
