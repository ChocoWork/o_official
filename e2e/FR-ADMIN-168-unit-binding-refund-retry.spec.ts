/**
 * FR-ADMIN-168 受け取りの時の返金（今すぐ）が失敗した後の「額を決めて返金する」
 * 対応 FREQ: FREQ-642-AC-37。詳細設計: docs/04_DetailDesign/pages/16_admin.md（DD-ADMIN-022）
 *
 * 写しのある注文（20,000円×2・送料 800円）の返品を、今すぐ1着・相談1着（または今すぐ1着だけ）で手元の DB に受け取り（DB の試験と同じ入口）、今すぐの返金の結果を
 * DB の試験と同じ関数（record_order_refund_result）で「失敗」または「手続き中」にしてから、画面の「額を決めて返金する」を開く。
 * 見込みの窓口（receive-estimate）は本番ビルドの本物を通し、確定の窓口だけを窓口と同じ入口に差し替えて Stripe を偽物にする。
 * 返品の設定の行を書き換えるので isolated-global で流す。
 */
import { expect, test, type Page } from '@playwright/test';
import { CHECKOUT_VIEWPORTS } from './checkout-flow-helpers';
import { installDiscountDbBridge, withDiscountScenario, type DiscountScenario } from './discount-test-utils';
import { detailSection, openOrderDetail } from './order-fulfillment-test-utils';
import { confirmButton, formatYen, openReturnRefundDialog, readReturnBreakdown, returnLabelOf } from './return-test-utils';
import { createApprovedReturn, installReturnRefundBridge, refundsOf, seedSnapshotOrder, yenOf } from './unit-binding-test-utils';
import { hResult } from '../tests/integration/db/helpers/group-h-refund-fixtures';
import { ubReceive } from '../tests/integration/db/helpers/unit-binding-receive';

const ESTIMATING = '計算しています';

/** 注文の送料。受け取りの時の今すぐの返金で、この送料も返す */
const SHIPPING = 800;

