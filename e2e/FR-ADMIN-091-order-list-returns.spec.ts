/**
 * FR-ADMIN-091 注文一覧表の上の一行（返品の申し込み・返金待ち・キャンセルの申し込みの件数）と、返品の表示の状態の決まり
 * 対応 FREQ: FREQ-468（AC-04・AC-06・AC-07）
 *
 * G-4 で旧い注文の一覧の「返品」の列・返品のボタン・絞り込み return=・CSV の返品の列は撤去した。この試験が残す確かめは2つ。
 * - 一覧の上の一行は、注文一覧表（/admin/orders）の窓口の答えを差し替えて確かめる（実装計画 P11）。
 * - 返品の状態と小さな印と「次にすること」の決まりは、窓口が使うのと同じ DB の関数（list_order_return_summaries など）を手元の DB に直に呼んで確かめる。
 * 撤去した case の移設先: 列・状態の言葉・小さな印 → FR-ADMIN-110 ⑤（返品の途中の状態は品物のステータスの数量になった）、
 * 「返品」のボタンの名前が次にすることで変わる／サポートの人に「額を決めて返金する」が出ない → FR-ADMIN-122 ②、
 * 絞り込み return= → FR-ADMIN-121 ④（ステータスの絞り込み）、CSV の返品の列 → FR-ADMIN-121 ⑦・110 ⑤。
 */
