/**
 * FR-ADMIN-069 受注生産中と仕上がりの記録
 * 対応 FREQ: FREQ-440（AC-01〜AC-05）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P11）。受注生産中の品が送れないこと・記録の条件（AC-05）は、
 * 手元の DB の関数を直に呼んで確かめる。仕上がりの画面は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { OrderHistoryCompletionCancelEntry, OrderHistoryCompletionEntry, OrderHistoryResponse } from '@/lib/orders/email/order-history';
import type {
  CancelCompletionResponse,
  CreateFulfillmentRequest,
  CreateFulfillmentResponse,
  FulfillmentErrorResponse,
  RecordCompletionRequest,
  RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';
import type { OrderProgress } from '@/lib/orders/order-progress';
import {
  cancelCompletion,
  createActor,
  createFulfillment,
  createOrderWithLines,
  expectDbError,
  lineCounts,
  recordCompletion,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  READY_PROGRESS,
  UUID_PATTERN,
  adminOrder,
  fulfillJson,
  historyOf,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  orderNumberOf,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a2b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b2b2c3d4-0000-4000-8000-000000000001';
const COAT = 'b2b2c3d4-0000-4000-8000-000000000002';
const COMPLETION_ID = 'c2b2c3d4-0000-4000-8000-000000000001';

/** 窓口の向こうの記録の代わり。ブラウス（在庫の品1つ）とコート（受注生産の品2つ）の、送った数とコートの仕上がった数 */
type MadeState = {
  shipped: Record<string, number>;
  completed: number;
  completionPosts: RecordCompletionRequest[];
  shipPosts: CreateFulfillmentRequest[];
};

function newState(shipped: Record<string, number> = {}, completed = 0): MadeState {
  return { shipped, completed, completionPosts: [], shipPosts: [] };
}

function countsOf(state: MadeState) {
  const blouseShipped = state.shipped[BLOUSE] ?? 0;
  const coatShipped = state.shipped[COAT] ?? 0;
  return [
    { id: BLOUSE, name: 'シルクブラウス', type: 'stock' as const, quantity: 1, shipped: blouseShipped, inProduction: 0, ready: 1 - blouseShipped },
    { id: COAT, name: 'ウールコート', type: 'backorder' as const, quantity: 2, shipped: coatShipped, inProduction: 2 - state.completed, ready: state.completed - coatShipped },
  ];
}

function summaryOf(state: MadeState) {
  const lines = countsOf(state);
  const sum = (pick: (line: (typeof lines)[number]) => number) => lines.reduce((total, line) => total + pick(line), 0);
  const shipped = sum((line) => line.shipped);
  const unshipped = sum((line) => line.quantity - line.shipped);
  return { shipped, unshipped, inProduction: sum((line) => line.inProduction), partiallyShipped: shipped > 0 && unshipped > 0 };
}

function progressOf(state: MadeState): OrderProgress {
  const { unshipped, inProduction, partiallyShipped } = summaryOf(state);
  if (unshipped === 0) return { key: 'in_transit', label: '配送中', partiallyShipped };
  if (inProduction > 0) return { key: 'in_production', label: '受注生産中', partiallyShipped };
  return { ...READY_PROGRESS, partiallyShipped };
}

function rowOf(state: MadeState) {
  const items = countsOf(state).map((line) =>
    orderLine({
      id: line.id, name: line.name, quantity: line.quantity, fulfillmentType: line.type,
      shipped: line.shipped, inProduction: line.inProduction, readyUnshipped: line.ready,
    }));
  const progress = progressOf(state);
  if (progress.key === 'in_transit') {
    return adminOrder({ id: ORDER_ID, items, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false });
  }
  return adminOrder({
    id: ORDER_ID,
    items,
    status: progress.label,
    progressKey: progress.key,
    partiallyShipped: progress.partiallyShipped,
    canRecordCompletion: summaryOf(state).inProduction > 0,
  });
}

function materialsOf(state: MadeState) {
  return shipMaterials({
    orderId: ORDER_ID,
    progress: progressOf(state),
    lines: countsOf(state).map((line) =>
      materialLine({
        orderItemId: line.id, name: line.name, quantity: line.quantity, fulfillmentType: line.type,
        shipped: line.shipped, inProduction: line.inProduction, readyUnshipped: line.ready,
      })),
  });
}

