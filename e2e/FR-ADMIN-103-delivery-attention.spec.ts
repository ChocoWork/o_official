/**
 * FR-ADMIN-103 配送の要対応（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-493（AC-02・AC-03）
 *
 * 要対応は、作り物の 17TRACK（127.0.0.1:4017）の答えを、起動したアプリの毎分の定期処理が読んで DB に開く物を使う。
 * 管理画面の窓口だけを差し替え（管理者のログイン・CSRF・権限は Task 9 の単体の試験。P22）、一覧の印・要対応の組・履歴は
 * DB の本物の読み出しの結果、「対応済みにする」は本物の DB の関数を呼ぶ。
 */
import { expect, test } from '@playwright/test';
import {
  createAdminActor,
  createPaidOrderFixture,
  createShippedFixture,
  deliveryViewports,
  expectDialogFits,
  expectNoHorizontalOverflow,
  makeRegistrationDue,
  mockAdminDeliveryBridge,
  newDeliveryBridgeLog,
  openOrderHistory,
  pairFor,
  pollWithMinuteJob,
  readAttention,
  readFulfillment,
  setFakeTracking,
  setTrackingViaFunction,
  shipFixture,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';
import { openOrderTab } from './order-fulfillment-test-utils';

const openKinds = async (read: () => Promise<Awaited<ReturnType<typeof readAttention>>>) =>
  (await read()).filter((row) => row.resolved_at === null).map((row) => row.kind).sort();

for (const viewport of deliveryViewports) {
  test.describe(`FR-ADMIN-103 delivery attention (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-493-AC-02, FREQ-493-AC-03
    test('問題ありを対応済みにし回復後の再発で開き直す', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        // 作り物が「問題あり」を返す（発送を作る前に決める。別の試験の定期処理が先に読んでも、同じ答えになるように）
        await setFakeTracking({ ...pairFor(numberPrefix, 'E103A'), responseKey: 'failure' });
        const fx = await createShippedFixture(client, { numberPrefix, tag: 'E103A', notify: false, actor });
        const { fulfillmentId, pair } = fx.shipment;
        const attention = () => readAttention(client, fulfillmentId);

        // 読み直しで状況が問題ありになり、要対応が開く
        await pollWithMinuteJob(
          attention,
          (rows) => rows.some((row) => row.kind === 'delivery_failure' && row.resolved_at === null),
          '問題ありの要対応が開くこと',
        );
        expect((await readFulfillment(client, fulfillmentId)).delivery_status).toBe('failure');

        // 一覧の印と、要対応の「配送」の組
        const log = newDeliveryBridgeLog();
        await mockAdminDeliveryBridge(page, { client, orderIds: [fx.orderId], actor, log });
        await openOrderTab(page);
        const orderRow = page.getByRole('row', { name: new RegExp(fx.orderId) });
        await expect(orderRow.getByText('問題あり', { exact: true })).toBeVisible();
        const region = page.getByRole('region', { name: '要対応 0件・要確認 0件・配送 1件', exact: true });
        await expect(region).toBeVisible();
        await expect(region.getByRole('heading', { name: '配送', exact: true })).toBeVisible();
        await expect(region.getByText('問題あり', { exact: true })).toBeVisible();
        await expect(region.getByText(`注文番号 ${fx.orderNumber}・1回目の発送`, { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // 「履歴を開く」でその注文の履歴が開く（配送の状況は問題あり）
        await region.getByRole('button', { name: '履歴を開く', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'この注文の履歴', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('配送の状況（1回目）', { exact: true }).first()).toBeVisible();
        await expect(dialog.getByText('問題あり', { exact: true }).first()).toBeVisible();
        await expectDialogFits(page, dialog);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);

        // 手で対応済みにする → 組と印が消える。DB は手で閉じた記録（した人つき）
        await region.getByRole('button', { name: '対応済みにする', exact: true }).click();
        await expect(page.getByText('対応済みにしました。', { exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: /要対応/ })).toHaveCount(0);
        await expect(orderRow.getByText('問題あり', { exact: true })).toHaveCount(0);
        expect(log.resolvePosts).toEqual([{ attentionId: expect.any(String), status: 200 }]);
        const resolved = await attention();
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({ kind: 'delivery_failure', resolution: 'manual', resolved_by: actor.id });

        // 回復（輸送中に戻る）しても、手で閉じた要対応は開き直さない
        await setFakeTracking({ ...pair, responseKey: 'inTransit' });
        await makeRegistrationDue(client, fulfillmentId);
        await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'in_transit',
          '回復して輸送中に戻ること',
        );
        expect(await openKinds(attention)).toEqual([]);
        expect(await attention()).toHaveLength(1);

        // もう一度問題ありになったら、新しい要対応が開く（前の閉じた行とは別の行）
        await setFakeTracking({ ...pair, responseKey: 'failure' });
        await makeRegistrationDue(client, fulfillmentId);
        await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'failure',
          '再び問題ありになること',
        );
        const reopened = await attention();
        expect(reopened).toHaveLength(2);
        expect(reopened.filter((row) => row.resolved_at === null)).toMatchObject([{ kind: 'delivery_failure', resolution: null }]);
        expect(reopened[0].id).not.toBe(reopened[1].id);

        await openOrderTab(page);
        await expect(page.getByRole('region', { name: '要対応 0件・要確認 0件・配送 1件', exact: true })).toBeVisible();
        await expect(page.getByRole('row', { name: new RegExp(fx.orderId) }).getByText('問題あり', { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    });

    // FREQ-493-AC-02, FREQ-493-AC-03
    test('不在と追跡できない印の優先を出す', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        // 作り物の答えは、発送を作る前に決める（別の試験の定期処理が先に読んでも、同じ答えになるように）
        await setFakeTracking({ ...pairFor(numberPrefix, 'E103X1'), responseKey: 'attemptedDelivery' });
        await setFakeTracking({ ...pairFor(numberPrefix, 'E103X2'), responseKey: 'failure' });
        await setFakeTracking({ ...pairFor(numberPrefix, 'E103Y'), responseKey: 'attemptedDelivery' });
        await setFakeTracking({ ...pairFor(numberPrefix, 'E103Z'), responseKey: 'invalidNumber' });
        // 注文X: 2つの発送（片方は不在で持ち帰り、片方は問題あり）→ 印は優先順位の高い「問題あり」1つ
        const orderX = await createPaidOrderFixture(client, { label: 'e103x', quantity: 2, actor });
        const x1 = await shipFixture(client, orderX, { numberPrefix, tag: 'E103X1', quantity: 1, notify: false });
        const x2 = await shipFixture(client, orderX, { numberPrefix, tag: 'E103X2', quantity: 1, notify: false });
        // 注文Y: 不在で持ち帰りだけ → 印は「不在で持ち帰り」
        const orderY = await createShippedFixture(client, { numberPrefix, tag: 'E103Y', notify: false, actor });
        // 注文Z: 伝票番号が正しくない（登録で断られる）→ 印は「追跡できない」
        const orderZ = await createShippedFixture(client, { numberPrefix, tag: 'E103Z', notify: false, actor });

        const readAll = async () => ({
          x1: await openKinds(() => readAttention(client, x1.fulfillmentId)),
          x2: await openKinds(() => readAttention(client, x2.fulfillmentId)),
          y: await openKinds(() => readAttention(client, orderY.shipment.fulfillmentId)),
          z: await openKinds(() => readAttention(client, orderZ.shipment.fulfillmentId)),
        });
        await pollWithMinuteJob(
          readAll,
          (open) =>
            open.x1.join() === 'attempted_delivery' && open.x2.join() === 'delivery_failure'
            && open.y.join() === 'attempted_delivery' && open.z.join() === 'tracking_not_found',
          '4つの配送の要対応が開くこと',
        );

        const log = newDeliveryBridgeLog();
        await mockAdminDeliveryBridge(page, { client, orderIds: [orderX.orderId, orderY.orderId, orderZ.orderId], actor, log });
        await openOrderTab(page);
        const rowOf = (orderId: string) => page.getByRole('row', { name: new RegExp(orderId) });

        // 一覧の印は1つだけ。優先順位は 問題あり → 不在で持ち帰り → 追跡できない
        await expect(rowOf(orderX.orderId).getByText('問題あり', { exact: true })).toBeVisible();
        await expect(rowOf(orderX.orderId).getByText('不在で持ち帰り', { exact: true })).toHaveCount(0);
        await expect(rowOf(orderY.orderId).getByText('不在で持ち帰り', { exact: true })).toBeVisible();
        await expect(rowOf(orderY.orderId).getByText('問題あり', { exact: true })).toHaveCount(0);
        await expect(rowOf(orderZ.orderId).getByText('追跡できない', { exact: true })).toBeVisible();

        // 要対応の組には、開いている4件が全部出る（種類の言葉は計画 C-5）
        const region = page.getByRole('region', { name: '要対応 0件・要確認 0件・配送 4件', exact: true });
        await expect(region).toBeVisible();
        await expect(region.getByText('問題あり', { exact: true })).toHaveCount(1);
        await expect(region.getByText('不在で持ち帰り', { exact: true })).toHaveCount(2);
        await expect(region.getByText('伝票番号で荷物が見つからない', { exact: true })).toHaveCount(1);
        await expect(region.getByText(`注文番号 ${orderX.orderNumber}・1回目の発送`, { exact: true })).toBeVisible();
        await expect(region.getByText(`注文番号 ${orderX.orderNumber}・2回目の発送`, { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // 1件ずつ対応済みにする。4件目で「配送」の組（欄ごと）が消え、一覧の印も消える
        const resolveButtons = page.getByRole('button', { name: '対応済みにする', exact: true });
        for (let remaining = 3; remaining >= 0; remaining -= 1) {
          await resolveButtons.first().click();
          await expect(resolveButtons).toHaveCount(remaining);
        }
        await expect(page.getByRole('region', { name: /要対応/ })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: '配送', exact: true })).toHaveCount(0);
        await expect(rowOf(orderX.orderId).getByText('問題あり', { exact: true })).toHaveCount(0);
        await expect(rowOf(orderY.orderId).getByText('不在で持ち帰り', { exact: true })).toHaveCount(0);
        await expect(rowOf(orderZ.orderId).getByText('追跡できない', { exact: true })).toHaveCount(0);
        expect(log.resolvePosts).toHaveLength(4);
        expect(log.resolvePosts.every((post) => post.status === 200)).toBe(true);
        const all = await readAll();
        expect(all).toEqual({ x1: [], x2: [], y: [], z: [] });
        for (const id of [x1.fulfillmentId, x2.fulfillmentId, orderY.shipment.fulfillmentId, orderZ.shipment.fulfillmentId]) {
          expect((await readAttention(client, id)).every((row) => row.resolution === 'manual' && row.resolved_by === actor.id)).toBe(true);
        }

        // 履歴は残る（配送の状況の出来事の行は消えない）
        const dialog = await openOrderHistory(page, orderX.orderId);
        await expect(dialog.getByText('配送の状況（2回目）', { exact: true }).first()).toBeVisible();
        await expectDialogFits(page, dialog);
      });
    });
  });
}