import { expect, test } from '@playwright/test';
import { recordRefundResult, withLocalDb } from './order-email-test-utils';
import { applyFilters, filterForm, mockOrderAttention, openOrderList, statusGroup } from './order-admin-test-utils';
import { emptyOrderItemList, mockOrderItemList, viewports } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  addVariant,
  cancelReturnInDb,
  createReturnInDb,
  createShippedOrder,
  orderIdsByReturnStatus,
  receiveReturnInDb,
  returnAttentionCounts,
  returnSummaryRow,
} from './return-test-utils';

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-091 order list returns (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('一覧の上の一行が、返品の申し込み・返金待ち・キャンセルの申し込みの件数を出し（0件は出さない・全部0件なら行ごと出さない）、押すとその状態だけの絞り込みになり（ほかの絞り込みは全部外れる）、もう一度押すと状態の絞り込みが外れる', async ({ page }) => {
      // FREQ-468-AC-04
      let attention = { requested: 1, refundWaiting: 2 };
      let cancelRequests = 3;
      await mockAdminSessionAs(page, 'admin');
      await mockOrderAttention(page);
      const list = await mockOrderItemList(page, () => ({ ...emptyOrderItemList(), returnAttention: attention, cancelRequestAttention: cancelRequests }));
      await openOrderList(page);
      const line = page.getByTestId('return-attention');
      const requested = line.getByRole('button', { name: '返品の申し込み 1件', exact: true });
      const waiting = line.getByRole('button', { name: '返金待ち 2件', exact: true });
      const cancelRequested = line.getByRole('button', { name: 'キャンセルの申し込み 3件', exact: true });

      await expect(requested).toBeVisible();
      await expect(waiting).toBeVisible();
      await expect(cancelRequested).toBeVisible();
      await expect(line).toContainText('返品の申し込み 1件・返金待ち 2件・キャンセルの申し込み 3件');
      await expect(waiting).toHaveAttribute('aria-pressed', 'false');

      // ほかの絞り込み（日付・注文ID・顧客名・メール・商品名・色・サイズ・ステータス・要対応のみ）を全部入れていても、一行の数を押すと、
      // ほかの絞り込みは全部外れて、その状態だけの絞り込みになる（数と一覧の件数を合わせるため。Shopify の件数のリンクと同じ）。
      // もう一度押すと状態の絞り込みだけが外れ、外れたほかの絞り込みは戻らない
      const fieldLabels = ['注文日（から）', '注文日（まで）', '注文ID', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ'] as const;
      const otherFilterKeys = ['dateFrom', 'dateTo', 'orderNumber', 'customer', 'email', 'product', 'color', 'size', 'attention'] as const;
      const lastParams = () => new URL(list.urls[list.urls.length - 1]).searchParams;
      const otherFilters = () => ({
        ...Object.fromEntries(otherFilterKeys.map((key) => [key, lastParams().get(key)])),
        status: lastParams().getAll('status'),
      });

      await applyFilters(page, {
        dateFrom: '2026-10-01',
        dateTo: '2026-10-31',
        orderNumber: 'pi_e2e',
        customer: '山田',
        email: 'hanako@example.com',
        product: 'シルク',
        color: 'ホワイト',
        size: 'M',
        statuses: ['発送済み', '配達済み'],
        attentionOnly: true,
      });
      await expect
        .poll(otherFilters)
        .toEqual({
          dateFrom: '2026-10-01',
          dateTo: '2026-10-31',
          orderNumber: 'pi_e2e',
          customer: '山田',
          email: 'hanako@example.com',
          product: 'シルク',
          color: 'ホワイト',
          size: 'M',
          attention: '1',
          status: ['shipped', 'delivered'],
        });

      await requested.click();
      await expect(requested).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastParams().getAll('status')).toEqual(['return_requested']);
      expect(otherFilterKeys.filter((key) => lastParams().has(key))).toEqual([]);
      // 入力の欄とトグルも、その状態だけの形に戻る
      for (const label of fieldLabels) await expect(filterForm(page).getByLabel(label, { exact: true })).toHaveValue('');
      await expect(filterForm(page).getByRole('button', { name: '要対応のみ', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(statusGroup(page).getByRole('button', { name: '発送済み', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(statusGroup(page).getByRole('button', { name: '返品申請中', exact: true })).toHaveAttribute('aria-pressed', 'true');

      await requested.click();
      await expect(requested).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => lastParams().getAll('status')).toEqual([]);
      expect(otherFilterKeys.filter((key) => lastParams().has(key))).toEqual([]);

      await waiting.click();
      await expect(waiting).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastParams().getAll('status')).toEqual(['refund_waiting']);
      // 押している数を替えると、替えた先の状態だけになる
      await cancelRequested.click();
      await expect(waiting).toHaveAttribute('aria-pressed', 'false');
      await expect(cancelRequested).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastParams().getAll('status')).toEqual(['cancel_requested']);
      await cancelRequested.click();
      await expect(cancelRequested).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => lastParams().getAll('status')).toEqual([]);

      // 0件の数は出さない。全部0件なら行ごと出さない（画面を開き直して、新しい数を読む）
      attention = { requested: 0, refundWaiting: 3 };
      cancelRequests = 0;
      await openOrderList(page);
      await expect(line.getByRole('button', { name: '返金待ち 3件', exact: true })).toBeVisible();
      await expect(line.getByRole('button', { name: /^返品の申し込み/ })).toHaveCount(0);
      await expect(line.getByRole('button', { name: /^キャンセルの申し込み/ })).toHaveCount(0);
      attention = { requested: 0, refundWaiting: 0 };
      await openOrderList(page);
      await expect(page.getByTestId('return-attention')).toHaveCount(0);
    });

    test('返品の表示の状態・小さな印・次にすることが、決まりどおりに出る。返品が2つある注文はいちばん手前を出し、取消の返品しかない注文には出さない。絞り込みの番号に入る（手元の DB）', async () => {
      // FREQ-468-AC-06, FREQ-468-AC-07
      await withLocalDb(async (db) => {
        const shirtLines = (quantity: number) => [
          { name: 'E2Eシャツ', quantity, fulfillmentType: 'stock' as const },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' as const },
        ];
        const make = (label: string, quantity: number) => createShippedOrder(db, `${label}-${viewport.name}`, shirtLines(quantity));

        // 受け取り待ち（作っただけ）
        const open = await make('list-open', 1);
        await createReturnInDb(db, open, { lines: [{ orderItemId: open.orderItemIds[0], quantity: 1 }], notify: false });
        // 一部受け取り（2点のうち1点を相談で受け取った）
        const partial = await make('list-partial', 2);
        const partialReturn = await createReturnInDb(db, partial, { lines: [{ orderItemId: partial.orderItemIds[0], quantity: 2 }], notify: false });
        await receiveReturnInDb(db, partialReturn.returnId, partial.actorId, {
          units: [{ lineId: partialReturn.lineIds[partial.orderItemIds[0]], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
          notify: false,
        });
        // 返金待ち（全部を相談で受け取った）
        const waiting = await make('list-waiting', 1);
        const waitingReturn = await createReturnInDb(db, waiting, { lines: [{ orderItemId: waiting.orderItemIds[0], quantity: 1 }], notify: false });
        await receiveReturnInDb(db, waitingReturn.returnId, waiting.actorId, {
          units: [{ lineId: waitingReturn.lineIds[waiting.orderItemIds[0]], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
          notify: false,
        });
        // 検品待ち
        const inspecting = await make('list-inspect', 1);
        const inspectReturn = await createReturnInDb(db, inspecting, { lines: [{ orderItemId: inspecting.orderItemIds[0], quantity: 1 }], notify: false });
        await receiveReturnInDb(db, inspectReturn.returnId, inspecting.actorId, {
          units: [{ lineId: inspectReturn.lineIds[inspecting.orderItemIds[0]], disposition: 'pending_inspection', quantity: 1 }],
          choice: 'consult',
          notify: false,
        });
        // お支払い待ち（交換の手数料が残っている）
        const fee = await make('list-fee', 1);
        const variantL = await addVariant(db, fee.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
        const feeReturn = await createReturnInDb(db, fee, {
          lines: [{ orderItemId: fee.orderItemIds[0], quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          exchangeFee: 500,
          notify: false,
        });
        await receiveReturnInDb(db, feeReturn.returnId, fee.actorId, {
          units: [{ lineId: feeReturn.lineIds[fee.orderItemIds[0]], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
          notify: false,
        });
        // 返品済み（今返金し、Stripe が受け付けた）
        const done = await make('list-done', 1);
        const doneReturn = await createReturnInDb(db, done, { lines: [{ orderItemId: done.orderItemIds[0], quantity: 1 }], notify: false });
        const doneReceived = await receiveReturnInDb(db, doneReturn.returnId, done.actorId, {
          units: [{ lineId: doneReturn.lineIds[done.orderItemIds[0]], disposition: 'restocked', quantity: 1 }],
          choice: 'now',
          notify: false,
        });
        await recordRefundResult(db, doneReceived.refundId as string);
        // 返品が2つ（返金待ちと、受け取り待ち）
        const two = await make('list-two', 2);
        const twoFirst = await createReturnInDb(db, two, { lines: [{ orderItemId: two.orderItemIds[0], quantity: 1 }], notify: false });
        await createReturnInDb(db, two, { lines: [{ orderItemId: two.orderItemIds[0], quantity: 1 }], notify: false });
        await receiveReturnInDb(db, twoFirst.returnId, two.actorId, {
          units: [{ lineId: twoFirst.lineIds[two.orderItemIds[0]], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
          notify: false,
        });
        // 取消の返品しかない
        const cancelled = await make('list-cancelled', 1);
        const cancelledReturn = await createReturnInDb(db, cancelled, { lines: [{ orderItemId: cancelled.orderItemIds[0], quantity: 1 }], notify: false });
        await cancelReturnInDb(db, cancelledReturn.returnId, cancelled.actorId);

        expect(await returnSummaryRow(db, open.orderId)).toMatchObject({ display_status: 'in_progress', marks: ['awaiting_items'], next_action: 'receive', has_returnable: true });
        expect((await returnSummaryRow(db, partial.orderId)).marks).toContain('partially_received');
        expect(await returnSummaryRow(db, partial.orderId)).toMatchObject({ display_status: 'in_progress' });
        expect(await returnSummaryRow(db, waiting.orderId)).toMatchObject({ display_status: 'refund_waiting', next_action: 'refund', refund_waiting_returns: 1 });
        expect(await returnSummaryRow(db, inspecting.orderId)).toMatchObject({ display_status: 'in_progress' });
        expect((await returnSummaryRow(db, inspecting.orderId)).marks).toContain('pending_inspection');
        expect(await returnSummaryRow(db, fee.orderId)).toMatchObject({ display_status: 'in_progress' });
        expect((await returnSummaryRow(db, fee.orderId)).marks).toContain('awaiting_fee');
        expect(await returnSummaryRow(db, done.orderId)).toMatchObject({ display_status: 'returned', next_action: 'none' });
        // 返金待ちと受け取り待ちの返品が1つずつある注文は、いちばん手前の「返品中」を出す
        expect(await returnSummaryRow(db, two.orderId)).toMatchObject({ display_status: 'in_progress', refund_waiting_returns: 1 });
        // 取消の返品しかない注文には、返品の状態を出さない
        expect(await returnSummaryRow(db, cancelled.orderId)).toMatchObject({ display_status: null, marks: [], next_action: 'none' });

        // 絞り込みの番号（表示の状態ごと）。どれか1つでもその状態の返品がある注文が入る（返品が2つある注文は、両方の絞り込みに入る）。
        // ほかの試験の注文も入るので、入っているか・入っていないかだけを見る
        const waitingIds = await orderIdsByReturnStatus(db, 'refund_waiting');
        const progressIds = await orderIdsByReturnStatus(db, 'in_progress');
        const returnedIds = await orderIdsByReturnStatus(db, 'returned');
        expect(waitingIds).toEqual(expect.arrayContaining([waiting.orderId, two.orderId]));
        expect(progressIds).toEqual(expect.arrayContaining([open.orderId, partial.orderId, inspecting.orderId, fee.orderId, two.orderId]));
        expect(progressIds).not.toContain(waiting.orderId);
        expect(returnedIds).toContain(done.orderId);
        for (const ids of [waitingIds, progressIds, returnedIds]) expect(ids).not.toContain(cancelled.orderId);
        // 一覧の上の一行の数は、返金待ちの返品がある注文を数える（全部の注文の数なので、下限で見る）
        expect((await returnAttentionCounts(db)).refundWaiting).toBeGreaterThanOrEqual(2);
        // 絞り込みの番号の数と一行の数は合う（どちらも、その状態の返品がある注文を数える。Task 2）。並行して動く試験が注文を増やすので、
        // 別々の文で読むと食い違う。1つの文なら同じ時点の物を読めるので、1つの文で読んで比べる
        const same = (
          await db.query(
            `select (select count(*) from public.list_order_ids_by_return_status('refund_waiting'))::int as filtered,
                    (select refund_waiting from public.count_order_return_attention()) as counted`,
          )
        ).rows[0] as { filtered: number; counted: number };
        expect(same.filtered).toBe(same.counted);
      });
    });
  });
}