async function mockMadeApis(page: Page, state: MadeState) {
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => [rowOf(state)]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments`, async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, materialsOf(state));
      return;
    }
    const body = route.request().postDataJSON() as CreateFulfillmentRequest;
    state.shipPosts.push(body);
    for (const line of body.lines) state.shipped[line.orderItemId] = (state.shipped[line.orderItemId] ?? 0) + line.quantity;
    const completes = summaryOf(state).unshipped === 0;
    await fulfillJson(route, {
      fulfillmentId: randomUUID(),
      number: state.shipPosts.length,
      completesOrder: completes,
      orderStatus: completes ? 'shipped' : 'paid',
      replayed: false,
    } satisfies CreateFulfillmentResponse);
  });
  await page.route(`**/api/admin/orders/${ORDER_ID}/completions`, async (route) => {
    const body = route.request().postDataJSON() as RecordCompletionRequest;
    state.completionPosts.push(body);
    for (const line of body.lines) if (line.orderItemId === COAT) state.completed += line.quantity;
    await fulfillJson(route, { completionIds: [COMPLETION_ID], replayed: false } satisfies RecordCompletionResponse);
  });
  return list;
}

async function openShipDialog(page: Page) {
  await page.getByRole('button', { name: '発送済みにする' }).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
  await expect(dialog).toBeVisible();
  return dialog;
}

function historyEntries(cancelled: boolean): OrderHistoryResponse['entries'] {
  const completion = {
    type: 'completion',
    at: '2026-10-10T04:00:00.000Z',
    completionId: COMPLETION_ID,
    items: [{ name: 'ウールコート', quantity: 2 }],
    actorEmail: 'admin@example.com',
    cancelled,
    cancellable: !cancelled,
    legacy: false,
  } satisfies OrderHistoryCompletionEntry;
  const cancel = {
    type: 'completion_cancel',
    at: '2026-10-10T05:00:00.000Z',
    completionId: COMPLETION_ID,
    actorEmail: 'admin@example.com',
  } satisfies OrderHistoryCompletionCancelEntry;
  return [
    ...(cancelled ? [cancel] : []),
    completion,
    { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
    { type: 'created', at: '2026-10-09T00:59:00.000Z' },
  ];
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-069 made-to-order completion (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('受注生産の品を含む入金済みの注文は「受注生産中」と出て、発送の画面の最初の数に受注生産中の品は入らない', async ({ page }) => {
      // FREQ-440-AC-01
      await mockMadeApis(page, newState());
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });

      await expect(row.getByText('受注生産中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
      await expect(row).toContainText('受注生産中 2');
      await expect(row.getByRole('button', { name: '仕上がりを記録する' })).toBeVisible();
      await expect(row.getByRole('button', { name: '発送済みにする' })).toBeVisible();

      const dialog = await openShipDialog(page);
      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await expect(inputs.nth(0)).toHaveValue('1');
      await expect(inputs.nth(1)).toHaveValue('0');
      await expect(dialog.getByText('今回送る数の合計: 1点')).toBeVisible();
      await expect(dialog.getByText('在庫', { exact: true })).toHaveCount(1);
      await expect(dialog.getByText('受注生産', { exact: true })).toHaveCount(1);
      await expect(dialog.getByText('受注生産中 2')).toBeVisible();
      await expect(dialog.getByLabel('仕上がった数')).toHaveCount(1);
      await expect(dialog.getByRole('button', { name: '仕上がりを記録', exact: true })).toBeVisible();
    });

    test('仕上がりの画面で仕上がった数を記録すると、その品は「発送準備中」になる（一部発送済みの印は残る）', async ({ page }) => {
      // FREQ-440-AC-02
      const state = newState({ [BLOUSE]: 1 });
      await mockMadeApis(page, state);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      await expect(row.getByText('受注生産中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();

      await row.getByRole('button', { name: '仕上がりを記録する' }).click();
      const dialog = page.getByRole('dialog', { name: '仕上がりを記録する' });
      await expect(dialog).toBeVisible();
      // 受注生産中の品だけが並ぶ
      await expect(dialog.getByText('ウールコート')).toBeVisible();
      await expect(dialog.getByText('シルクブラウス')).toHaveCount(0);
      const input = dialog.getByLabel('仕上がった数');
      await expect(input).toHaveCount(1);
      await expect(input).toHaveValue('0');
      await input.fill('2');
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-completion-dialog-${viewport.width}.png`, animations: 'disabled' });
      await dialog.getByRole('button', { name: '記録する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('仕上がりを記録しました。')).toBeVisible();
      expect(state.completionPosts).toHaveLength(1);
      expect(state.completionPosts[0]).toMatchObject({ lines: [{ orderItemId: COAT, quantity: 2 }] });
      expect(state.completionPosts[0].requestKey).toMatch(UUID_PATTERN);
      // 一覧を読み直して、発送準備中になる。受注生産中の数が無いので「仕上がりを記録する」は消える
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: '仕上がりを記録する' })).toHaveCount(0);
    });

    test('発送の画面の中でも仕上がりを記録でき、その数が発送準備中に移って送る数を入れられる', async ({ page }) => {
      // FREQ-440-AC-03
      const state = newState();
      await mockMadeApis(page, state);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      const dialog = await openShipDialog(page);

      await dialog.getByLabel('仕上がった数').fill('2');
      await dialog.getByRole('button', { name: '仕上がりを記録', exact: true }).click();
      await expect.poll(() => state.completionPosts.length).toBe(1);
      expect(state.completionPosts[0].lines).toEqual([{ orderItemId: COAT, quantity: 2 }]);
      // 画面の中で材料を読み直し、受注生産中の表示は消える
      await expect(dialog.getByText('受注生産中 2')).toHaveCount(0);

      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await inputs.nth(0).fill('1');
      await inputs.nth(1).fill('2');
      await expect(dialog.getByText('今回送る数の合計: 3点')).toBeVisible();
      await dialog.getByLabel('追跡番号').fill('E2E-MTO');
      await dialog.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.shipPosts).toHaveLength(1);
      expect(state.shipPosts[0].lines).toEqual([
        { orderItemId: BLOUSE, quantity: 1 },
        { orderItemId: COAT, quantity: 2 },
      ]);
      await expect(row.getByText('配送中', { exact: true })).toBeVisible();
    });

    test('履歴から仕上がりを取り消すと受注生産中に戻る。送った数を下回る取消は断られる', async ({ page }) => {
      // FREQ-440-AC-04
      const state = newState({}, 2);
      let cancelled = false;
      let refuse = false;
      const cancelPosts: string[] = [];
      const list = await mockMadeApis(page, state);
      await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) =>
        fulfillJson(route, historyOf(ORDER_ID, historyEntries(cancelled))));
      await page.route(`**/api/admin/orders/${ORDER_ID}/completions/${COMPLETION_ID}/cancel`, async (route) => {
        cancelPosts.push(route.request().url());
        if (refuse) {
          await fulfillJson(route, { error: 'もう発送した数があるため、取り消せません。', code: 'completion_already_shipped' } satisfies FulfillmentErrorResponse, 409);
          return;
        }
        cancelled = true;
        state.completed = 0;
        await fulfillJson(route, { outcome: 'cancelled' } satisfies CancelCompletionResponse);
      });
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: `${orderNumberOf(ORDER_ID)} の履歴` }).click();
      const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
      const entry = dialog.getByRole('listitem').filter({ hasText: '受注生産の品が仕上がりました' });
      await expect(entry).toContainText('ウールコート');
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-history-completion-${viewport.width}.png`, animations: 'disabled' });

      // 送った数を下回る取消（窓口が 409 で断る）は、理由が確かめの画面に出て、記録は変わらない
      refuse = true;
      await entry.getByRole('button', { name: 'この仕上がりを取り消す' }).click();
      await expect(page.getByText('この仕上がりを取り消し、その商品を受注生産中に戻します。')).toBeVisible();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();
      await expect(page.getByText('もう発送した数があるため、取り消せません。')).toBeVisible();
      expect(cancelPosts).toHaveLength(1);
      await page.getByRole('button', { name: 'やめる', exact: true }).click();
      // 断られた後も、履歴の仕上がりは取り消せる状態のまま（取消の行は増えず、取り消すボタンも残る）
      await expect(entry.getByRole('button', { name: 'この仕上がりを取り消す' })).toBeVisible();
      await expect(dialog.getByRole('listitem').filter({ hasText: '仕上がりを取り消しました' })).toHaveCount(0);

      // 取り消せる時は、取り消すと履歴に残り、一覧が読み直されて受注生産中に戻る
      refuse = false;
      const before = list.urls.length;
      await entry.getByRole('button', { name: 'この仕上がりを取り消す' }).click();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();
      await expect(dialog.getByRole('listitem').filter({ hasText: '仕上がりを取り消しました' })).toHaveCount(1);
      await expect(entry.getByRole('button', { name: 'この仕上がりを取り消す' })).toHaveCount(0);
      expect(cancelPosts).toHaveLength(2);
      await expect.poll(() => list.urls.length).toBeGreaterThan(before);
      await page.keyboard.press('Escape');
      await expect(row.getByText('受注生産中', { exact: true })).toBeVisible();
    });

    test('受注生産中の品は仕上がりを記録するまで送れず、記録は決済完了の注文の受注生産の品だけで、送った数を下回る取消は断られる（手元の DB）', async () => {
      // FREQ-440-AC-05
      await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const order = await createOrderWithLines(db, uniqueEmail(`mto-${viewport.name}`), [
          { name: 'E2Eブラウス', quantity: 1, fulfillmentType: 'stock' },
          { name: 'E2Eコート', quantity: 2, fulfillmentType: 'backorder' },
        ]);
        const [blouse, coat] = order.orderItemIds;

        // 仕上がりの前は、受注生産の品を送れない。在庫の品は先に送れる（一部の発送）
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ inProduction: 2, readyUnshipped: 0, shipped: 0 });
        await expectDbError(
          createFulfillment(db, order.orderId, actor, { trackingNumber: 'E2E-MTO-0', lines: [{ orderItemId: coat, quantity: 1 }] }),
          'QUANTITY_EXCEEDS_READY',
        );
        // この試験はメールを確かめないので、知らせない発送にする（知らせる発送は、ほかの spec の worker が送るメールの行を残す）
        const stockShipment = await createFulfillment(db, order.orderId, actor, {
          trackingNumber: 'E2E-MTO-1',
          notify: false,
          lines: [{ orderItemId: blouse, quantity: 1 }],
        });
        expect(stockShipment).toMatchObject({ completesOrder: false, orderStatus: 'paid' });

        // 記録できるのは受注生産の品の、受注生産中の数まで
        await expectDbError(recordCompletion(db, order.orderId, actor, [{ orderItemId: blouse, quantity: 1 }]), 'LINE_NOT_IN_PRODUCTION');
        await expectDbError(recordCompletion(db, order.orderId, actor, [{ orderItemId: coat, quantity: 3 }]), 'QUANTITY_EXCEEDS_IN_PRODUCTION');
        const recorded = await recordCompletion(db, order.orderId, actor, [{ orderItemId: coat, quantity: 2 }]);
        expect(recorded).toHaveLength(1);
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ completed: 2, inProduction: 0, readyUnshipped: 2 });

        // 記録の後は送れる。送った数を下回る取消は断られ、数は変わらない
        const coatShipment = await createFulfillment(db, order.orderId, actor, {
          trackingNumber: 'E2E-MTO-2',
          notify: false,
          lines: [{ orderItemId: coat, quantity: 1 }],
        });
        expect(coatShipment).toMatchObject({ number: 2, completesOrder: false });
        await expectDbError(cancelCompletion(db, order.orderId, recorded[0].completionId, actor), 'COMPLETION_ALREADY_SHIPPED');
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ completed: 2, shipped: 1 });

        // まだ送っていない仕上がりは取り消せ、2回目は変わらず already_cancelled
        const waiting = await createOrderWithLines(db, uniqueEmail(`mto-cancel-${viewport.name}`), [
          { name: 'E2Eコート', quantity: 1, fulfillmentType: 'backorder' },
        ]);
        const [waitingCoat] = waiting.orderItemIds;
        const [done] = await recordCompletion(db, waiting.orderId, actor, [{ orderItemId: waitingCoat, quantity: 1 }]);
        expect(await cancelCompletion(db, waiting.orderId, done.completionId, actor)).toBe('cancelled');
        expect((await lineCounts(db, waiting.orderId))[waitingCoat]).toMatchObject({ inProduction: 1, readyUnshipped: 0 });
        expect(await cancelCompletion(db, waiting.orderId, done.completionId, actor)).toBe('already_cancelled');

        // 入金の前（未決済）は仕上がりを記録できない
        const unpaid = await createOrderWithLines(
          db,
          uniqueEmail(`mto-unpaid-${viewport.name}`),
          [{ name: 'E2Eコート', quantity: 1, fulfillmentType: 'backorder' }],
          { status: 'pending' },
        );
        await expectDbError(
          recordCompletion(db, unpaid.orderId, actor, [{ orderItemId: unpaid.orderItemIds[0], quantity: 1 }]),
          'ORDER_NOT_IN_PRODUCTION',
        );
      });
    });

    test('仕上がりの画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      await mockMadeApis(page, newState());
      await openOrderTab(page);
      await page.getByRole('button', { name: '仕上がりを記録する' }).click();
      const dialog = page.getByRole('dialog', { name: '仕上がりを記録する' });
      await expect(dialog.getByLabel('仕上がった数')).toHaveCount(1);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
