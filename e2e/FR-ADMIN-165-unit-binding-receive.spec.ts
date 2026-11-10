/**
 * FR-ADMIN-165 返品の受け取りで、手元に残る服の正しい値段から返す額を出す
 * 対応 FREQ: FREQ-642（AC-02・AC-04・AC-07・AC-09・AC-25）。設計: docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md
 *
 * 管理画面は本物のログイン（aal2 の管理者）で本番ビルドの画面を動かし、見込みの窓口（receive-estimate）も本物を通す。
 * 注文は「注文の時の写し」のある注文（unit-binding-test-utils の seedSnapshotOrder）を手元の DB に作る。
 * 受け取りの窓口だけ、Stripe を偽物にした同じ入口（receiveReturnAndRefund）に差し替える（外へ返金を頼まないため）。
 * 返した額は手元の DB（order_refunds・order_unit_events）から読み、画面に出た見込みと突き合わせる。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { amount } from '../tests/unit/lib/discounts/fixtures';
import { shipFixtureOrder } from '../tests/integration/db/helpers/order-fixtures';
import { CHECKOUT_VIEWPORTS } from './checkout-flow-helpers';
import { installDiscountDbBridge, withDiscountScenario, type DiscountScenario } from './discount-test-utils';
import { detailSection, openOrderDetail } from './order-fulfillment-test-utils';
import {
  RETURN_TEXT, UNIT_STATES, confirmButton, formatYen, openReceiveDialog, readReturnBreakdown, returnLabelOf, setUnitState,
} from './return-test-utils';
import {
  createApprovedReturn, eventsOf, installReceiveBridge, receiveViaService, refundsOf, refundedTotal, returnFeeRow, seedSnapshotOrder,
  slotStates, yenOf, type UbOrder,
} from './unit-binding-test-utils';

const ESTIMATING = '計算しています';

/** ジャケット 20,000円を2着。2着目は 3,000円引き（払った額は 17,000円・20,000円） */
async function repeatOrder(s: DiscountScenario): Promise<UbOrder> {
  const order = await seedSnapshotOrder(s.db, {
    actorId: s.admin.userId, lines: [{ price: 20_000, quantity: 2 }],
    definitions: ([jacket]) => [amount('repeat', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [jacket], repeatInOrder: true })],
  });
  await s.recordPaid(order.orderId);
  return order;
}

/** ジャケット 20,000円を2着とパンツ 10,000円。組で 4,500円引き（払った額は 17,000円・20,000円・8,500円） */
async function setOrder(s: DiscountScenario, quantities: { jacket: number } = { jacket: 2 }): Promise<UbOrder> {
  const order = await seedSnapshotOrder(s.db, {
    actorId: s.admin.userId, lines: [{ price: 20_000, quantity: quantities.jacket }, { price: 10_000, quantity: 1 }],
    definitions: ([jacket, pants]) => [amount('set', 4500, { kind: 'set', targetMode: 'include', itemIds: [jacket, pants] })],
  });
  await s.recordPaid(order.orderId);
  return order;
}

async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
}

/** 注文の詳細 → 返品の画面を開き（ボタンの名前は返品の状態で変わる）、その返品の受け取りの画面を開く */
async function openReceive(page: Page, order: UbOrder, number: number): Promise<Locator> {
  await openOrderDetail(page, order.orderId);
  await detailSection(page, '返品とキャンセルの申し込み').getByRole('button', { name: /^(返品|受け取る|額を決めて返金する)$/ }).first().click();
  return openReceiveDialog(page, order.orderId, returnLabelOf(order.orderId, number));
}

