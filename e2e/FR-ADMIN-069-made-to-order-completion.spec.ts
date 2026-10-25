/**
 * FR-ADMIN-069 受注生産中と仕上がりの記録
 * 対応 FREQ: FREQ-440（AC-01）、FREQ-524（AC-03・AC-04。G-1 の旧入口の停止）
 *
 * G-1 で、仕上がりの手動の記録・取消は終了した（MANUAL_COMPLETION_DISABLED）。一覧の「仕上がりを記録する」・発送の画面の中の仕上がりの記録・
 * 履歴の「この仕上がりを取り消す」の入口は撤去し、固定の停止文を出す。受注生産の品は、入荷の自動の割当（古い入金済みの注文から順）で
 * 発送準備中になる。手動の仕上がりは再開しない（G-3 の新しい発送票も、仕上がりの手動の記録は持たない）。
 * 成功の経路（記録して発送準備中になる・発送の画面の中の記録・履歴からの取消・DB の記録と取消）の試験は削除した。
 * 画面は窓口を差し替えて確かめる（実装計画 P11）。窓口が昔の形で canShip・canRecordCompletion を true と答えても、入口は出ない。
 * 停止の拒否そのもの（DB の関数・HTTP 410）は、手元の DB の関数を直に呼んで確かめる。
 */
import { expect, test, type Page } from '@playwright/test';
import { MANUAL_COMPLETION_DISABLED_TEXT } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { seedE2eRestock } from './group-g1-test-utils';
import {
  cancelCompletion,
  createActor,
  createOrderWithLines,
  expectDbError,
  lineCounts,
  recordCompletion,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a2b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b2b2c3d4-0000-4000-8000-000000000001';
const COAT = 'b2b2c3d4-0000-4000-8000-000000000002';

/** 旧の入口の名前（一覧・発送の画面・履歴）。どれも出ない */
const LEGACY_ENTRY_NAMES = ['仕上がりを記録する', '発送済みにする', 'この仕上がりを取り消す', 'この発送を取り消す'];

/**
 * 受注生産の品を含む入金済みの注文の一覧。ブラウス（在庫の品1つ）とコート（受注生産の品2つ、まだ仕上がっていない）。
 * 窓口が昔の形で canShip・canRecordCompletion を true と答える注文（画面はそれを無視して入口を出さない）
 */
async function mockMadeApis(page: Page) {
  await mockAdminSession(page);
  return mockOrderList(page, () => [
    adminOrder({
      id: ORDER_ID,
      items: [
        orderLine({ id: BLOUSE, name: 'シルクブラウス', quantity: 1, shipped: 0, inProduction: 0, readyUnshipped: 1 }),
        orderLine({ id: COAT, name: 'ウールコート', quantity: 2, fulfillmentType: 'backorder', shipped: 0, inProduction: 2, readyUnshipped: 0 }),
      ],
      status: '受注生産中',
      progressKey: 'in_production',
      canShip: true,
      canRecordCompletion: true,
    }),
  ]);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-069 made-to-order completion (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('受注生産の品を含む入金済みの注文は「受注生産中」と出て、発送の画面の最初の数に受注生産中の品は入らない', async ({ page }) => {
      // FREQ-440-AC-01（G-1: 「受注生産中」の言葉と数は残る。発送の画面と仕上がりの記録の入口は撤去し、固定の停止文を出す。
      // 発送の画面の最初の数の確かめは G-3 FR-ADMIN-116 で新しい発送票へ書き換える）
      await mockMadeApis(page);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });

      await expect(row.getByText('受注生産中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
      await expect(row).toContainText('受注生産中 2');
      for (const name of LEGACY_ENTRY_NAMES) {
        await expect(page.getByRole('button', { name }), `${name} の入口`).toHaveCount(0);
      }
      // 案内（発送は荷作り表から）と停止文（仕上がり）は表の外に1回ずつ（注文の行の中には出さない）。
      // G-3: 旧い発送の停止文は、発送票へ誘導する案内に置き換わった
      for (const text of [SHIPMENT_SLIP_TEXT.orderSectionGuide, MANUAL_COMPLETION_DISABLED_TEXT]) {
        await expect(page.getByText(text, { exact: true })).toHaveCount(1);
        await expect(page.getByText(text, { exact: true })).toBeVisible();
        await expect(row.getByText(text, { exact: true })).toHaveCount(0);
      }
    });

    test('FREQ-524-AC-03: 手動の仕上がりの記録・取消は固定の停止で断られ、受注生産の品は入荷の自動の割当で発送準備中になる（手元の DB）', async () => {
      // FREQ-524-AC-03, FREQ-524-AC-04
      await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const order = await createOrderWithLines(db, uniqueEmail(`mto-${viewport.name}`), [
          { name: 'E2Eコート', quantity: 2, fulfillmentType: 'backorder' },
        ]);
        const [coat] = order.orderItemIds;
        const waiting = { completed: 0, inProduction: 2, readyUnshipped: 0, shipped: 0 };

        // 受注生産の品は、割り当てられるまで受注生産中（受注生産中 2）
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject(waiting);

        // 手動の仕上がりの記録・取消は、数を超える入力でも未知の入力でも同じ固定の停止で断る。数は何も変わらない
        await expectDbError(recordCompletion(db, order.orderId, actor, [{ orderItemId: coat, quantity: 1 }]), 'MANUAL_COMPLETION_DISABLED');
        await expectDbError(recordCompletion(db, order.orderId, actor, [{ orderItemId: coat, quantity: 3 }]), 'MANUAL_COMPLETION_DISABLED');
        await expectDbError(cancelCompletion(db, order.orderId, 'c2b2c3d4-0000-4000-8000-000000000001', actor), 'MANUAL_COMPLETION_DISABLED');
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject(waiting);

        // 入荷（本物の入口）の余りが、最も古い入金済みの待ちへ自動で割り当てられる。1点入ると、2点のうち1点が発送準備中になる
        await seedE2eRestock(db, { itemId: order.itemId, variantId: order.variantId, quantity: 1 });
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ completed: 1, inProduction: 1, readyUnshipped: 1, shipped: 0 });
      });
    });

    test('仕上がりの画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      // G-1: 仕上がりの画面は撤去した。同じ3つの画面幅で、2つの停止文を出した一覧の画面が横にはみ出さないことを確かめる
      await mockMadeApis(page);
      await openOrderTab(page);
      await expect(page.getByText(MANUAL_COMPLETION_DISABLED_TEXT, { exact: true })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
