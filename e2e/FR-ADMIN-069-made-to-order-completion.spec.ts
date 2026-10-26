/**
 * FR-ADMIN-069 受注生産中と仕上がりの記録
 * 対応 FREQ: FREQ-524（AC-03・AC-04。G-1 の旧入口の停止）。FREQ-440-AC-01 の画面の確かめは G-4 で FR-ADMIN-110 ② へ移した
 *
 * G-1 で、仕上がりの手動の記録・取消は終了した（MANUAL_COMPLETION_DISABLED）。受注生産の品は、入荷の自動の割当
 * （古い入金済みの注文から順）で発送準備中になる。手動の仕上がりは再開しない（G-3 の新しい発送票も、仕上がりの手動の記録は持たない）。
 * 成功の経路（記録して発送準備中になる・発送の画面の中の記録・履歴からの取消・DB の記録と取消）の試験は G-1 で削除した。
 * G-4 で旧い注文の一覧・発送の画面・仕上がりの画面が無くなったので、画面の確かめ2つ（「受注生産中」の言葉と数／画面の横はみ出し）は
 * 新しい試験へ移し、ここには停止の拒否そのもの（手元の DB の関数を直に呼ぶ）だけを残す。
 * - 受注生産の品が「受注生産中」と出て、割り当てられた分が発送準備中・発送済みと分かれる → FR-ADMIN-110 ②（品物のステータスの数量）、詳細の品物の欄 → FR-ADMIN-122
 * - 発送の画面・仕上がりの画面は無い、頁全体が横にはみ出さない → FR-ADMIN-122 ⑩⑪（旧い入口が出ない）
 * 旧い窓口が呼べないこと（HTTP の 404）は FR-ADMIN-123 の G-4 ⑤、旧い DB の関数の拒否は DB 結合の group_g1_legacy_disabled が持つ。
 */
import { expect, test } from '@playwright/test';
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
import { viewports } from './order-fulfillment-test-utils';

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-069 made-to-order completion (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
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
  });
}
