/**
 * FR-ADMIN-068 発送準備中の品を先に送れる部分発送
 * 対応 FREQ: FREQ-439（AC-01〜AC-06）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P11）。窓口の答えは共通の約束（C-2）の形。
 * 発送の関数が数を守ること（AC-06）は、手元の DB の関数を直に呼んで確かめる。
 * 発送の画面は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  CreateFulfillmentRequest,
  CreateFulfillmentResponse,
  FulfillmentErrorResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
  expectDbError,
  lineCounts,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  UUID_PATTERN,
  adminOrder,
  fulfillJson,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b1b2c3d4-0000-4000-8000-000000000001';
const SKIRT = 'b1b2c3d4-0000-4000-8000-000000000002';
const LINES = [
  { id: BLOUSE, name: 'シルクブラウス', quantity: 3 },
  { id: SKIRT, name: 'プリーツスカート', quantity: 2 },
];
const EXCEEDS_READY = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
const UNKNOWN_OUTCOME = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

/** 窓口の向こうの記録の代わり。商品ごとに送った数を持ち、一覧と発送の材料の答えをそこから作る */
type ShipState = {
  shipped: Record<string, number>;
  posts: CreateFulfillmentRequest[];
  /** 発送の窓口の答え。既定は「記録した」で、テストが差し替えて、断りや通信の切れを起こす */
  answer: (route: Route, body: CreateFulfillmentRequest) => Promise<void>;
};

function recordShipment(state: ShipState, body: CreateFulfillmentRequest): void {
  for (const line of body.lines) {
    state.shipped[line.orderItemId] = (state.shipped[line.orderItemId] ?? 0) + line.quantity;
  }
}

function allShipped(state: ShipState): boolean {
  return LINES.every((line) => (state.shipped[line.id] ?? 0) >= line.quantity);
}

function rowOf(state: ShipState) {
  const items = LINES.map((line) => {
    const shipped = state.shipped[line.id] ?? 0;
    return orderLine({ id: line.id, name: line.name, quantity: line.quantity, shipped, readyUnshipped: line.quantity - shipped });
  });
  if (allShipped(state)) {
    return adminOrder({ id: ORDER_ID, items, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false });
  }
  return adminOrder({ id: ORDER_ID, items, partiallyShipped: items.some((item) => item.shipped > 0) });
}

function materialsOf(state: ShipState) {
  return shipMaterials({
    orderId: ORDER_ID,
    lines: LINES.map((line) => {
      const shipped = state.shipped[line.id] ?? 0;
      return materialLine({ orderItemId: line.id, name: line.name, quantity: line.quantity, shipped, readyUnshipped: line.quantity - shipped });
    }),
  });
}

