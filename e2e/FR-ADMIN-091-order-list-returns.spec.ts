/**
 * FR-ADMIN-091 注文の一覧の「返品」の列・絞り込み・上の一行・ボタン・CSV
 * 対応 FREQ: FREQ-468（AC-01〜AC-07）、FREQ-472（AC-01）
 *
 * 一覧は窓口の答えを差し替えて確かめる（実装計画 P11）。返品の状態と小さな印と「次にすること」の決まりは、窓口が使うのと同じ DB の関数
 * （list_order_return_summaries など）を手元の DB に直に呼んで確かめる。一覧の窓口そのものの組み立て（要約・絞り込み・数）は
 * 単体の試験（orders-search-route）が確かめる。
 */
import { expect, test, type Page } from '@playwright/test';
import { recordRefundResult, withLocalDb } from './order-email-test-utils';
import { mockOrderList, openOrderTab, orderLine, viewports } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  addVariant,
  cancelReturnInDb,
  createReturnInDb,
  createShippedOrder,
  exchangeOrderLine,
  orderIdsByReturnStatus,
  orderWithReturns,
  receiveReturnInDb,
  returnAttentionCounts,
  returnSummaryOf,
  returnSummaryRow,
  mockOrderListWithAttention,
} from './return-test-utils';
import type { OrderReturnSummary } from '@/lib/orders/returns/return-types';

const rowOf = (page: Page, id: string) => page.getByRole('row', { name: new RegExp(id) });

/** 返品の列に出る言葉と小さな印（C-5）。どれも、進み具合・支払い・ほかの印・ボタンの字と重ならない */
const STATE_WORDS = ['返品の申し込み', '返品中', '返金待ち', '返品済み'] as const;
const MARK_WORDS = ['受け取り待ち', '一部受け取り', '検品待ち', 'お支払い待ち'] as const;

type Case = {
  id: string;
  summary: Partial<OrderReturnSummary>;
  state: (typeof STATE_WORDS)[number] | null;
  marks: Array<(typeof MARK_WORDS)[number]>;
  /** 店長に出る「返品」系のボタンの名前（無ければ null） */
  adminButton: string | null;
  /** サポートの人に出るボタンの名前（無ければ null） */
  supporterButton: string | null;
};

const CASES: Case[] = [
  {
    id: 'ret-list-requested',
    summary: { displayStatus: 'requested', nextAction: 'review_request', requestedReturns: 1, hasReturnable: false },
    state: '返品の申し込み',
    marks: [],
    adminButton: '申し込みを確かめる',
    supporterButton: '申し込みを確かめる',
  },
  {
    id: 'ret-list-progress',
    summary: { displayStatus: 'in_progress', marks: ['awaiting_items'], nextAction: 'receive', hasReturnable: false },
    state: '返品中',
    marks: ['受け取り待ち'],
    adminButton: '受け取る',
    supporterButton: '受け取る',
  },
  {
    id: 'ret-list-fee',
    summary: { displayStatus: 'in_progress', marks: ['partially_received', 'awaiting_fee'], nextAction: 'receive', hasReturnable: false },
    state: '返品中',
    marks: ['一部受け取り', 'お支払い待ち'],
    adminButton: '受け取る',
    supporterButton: '受け取る',
  },
  {
    id: 'ret-list-inspect',
    summary: { displayStatus: 'in_progress', marks: ['pending_inspection'], nextAction: 'none', hasReturnable: false },
    state: '返品中',
    marks: ['検品待ち'],
    adminButton: '返品',
    supporterButton: '返品',
  },
  {
    id: 'ret-list-waiting',
    summary: { displayStatus: 'refund_waiting', nextAction: 'refund', refundWaitingReturns: 1, hasReturnable: false },
    state: '返金待ち',
    marks: [],
    adminButton: '額を決めて返金する',
    supporterButton: '返品',
  },
  {
    id: 'ret-list-done',
    summary: { displayStatus: 'returned', nextAction: 'none', hasReturnable: false },
    state: '返品済み',
    marks: [],
    adminButton: '返品',
    supporterButton: '返品',
  },
  {
    id: 'ret-list-new',
    summary: { displayStatus: null, nextAction: 'none', hasReturnable: true },
    state: null,
    marks: [],
    adminButton: '返品',
    supporterButton: '返品',
  },
  {
    id: 'ret-list-none',
    summary: { displayStatus: null, nextAction: 'none', hasReturnable: false },
    state: null,
    marks: [],
    adminButton: null,
    supporterButton: null,
  },
];