/** 返品2着を今すぐ1着・相談1着（nowOnly なら今すぐ1着だけ）で受け取り、今すぐの返金（送料 800円付き）の結果を status にする */
async function receiveMixed(s: DiscountScenario, status: 'failed' | 'pending', nowOnly = false) {
  const order = await seedSnapshotOrder(s.db, {
    actorId: s.admin.userId, lines: [{ price: 20_000, quantity: 2 }], definitions: () => [], shipping: SHIPPING,
  });
  await s.recordPaid(order.orderId);
  const ret = await createApprovedReturn(s.db, {
    orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId,
    groups: [{ orderItemId: order.orderItemIds[0], quantity: 1 }, { orderItemId: order.orderItemIds[0], quantity: 1 }],
  });
  const received = nowOnly
    ? await ubReceive(s.db, { returnId: ret.returnId, actorId: s.admin.userId, choice: 'now', shipping: SHIPPING, units: [
      { return_line_id: ret.lineIds[0], disposition: 'not_restocked', quantity: 1 },
    ] })
    : await ubReceive(s.db, { returnId: ret.returnId, actorId: s.admin.userId, choice: 'mixed', shipping: SHIPPING, units: [
      { return_line_id: ret.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'now' },
      { return_line_id: ret.lineIds[1], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' },
    ] });
  await hResult(s.db, received.refund_id as string, status);
  return { order, ret, nowRefundId: received.refund_id as string };
}

/** 注文の詳細 → 返品の画面 → その返品の「額を決めて返金する」を開き、見込みが出るまで待つ */
async function openRefund(page: Page, orderId: string, number: number) {
  await openOrderDetail(page, orderId);
  await detailSection(page, '返品とキャンセルの申し込み').getByRole('button', { name: /^(返品|受け取る|額を決めて返金する)$/ }).first().click();
  const dialog = await openReturnRefundDialog(page, orderId, returnLabelOf(orderId, number));
  await expect(dialog.getByText(ESTIMATING, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('group', { name: '返金の内訳', exact: true })).toBeVisible();
  return dialog;
}

async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
}

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-168 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-37: 今すぐの返金が失敗した後は、標準の額が失敗した今すぐの分と相談の分の和で、送料の欄は失敗した返金の送料で始まり、1つの返金で受け付ける', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub168-failed-${viewport.name}`, async (s) => {
        const { order, ret, nowRefundId } = await receiveMixed(s, 'failed');
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReturnRefundBridge(page, s.admin.userId);
        const dialog = await openRefund(page, order.orderId, ret.number);
        const breakdown = await readReturnBreakdown(dialog);
        expect(yenOf(breakdown['商品'])).toBe(40_000);
        // 送料の欄は、失敗した今すぐの返金の送料（800円）で始まる
        expect(yenOf(breakdown['送料'])).toBe(SHIPPING);
        await expect(dialog.getByRole('spinbutton', { name: /^送料/ })).toHaveValue(String(SHIPPING));
        expect(yenOf(breakdown['返金額'])).toBe(40_000 + SHIPPING);
        await expectNoOverflow(page);
        await confirmButton(dialog, `${formatYen(40_000 + SHIPPING)} を返金する`).click();
        await expect.poll(() => bridge.results.length, { timeout: 60_000 }).toBe(1);
        // 見込みと同じ額なので、額は送らない（DB が同じ式で出す）。送料は初めの値のまま送る
        expect(bridge.posts[0].body.amount).toBeNull();
        expect(bridge.posts[0].body.shippingAmount).toBe(SHIPPING);
        const refunds = await refundsOf(s.db, order.orderId);
        expect(refunds.map((r) => [r.id === nowRefundId ? 'now' : 'retry', r.status, r.amount]))
          .toEqual([['now', 'failed', 20_000 + SHIPPING], ['retry', 'succeeded', 40_000 + SHIPPING]]);
        const retryId = refunds[1].id;
        expect((await s.db.query('select part from public.order_unit_event_refunds where refund_id=$1 order by part', [retryId])).rows)
          .toEqual([{ part: 'consult' }, { part: 'now' }]);
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-37: 今すぐの返金が手続き中なら二度は返さず、標準の額は相談の分だけ', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub168-pending-${viewport.name}`, async (s) => {
        const { order, ret } = await receiveMixed(s, 'pending');
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReturnRefundBridge(page, s.admin.userId);
        const dialog = await openRefund(page, order.orderId, ret.number);
        const breakdown = await readReturnBreakdown(dialog);
        expect(yenOf(breakdown['商品'])).toBe(20_000);
        // 今すぐの分を返し直さないので、送料の欄は 0 で始まる
        expect(yenOf(breakdown['送料'])).toBe(0);
        await expectNoOverflow(page);
        await confirmButton(dialog, `${formatYen(20_000)} を返金する`).click();
        await expect.poll(() => bridge.results.length, { timeout: 60_000 }).toBe(1);
        expect((await refundsOf(s.db, order.orderId)).map((r) => [r.status, r.amount])).toEqual([['pending', 20_000 + SHIPPING], ['succeeded', 20_000]]);
      }, { returnSettings: true });
    });

    test('FREQ-642-AC-37: 今すぐだけの受け取りの返金が失敗した後は、標準の額が今すぐの分で、送料の欄は失敗した返金の送料で始まる', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub168-now-only-${viewport.name}`, async (s) => {
        const { order, ret, nowRefundId } = await receiveMixed(s, 'failed', true);
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReturnRefundBridge(page, s.admin.userId);
        const dialog = await openRefund(page, order.orderId, ret.number);
        const breakdown = await readReturnBreakdown(dialog);
        expect(yenOf(breakdown['商品'])).toBe(20_000);
        expect(yenOf(breakdown['送料'])).toBe(SHIPPING);
        expect(yenOf(breakdown['返金額'])).toBe(20_000 + SHIPPING);
        await expectNoOverflow(page);
        await confirmButton(dialog, `${formatYen(20_000 + SHIPPING)} を返金する`).click();
        await expect.poll(() => bridge.results.length, { timeout: 60_000 }).toBe(1);
        const refunds = await refundsOf(s.db, order.orderId);
        expect(refunds.map((r) => [r.id === nowRefundId ? 'now' : 'retry', r.status, r.amount]))
          .toEqual([['now', 'failed', 20_000 + SHIPPING], ['retry', 'succeeded', 20_000 + SHIPPING]]);
        expect((await s.db.query('select part from public.order_unit_event_refunds where refund_id=$1', [refunds[1].id])).rows)
          .toEqual([{ part: 'now' }]);
      }, { returnSettings: true });
    });
  });
}