async function mockShipApis(page: Page) {
  const state: ShipState = {
    shipped: {},
    posts: [],
    answer: async (route, body) => {
      recordShipment(state, body);
      const completes = allShipped(state);
      await fulfillJson(route, {
        fulfillmentId: randomUUID(),
        number: state.posts.length,
        completesOrder: completes,
        orderStatus: completes ? 'shipped' : 'paid',
        replayed: false,
      } satisfies CreateFulfillmentResponse);
    },
  };
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => [rowOf(state)]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments`, async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, materialsOf(state));
      return;
    }
    const body = route.request().postDataJSON() as CreateFulfillmentRequest;
    state.posts.push(body);
    await state.answer(route, body);
  });
  return { state, listUrls: list.urls };
}

async function openShipDialog(page: Page) {
  await page.getByRole('button', { name: '発送済みにする' }).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const failures = [
  {
    name: '通信が切れた',
    fail: async (route: Route) => {
      await route.abort('failed');
    },
  },
  {
    name: 'サーバーが500を返した',
    fail: async (route: Route) => {
      await fulfillJson(route, { error: '発送の記録に失敗しました。', code: 'failed' } satisfies FulfillmentErrorResponse, 500);
    },
  },
];

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-068 partial fulfillment (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送の画面に商品ごとの印と数が並び、今回送る数は発送準備中の全部が最初から入る', async ({ page }) => {
      // FREQ-439-AC-01
      await mockShipApis(page);
      await openOrderTab(page);
      const dialog = await openShipDialog(page);

      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await expect(inputs.nth(0)).toHaveValue('3');
      await expect(inputs.nth(1)).toHaveValue('2');
      await expect(dialog.getByText('シルクブラウス')).toBeVisible();
      await expect(dialog.getByText('プリーツスカート')).toBeVisible();
      await expect(dialog.getByText('在庫', { exact: true })).toHaveCount(2);
      await expect(dialog.getByText('受注生産', { exact: true })).toHaveCount(0);
      await expect(dialog.getByText('発送準備中').first()).toBeVisible();
      await expect(dialog.getByText('今回送る数', { exact: true }).first()).toBeVisible();
      await expect(dialog.getByText('今回送る数の合計: 5点')).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-ship-dialog-${viewport.width}.png`, animations: 'disabled' });
    });

    test('数を減らして一部だけ発送すると「一部発送済み」と残りを送るボタンが出て、残りを全部発送すると「配送中」になる', async ({ page }) => {
      // FREQ-439-AC-02, FREQ-439-AC-03
      const { state, listUrls } = await mockShipApis(page);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });

      // 1回目: ブラウスを3つのうち2つ、スカートは2つとも
      const first = await openShipDialog(page);
      const firstInputs = first.getByLabel('今回送る数');
      await expect(firstInputs).toHaveCount(2);
      await firstInputs.nth(0).fill('2');
      await expect(first.getByText('今回送る数の合計: 4点')).toBeVisible();
      await first.getByLabel('追跡番号').fill('E2E-PARTIAL');
      await first.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.posts).toHaveLength(1);
      expect(state.posts[0]).toMatchObject({
        carrier: 'yamato',
        trackingNumber: 'E2E-PARTIAL',
        notifyCustomer: true,
        lines: [
          { orderItemId: BLOUSE, quantity: 2 },
          { orderItemId: SKIRT, quantity: 2 },
        ],
      });
      expect(state.posts[0].requestKey).toMatch(UUID_PATTERN);
      // 一覧を読み直して、「一部発送済み」と残りを送るボタンが出る
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(1);
      expect(listUrls.length).toBeGreaterThanOrEqual(2);

      // 2回目: 送り終えたスカートは並ばず、ブラウスの残り1つが最初から入る
      const second = await openShipDialog(page);
      const secondInputs = second.getByLabel('今回送る数');
      await expect(secondInputs).toHaveCount(1);
      await expect(secondInputs.nth(0)).toHaveValue('1');
      await expect(second.getByText('プリーツスカート')).toHaveCount(0);
      await second.getByLabel('追跡番号').fill('E2E-REST');
      await second.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.posts).toHaveLength(2);
      expect(state.posts[1].lines).toEqual([{ orderItemId: BLOUSE, quantity: 1 }]);
      expect(state.posts[1].requestKey).not.toBe(state.posts[0].requestKey);
      await expect(row.getByText('配送中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
    });

    test('送る数の合計が0なら送らずに理由を出し、他の人が先に発送した時の断りの言葉を画面の中に出す', async ({ page }) => {
      // FREQ-439-AC-04
      const { state } = await mockShipApis(page);
      await openOrderTab(page);
      const dialog = await openShipDialog(page);
      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await dialog.getByLabel('追跡番号').fill('E2E-ZERO');

      await inputs.nth(0).fill('0');
      await inputs.nth(1).fill('0');
      await expect(dialog.getByText('今回送る数の合計: 0点')).toBeVisible();
      await dialog.getByRole('button', { name: '発送する' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: '送る数を入れてください。' })).toBeVisible();
      expect(state.posts).toHaveLength(0);

      // 画面を開いた後に、別の人が同じ品を発送した（窓口は 409 で断る）
      state.answer = async (route) => {
        await fulfillJson(route, { error: EXCEEDS_READY, code: 'quantity_exceeds_ready' } satisfies FulfillmentErrorResponse, 409);
      };
      await inputs.nth(0).fill('3');
      await inputs.nth(1).fill('2');
      await dialog.getByRole('button', { name: '発送する' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: EXCEEDS_READY })).toBeVisible();
      expect(state.posts).toHaveLength(1);
      // 画面は閉じず、入力を直して送り直せる
      await expect(dialog).toBeVisible();
      await expect(inputs.nth(0)).toBeEnabled();
    });

    for (const failure of failures) {
      test(`${failure.name}時は、入力を止めて「もう一度確かめる」だけを出し、同じ重複防止キーで確かめ直す`, async ({ page }) => {
        // FREQ-439-AC-05
        const { state } = await mockShipApis(page);
        // サーバーは1回目を記録していたのに、答えが届かなかった
        state.answer = async (route, body) => {
          recordShipment(state, body);
          await failure.fail(route);
        };
        await openOrderTab(page);
        const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
        const dialog = await openShipDialog(page);
        await expect(dialog.getByLabel('今回送る数')).toHaveCount(2);
        await dialog.getByLabel('追跡番号').fill('E2E-UNKNOWN');
        await dialog.getByRole('button', { name: '発送する' }).click();

        await expect(dialog.getByText(UNKNOWN_OUTCOME)).toBeVisible();
        await expect(dialog.getByRole('button')).toHaveCount(2);
        await expect(dialog.getByRole('button', { name: 'もう一度確かめる' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '閉じる' })).toBeVisible();
        await expect(dialog.locator('input:not([disabled]), select:not([disabled])')).toHaveCount(0);

        // 同じ重複防止キーの送り直しには、前の結果（replayed）が返る
        state.answer = async (route) => {
          await fulfillJson(route, {
            fulfillmentId: randomUUID(),
            number: 1,
            completesOrder: true,
            orderStatus: 'shipped',
            replayed: true,
          } satisfies CreateFulfillmentResponse);
        };
        await dialog.getByRole('button', { name: 'もう一度確かめる' }).click();

        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(state.posts).toHaveLength(2);
        expect(state.posts[1]).toEqual(state.posts[0]);
        await expect(row.getByText('配送中', { exact: true })).toBeVisible();
      });
    }

    test('発送の関数は、発送準備中の数を超える数・注文に無い商品・中身の違う同じ重複防止キーを断り、同じ中身の送り直しは二重にならず、同時の2つの発送は片方だけが通る（手元の DB）', async () => {
      // FREQ-439-AC-06
      const { orderId, actorId, skirt } = await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const order = await createOrderWithLines(db, uniqueEmail(`ship-guard-${viewport.name}`), [
          { name: 'E2Eブラウス', quantity: 3, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const other = await createOrderWithLines(db, uniqueEmail(`ship-guard-other-${viewport.name}`), [
          { name: 'E2Eほかの注文', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const [blouseId, skirtId] = order.orderItemIds;

        // 発送準備中の数（3）を超える数と、ほかの注文の商品は断られる
        await expectDbError(
          createFulfillment(db, order.orderId, actor, { trackingNumber: 'E2E-GUARD-0', lines: [{ orderItemId: blouseId, quantity: 4 }] }),
          'QUANTITY_EXCEEDS_READY',
        );
        await expectDbError(
          createFulfillment(db, order.orderId, actor, { trackingNumber: 'E2E-GUARD-0', lines: [{ orderItemId: other.orderItemIds[0], quantity: 1 }] }),
          'LINE_NOT_IN_ORDER',
        );

        // 一部の発送。同じ重複防止キーの送り直しは前の結果（replayed）で、二重に記録しない。中身が違えば断る
        const key = randomUUID();
        const first = await createFulfillment(db, order.orderId, actor, {
          requestKey: key,
          trackingNumber: 'E2E-GUARD-1',
          lines: [{ orderItemId: blouseId, quantity: 2 }],
        });
        expect(first).toMatchObject({ number: 1, completesOrder: false, orderStatus: 'paid', replayed: false });
        const replay = await createFulfillment(db, order.orderId, actor, {
          requestKey: key,
          trackingNumber: 'E2E-GUARD-1',
          lines: [{ orderItemId: blouseId, quantity: 2 }],
        });
        expect(replay).toMatchObject({ fulfillmentId: first.fulfillmentId, number: 1, replayed: true });
        await expectDbError(
          createFulfillment(db, order.orderId, actor, {
            requestKey: key,
            trackingNumber: 'E2E-GUARD-1',
            lines: [{ orderItemId: blouseId, quantity: 1 }],
          }),
          'FULFILLMENT_REQUEST_MISMATCH',
        );
        expect((await lineCounts(db, order.orderId))[blouseId]).toMatchObject({ shipped: 2, readyUnshipped: 1 });
        return { orderId: order.orderId, actorId: actor, skirt: skirtId };
      });

      // 同時の2つの発送（別の接続）。注文の行の鍵で1つずつ進み、後の方は発送準備中の数を超えるので断られる。
      // ブラウスが残っているので、1つ目の後も注文は決済完了のままで、断りの言葉は数の超過になる
      const race = await Promise.allSettled([
        withLocalDb((db) =>
          createFulfillment(db, orderId, actorId, { trackingNumber: 'E2E-RACE-A', lines: [{ orderItemId: skirt, quantity: 1 }] })),
        withLocalDb((db) =>
          createFulfillment(db, orderId, actorId, { trackingNumber: 'E2E-RACE-B', lines: [{ orderItemId: skirt, quantity: 1 }] })),
      ]);
      const rejected = race.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason)).toContain('QUANTITY_EXCEEDS_READY');

      await withLocalDb(async (db) => {
        expect((await lineCounts(db, orderId))[skirt]).toMatchObject({ shipped: 1, readyUnshipped: 0 });
        const alive = await db.query(
          'select count(*)::int as count from public.order_fulfillments where order_id = $1 and cancelled_at is null',
          [orderId],
        );
        expect(alive.rows[0].count).toBe(2);
      });
    });

    test('発送の画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      await mockShipApis(page);
      await openOrderTab(page);
      const dialog = await openShipDialog(page);
      await expect(dialog.getByLabel('今回送る数')).toHaveCount(2);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