const BUTTON_NAMES = ['申し込みを確かめる', '額を決めて返金する', '受け取る', '返品'] as const;

function listRows() {
  return CASES.map((item) => orderWithReturns({ id: item.id, summary: returnSummaryOf({ orderId: item.id, ...item.summary }) }));
}

/** CSV の1行を、引用符つきの値に分ける（値の中の "" は ". カンマは値の一部） */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-091 order list returns (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('一覧に「返品」の列（進み具合と操作の間）が出て、返品の状態の言葉・小さな印・「—」が出る。言葉はほかの言葉と重ならない', async ({ page }) => {
      // FREQ-468-AC-01
      await mockAdminSessionAs(page, 'admin');
      await mockOrderList(page, listRows);
      await openOrderTab(page);
      await expect(rowOf(page, 'ret-list-waiting')).toBeVisible();

      expect(await page.getByRole('columnheader').allTextContents()).toEqual([
        '注文ID', '顧客名', '注文日', '購入商品', '商品数', '合計金額', '支払い', '進み具合', '返品', '操作',
      ]);
      for (const item of CASES) {
        const row = rowOf(page, item.id);
        // 返品の状態の言葉は、あれば1つだけ。小さな印は、決めた物だけ
        for (const word of STATE_WORDS) {
          await expect(row.getByText(word, { exact: true }), `${item.id} の「${word}」`).toHaveCount(word === item.state ? 1 : 0);
        }
        for (const word of MARK_WORDS) {
          await expect(row.getByText(word, { exact: true }), `${item.id} の「${word}」`).toHaveCount(item.marks.includes(word) ? 1 : 0);
        }
        // 返品の無い注文は「—」
        if (item.state === null) await expect(row.getByText('—', { exact: true })).toHaveCount(1);
      }
    });

    test('「返品」のボタンの名前は次にすることで変わり、返品も返品できる品も無い注文には出ない。サポートの人には「額を決めて返金する」が出ない', async ({ page }) => {
      // FREQ-468-AC-02
      for (const role of ['admin', 'supporter'] as const) {
        await mockAdminSessionAs(page, role);
        await mockOrderList(page, listRows);
        await openOrderTab(page);
        await expect(rowOf(page, 'ret-list-waiting')).toBeVisible();

        for (const item of CASES) {
          const expected = role === 'admin' ? item.adminButton : item.supporterButton;
          for (const name of BUTTON_NAMES) {
            await expect(
              rowOf(page, item.id).getByRole('button', { name, exact: true }),
              `${role} の ${item.id} の「${name}」`,
            ).toHaveCount(name === expected ? 1 : 0);
          }
        }
      }
    });

    test('絞り込みの欄「返品」を選ぶと、窓口へ return=<値> が届く。「すべて」では頼まない', async ({ page }) => {
      // FREQ-468-AC-03
      // ここで確かめるのは、画面が窓口へ頼む問いまで。窓口が実際に一覧を絞る動きは、単体の試験（orders-search-route）が確かめる
      await mockAdminSessionAs(page, 'admin');
      const list = await mockOrderList(page, listRows);
      await openOrderTab(page);
      const filter = page.getByRole('combobox', { name: '返品', exact: true });
      expect(await filter.locator('option').allTextContents()).toEqual(['すべて', '返品の申し込み', '返品中', '返金待ち', '返品済み']);
      expect(list.urls.every((url) => !new URL(url).searchParams.has('return'))).toBe(true);

      await filter.selectOption({ label: '返金待ち' });
      await expect.poll(() => list.urls.some((url) => new URL(url).searchParams.get('return') === 'refund_waiting')).toBe(true);
      await filter.selectOption({ label: '返品中' });
      await expect.poll(() => list.urls.some((url) => new URL(url).searchParams.get('return') === 'in_progress')).toBe(true);
      await filter.selectOption({ label: 'すべて' });
      await expect.poll(() => new URL(list.urls[list.urls.length - 1]).searchParams.has('return')).toBe(false);
    });

    test('一覧の上の一行が、返品の申し込みと返金待ちの件数を出し（0件は出さない・両方0件なら行ごと出さない）、押すとその絞り込みだけの一覧になり（ほかの絞り込みは全部外れる）、もう一度押すと返品の絞り込みが外れる', async ({ page }) => {
      // FREQ-468-AC-04
      let attention = { requested: 1, refundWaiting: 2 };
      await mockAdminSessionAs(page, 'admin');
      const list = await mockOrderListWithAttention(page, listRows, () => attention);
      await openOrderTab(page);
      const line = page.getByTestId('return-attention');
      const requested = line.getByRole('button', { name: '返品の申し込み 1件', exact: true });
      const waiting = line.getByRole('button', { name: '返金待ち 2件', exact: true });

      await expect(requested).toBeVisible();
      await expect(waiting).toBeVisible();
      await expect(line).toContainText('返品の申し込み 1件・返金待ち 2件');
      await expect(waiting).toHaveAttribute('aria-pressed', 'false');

      // ほかの絞り込み（状態・要確認のみ・取引先・注文・決済ID・金額の下限と上限・期間）を全部入れていても、一行の数を押すと、
      // ほかの絞り込みは全部外れて、その絞り込みだけの一覧になる（数と一覧の件数を合わせるため。Shopify の件数のリンクと同じ）。
      // もう一度押すと返品の絞り込みだけが外れ、外れたほかの絞り込みは戻らない
      const shippedChip = page.getByRole('button', { name: '発送済み（配送中・配達済み）', exact: true });
      const reviewOnly = page.getByRole('button', { name: '要確認のみ', exact: true });
      const counterparty = page.getByPlaceholder('顧客名 / メール', { exact: true });
      const reference = page.getByPlaceholder('注文ID / pi_...', { exact: true });
      const amountMin = page.getByLabel('金額（下限）', { exact: true });
      const amountMax = page.getByLabel('金額（上限）', { exact: true });
      const periodFrom = page.locator('#orders-from');
      const periodTo = page.locator('#orders-to');
      const otherFilterKeys = ['status', 'review', 'counterparty', 'reference', 'amountMin', 'amountMax', 'from', 'to'] as const;
      const lastParams = () => new URL(list.urls[list.urls.length - 1]).searchParams;
      const otherFilters = () => Object.fromEntries(otherFilterKeys.map((key) => [key, lastParams().get(key)]));

      await shippedChip.click();
      await reviewOnly.click();
      await counterparty.fill('山田');
      await reference.fill('pi_e2e');
      await amountMin.fill('1000');
      await amountMax.fill('90000');
      await periodFrom.fill('2026-10-01');
      await periodTo.fill('2026-10-31');
      await page.getByRole('button', { name: '期間適用', exact: true }).click();
      await expect
        .poll(otherFilters)
        .toEqual({
          status: 'shipped',
          review: 'only',
          counterparty: '山田',
          reference: 'pi_e2e',
          amountMin: '1000',
          amountMax: '90000',
          from: '2026-10-01',
          to: '2026-10-31',
        });
      expect(lastParams().has('return')).toBe(false);

      await requested.click();
      await expect(requested).toHaveAttribute('aria-pressed', 'true');
      await expect(shippedChip).toHaveAttribute('aria-pressed', 'false');
      await expect(reviewOnly).toHaveAttribute('aria-pressed', 'false');
      for (const input of [counterparty, reference, amountMin, amountMax, periodFrom, periodTo]) await expect(input).toHaveValue('');
      await expect.poll(() => lastParams().get('return')).toBe('requested');
      expect(otherFilterKeys.filter((key) => lastParams().has(key))).toEqual([]);

      await requested.click();
      await expect(requested).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => lastParams().has('return')).toBe(false);
      expect(otherFilterKeys.filter((key) => lastParams().has(key))).toEqual([]);

      await waiting.click();
      await expect(waiting).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => list.urls.some((url) => new URL(url).searchParams.get('return') === 'refund_waiting')).toBe(true);
      await waiting.click();
      await expect(waiting).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => new URL(list.urls[list.urls.length - 1]).searchParams.has('return')).toBe(false);

      // 0件の数は出さない。両方0件なら行ごと出さない（画面を開き直して、新しい数を読む）
      attention = { requested: 0, refundWaiting: 3 };
      await openOrderTab(page);
      await expect(line.getByRole('button', { name: '返金待ち 3件', exact: true })).toBeVisible();
      await expect(line.getByRole('button', { name: /^返品の申し込み/ })).toHaveCount(0);
      attention = { requested: 0, refundWaiting: 0 };
      await openOrderTab(page);
      await expect(rowOf(page, 'ret-list-waiting')).toBeVisible();
      await expect(page.getByTestId('return-attention')).toHaveCount(0);
    });

    test('CSV の見出しの最後に「返品」が足され、返品の状態の言葉と、購入商品の交換の品の印が入る。購入商品の欄にも交換の品の印が出る', async ({ page }) => {
      // FREQ-468-AC-05, FREQ-472-AC-01
      // 元の品は発送済み。交換の品は未発送（発送準備中）。商品数は窓口が交換の品の行を外して数える（ここでは窓口の答えをそのまま差し替える）
      const order = orderWithReturns({
        id: 'ret-csv-order',
        items: [
          orderLine({ id: 'c9000000-0000-4000-8000-000000000001', name: 'E2Eシャツ', color: 'ホワイト', size: 'M', quantity: 1, shipped: 1, readyUnshipped: 0 }),
          exchangeOrderLine({ id: 'c9000000-0000-4000-8000-000000000002', name: 'E2Eシャツ', color: 'ホワイト', size: 'L', quantity: 1, readyUnshipped: 1 }),
        ],
        itemCount: '1点',
        status: '発送準備中',
        orderStatus: 'paid',
        progressKey: 'ready',
        partiallyShipped: true,
        canShip: true,
        summary: returnSummaryOf({ orderId: 'ret-csv-order', displayStatus: 'in_progress', marks: ['awaiting_fee'], nextAction: 'none', hasReturnable: false }),
      });
      await mockAdminSessionAs(page, 'admin');
      await mockOrderList(page, () => [order]);
      await openOrderTab(page);

      // 購入商品の欄: 交換の品の行は「（交換の品・{数の言葉}）」（受け取った直後は発送準備中か受注生産中の数を持つ。実装計画 C-5）、
      // ふつうの行は今までの書き方のまま（印が付かない）
      const row = rowOf(page, 'ret-csv-order');
      await expect(row.getByText('E2Eシャツ（ホワイト / L） × 1（交換の品・発送準備中 1）')).toBeVisible();
      await expect(row.getByText('E2Eシャツ（ホワイト / M）×1（発送済み 1）')).toBeVisible();
      await expect(row.getByText('（交換の品', { exact: false })).toHaveCount(1);

      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: '表示中の注文をCSV出力' }).click();
      const stream = await (await downloading).createReadStream();
      if (!stream) throw new Error('CSV の中身を読めなかった');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const lines = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').split('\n');

      expect(lines[0]).toBe('注文ID,顧客名,顧客メール,注文日,購入商品,商品数,合計金額,進み具合,支払い,返金額,返品');
      const values = parseCsvLine(lines[1]);
      expect(values).toHaveLength(11);
      expect(values[0]).toBe('ret-csv-order');
      expect(values[4]).toContain('（交換の品）');
      expect(values[10]).toBe('返品中');
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