/** 見込みの窓口の答えが画面に出るまで待ち、内訳を読む */
async function breakdownOf(dialog: Locator): Promise<Record<string, string>> {
  await expect(dialog.getByText(ESTIMATING, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('group', { name: '返金の内訳', exact: true })).toBeVisible();
  return readReturnBreakdown(dialog);
}

/** 受け取りの窓口が本文を受け、入口が終わる（DB に書き終わる）まで待つ */
async function waitPosts(state: { posts: unknown[]; results: unknown[] }, count: number): Promise<void> {
  await expect.poll(() => state.posts.length, { timeout: 60_000 }).toBe(count);
  await expect.poll(() => state.results.length, { timeout: 60_000 }).toBe(count);
}

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-165 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-02: 交換の受け取りは0円、続く返品の受け取りは見込みどおりの17,000円', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub165-ac02-${viewport.name}`, async (s) => {
        const order = await repeatOrder(s);
        const [exchange, refund] = [
          await createApprovedReturn(s.db, { orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId,
            groups: [{ orderItemId: order.orderItemIds[0], quantity: 1, exchangeVariantId: order.catalogs[0].variantId }] }),
          await createApprovedReturn(s.db, { orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId,
            groups: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }),
        ];
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReceiveBridge(page, s.admin.userId);

        // 交換の受け取り: 返金は動かない
        const exchangeDialog = await openReceive(page, order, exchange.number);
        await setUnitState(exchangeDialog, 0, UNIT_STATES.keep);
        await expect(exchangeDialog.getByText(ESTIMATING, { exact: true })).toHaveCount(0);
        await expectNoOverflow(page);
        await confirmButton(exchangeDialog, RETURN_TEXT.receiveAllExchange).click();
        await waitPosts(bridge, 1);
        expect(bridge.posts[0].returnId).toBe(exchange.returnId);
        expect(await refundsOf(s.db, order.orderId)).toEqual([]);
        // 交換だけの受け取りは出来事（E・返す額）を作らず、交換の結びだけが1本できる
        expect(await eventsOf(s.db, order.orderId)).toEqual([]);
        const links = await s.db.query('select count(*)::int n from public.order_unit_exchange_links l join public.order_unit_slots x on x.order_item_id=l.slot_order_item_id and x.unit_index=l.slot_unit_index where x.order_id=$1', [order.orderId]);
        expect(links.rows[0].n).toBe(1);

        // 返品の受け取り: 画面の見込みが 17,000円で、返した額も同じ
        await page.reload();
        const refundDialog = await openReceive(page, order, refund.number);
        await setUnitState(refundDialog, 0, UNIT_STATES.keep);
        const rows = await breakdownOf(refundDialog);
        expect(yenOf(rows['返金額'])).toBe(17_000);
        await expectNoOverflow(page);
        await confirmButton(refundDialog, RETURN_TEXT.receiveAll(formatYen(17_000))).click();
        await waitPosts(bridge, 2);
        const refunds = await refundsOf(s.db, order.orderId);
        expect(refunds.map((r) => r.amount)).toEqual([17_000]);
        expect(await refundedTotal(s.db, order.orderId)).toBe(17_000);
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-04: 交換の品を返すと20,000円で、2つの返品の合計は37,000円', async ({ page }) => {
      test.setTimeout(300_000);
      await withDiscountScenario(`ub165-ac04-${viewport.name}`, async (s) => {
        const order = await repeatOrder(s);
        const base = { orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId };
        // 準備: 交換 → 残りの元の1着の返品（17,000円）。窓口と同じ入口で受け取る
        const exchange = await createApprovedReturn(s.db, { ...base,
          groups: [{ orderItemId: order.orderItemIds[0], quantity: 1, exchangeVariantId: order.catalogs[0].variantId }] });
        const exchanged = await receiveViaService(exchange.returnId, s.admin.userId, {
          units: [{ returnLineId: exchange.lineIds[0], disposition: 'not_restocked', quantity: 1 }], refundChoice: 'none' });
        expect(exchanged.exchangeOrderItemIds).toHaveLength(1);
        const rest = await createApprovedReturn(s.db, { ...base, groups: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] });
        const restReceived = await receiveViaService(rest.returnId, s.admin.userId, {
          units: [{ returnLineId: rest.lineIds[0], disposition: 'not_restocked', quantity: 1, refundChoice: 'now' }], refundChoice: 'now' });
        expect(restReceived.refund?.amount).toBe(17_000);
        // 交換の品を発送して、その品を返す返品を作る
        const exchangeItemId = exchanged.exchangeOrderItemIds[0];
        const shipment = await shipFixtureOrder(s.db, { orderId: order.orderId, actorId: s.admin.userId, trackingNumber: `E2E-642-EX-${Date.now()}`,
          lines: [{ order_item_id: exchangeItemId, quantity: 1 }] });
        const second = await createApprovedReturn(s.db, { orderId: order.orderId, fulfillmentId: shipment.fulfillment_id, actorId: s.admin.userId,
          groups: [{ orderItemId: exchangeItemId, quantity: 1 }] });

        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReceiveBridge(page, s.admin.userId);
        const dialog = await openReceive(page, order, second.number);
        await setUnitState(dialog, 0, UNIT_STATES.keep);
        const rows = await breakdownOf(dialog);
        expect(yenOf(rows['返金額'])).toBe(20_000); // 位置の誤りで 34,000円になる道は無い（合計 37,000円）
        await expectNoOverflow(page);
        await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(20_000))).click();
        await waitPosts(bridge, 1);
        const refunds = await refundsOf(s.db, order.orderId);
        expect(refunds.map((r) => r.amount)).toEqual([17_000, 20_000]);
        expect(await refundedTotal(s.db, order.orderId)).toBe(37_000);
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-07: 画面に出た返送料・お支払い待ち・返金額が、受け取りで DB に残った値と同じ（交換の手数料と送料はお支払い待ちの合計で確かめる）', async ({ page }) => {
      test.setTimeout(300_000);
      await withDiscountScenario(`ub165-ac07-${viewport.name}`, async (s) => {
        const order = await repeatOrder(s);
        const base = { orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId };
        // 交換だけの返品（交換の手数料 500円・交換の送料 300円）と、お店の送り状の返送料 800円つきの返品
        const exchange = await createApprovedReturn(s.db, { ...base, exchangeFee: 500, exchangeShippingFee: 300,
          groups: [{ orderItemId: order.orderItemIds[0], quantity: 1, exchangeVariantId: order.catalogs[0].variantId }] });
        const refund = await createApprovedReturn(s.db, { ...base, returnShippingFee: 800,
          groups: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] });
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReceiveBridge(page, s.admin.userId);

        // 交換だけの受け取り: お支払い待ちは手数料と送料の合計で、受け取り後の DB の値と同じ
        const exchangeDialog = await openReceive(page, order, exchange.number);
        await setUnitState(exchangeDialog, 0, UNIT_STATES.keep);
        const due = exchangeDialog.getByText(/^お支払い待ち ￥[\d,]+/);
        await expect(due).toBeVisible();
        const shownDue = yenOf(await due.textContent() ?? undefined);
        expect(shownDue).toBe(800);
        await expectNoOverflow(page);
        await confirmButton(exchangeDialog, RETURN_TEXT.receiveAllExchange).click();
        await waitPosts(bridge, 1);
        const exchangeFees = await returnFeeRow(s.db, exchange.returnId);
        expect(exchangeFees.feeDueAmount).toBe(shownDue);
        expect(exchangeFees.exchangeFee + exchangeFees.exchangeShippingFee).toBe(shownDue);

        // 返品の受け取り: 返送料の行と返金額が、DB に残った返送料・返金の額と同じ
        await page.reload();
        const dialog = await openReceive(page, order, refund.number);
        await setUnitState(dialog, 0, UNIT_STATES.keep);
        const rows = await breakdownOf(dialog);
        const shownShipping = yenOf(rows['返送料']);
        const shownRefund = yenOf(rows['返金額']);
        expect(rows['返送料']).toContain('−');
        expect([shownShipping, shownRefund]).toEqual([800, 16_200]); // 17,000円 − 返送料 800円
        await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(shownRefund))).click();
        await waitPosts(bridge, 2);
        const refunds = await refundsOf(s.db, order.orderId);
        expect(refunds.map((r) => r.amount)).toEqual([shownRefund]);
        expect((await returnFeeRow(s.db, refund.returnId)).returnShippingFee).toBe(shownShipping);
        const events = await eventsOf(s.db, order.orderId);
        // 返送料は E の外。出来事の商品の額 17,000円は E のまま、手数料の累計（率）は0
        expect(events.at(-1)).toMatchObject({ standard_refund: 17_000, now_refund: 17_000, fee_amount: 0 });
        expect(shownRefund).toBe(events.at(-1)!.now_refund - shownShipping);
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-25: 割引の扱いを直すと見込みが変わり、直した店長と時刻が記録に残る', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub165-ac25-${viewport.name}`, async (s) => {
        // ジャケット 20,000円とパンツ 10,000円の組（17,000円と 8,500円）。不良のジャケットを交換できず返金する（例13）
        const order = await seedSnapshotOrder(s.db, {
          actorId: s.admin.userId, lines: [{ price: 20_000, quantity: 1 }, { price: 10_000, quantity: 1 }],
          definitions: ([jacket, pants]) => [amount('set', 4500, { kind: 'set', targetMode: 'include', itemIds: [jacket, pants] })],
        });
        await s.recordPaid(order.orderId);
        const ret = await createApprovedReturn(s.db, { orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId,
          groups: [{ orderItemId: order.orderItemIds[0], quantity: 1, reason: 'defective' }] });
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReceiveBridge(page, s.admin.userId);

        const dialog = await openReceive(page, order, ret.number);
        await setUnitState(dialog, 0, UNIT_STATES.keep);
        const treatment = dialog.getByRole('combobox', { name: '割引の扱い', exact: true });
        await expect(treatment).toHaveValue('shop'); // 初めの値は理由（破損・不良）から入る
        expect(yenOf((await breakdownOf(dialog))['返金額'])).toBe(17_000);

        await treatment.selectOption('customer');
        await expect(dialog.getByRole('button', { name: RETURN_TEXT.receiveAll(formatYen(15_500)) })).toBeVisible();
        expect(yenOf((await breakdownOf(dialog))['返金額'])).toBe(15_500); // 割引を取り直した分だけ少ない
        await expectNoOverflow(page);
        const before = Date.now();
        await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(15_500))).click();
        await waitPosts(bridge, 1);
        expect(bridge.posts[0].body.treatments).toEqual([{ returnLineId: ret.lineIds[0], treatment: 'customer' }]);

        expect((await refundsOf(s.db, order.orderId)).map((r) => r.amount)).toEqual([15_500]);
        const saved = (await s.db.query(`select treatment, actor_id, created_at, receipt_id from public.order_return_line_treatments
          where return_line_id=$1`, [ret.lineIds[0]])).rows;
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ treatment: 'customer', actor_id: s.admin.userId });
        expect(new Date(saved[0].created_at as string).getTime()).toBeGreaterThan(before - 60_000);
        const receipt = (await s.db.query('select id from public.order_return_receipts where return_id=$1', [ret.returnId])).rows[0];
        expect(saved[0].receipt_id).toBe(receipt.id);
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-09: セットのパンツをお客様のご都合で返すと、組がくずれて5,500円', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub165-ac09-${viewport.name}`, async (s) => {
        const order = await setOrder(s);
        expect([...order.paid[0]].sort((a, b) => a - b)).toEqual([17_000, 20_000]);
        expect(order.paid[1]).toEqual([8_500]);
        const ret = await createApprovedReturn(s.db, { orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId,
          groups: [{ orderItemId: order.orderItemIds[1], quantity: 1 }] });
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReceiveBridge(page, s.admin.userId);

        const dialog = await openReceive(page, order, ret.number);
        await setUnitState(dialog, 0, UNIT_STATES.keep);
        await expect(dialog.getByRole('combobox', { name: '割引の扱い', exact: true })).toHaveValue('customer');
        const rows = await breakdownOf(dialog);
        expect(yenOf(rows['返金額'])).toBe(5_500);
        await expectNoOverflow(page);
        await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(5_500))).click();
        await waitPosts(bridge, 1);
        expect((await refundsOf(s.db, order.orderId)).map((r) => r.amount)).toEqual([5_500]);
        // パンツ（払った 8,500円）の着が戻り、残るジャケット2着は割引なしの 20,000円になる
        const slots = await slotStates(s.db, order.orderId);
        expect(slots.filter((slot) => slot.state === 'returned_customer').map((slot) => [slot.orderItemId, slot.currentPrice]))
          .toEqual([[order.orderItemIds[1], 8_500]]);
        expect(slots.filter((slot) => slot.orderItemId === order.orderItemIds[0]).map((slot) => slot.currentPrice)).toEqual([20_000, 20_000]);
      }, { returnSettings: true });
    });
  });
}
