/**
 * FR-ADMIN-104 ショップの設定の「配送の追跡」（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-495（AC-01〜AC-04）
 *
 * 1本目は、設定の窓口だけを差し替え（管理者のログイン・CSRF・店長の権限は Task 11 の単体の試験。P22）、読み出しと切り替えは
 * 手元の DB の本物の結果・関数（admin_set_delivery_tracking・get_delivery_tracking_settings）を使う。
 * 2本目の「鍵：未設定」は窓口の答えの見本（keyConfigured=false）で、本物の環境変更の証拠ではない
 * （鍵の有無はアプリの環境で決まり、E2E のアプリは作り物の鍵で起動している）。
 */
import { expect, test, type Page } from '@playwright/test';
import {
  createAdminActor,
  createShippedFixture,
  deferOtherRegistrations,
  deliveryViewports,
  expectDialogFits,
  expectNoHorizontalOverflow,
  mockAdminDeliveryBridge,
  newDeliveryBridgeLog,
  openOrderHistory,
  pairFor,
  pollWithMinuteJob,
  readAttention,
  readEvents,
  readFulfillment,
  readRegistration,
  setFakeTracking,
  setTrackingFlagDirect,
  setTrackingViaFunction,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';
import { fulfillJson, mockOrderList, openOrderTab } from './order-fulfillment-test-utils';
import { formatJst, mockAdminSessionAs } from './refund-test-utils';

const TOGGLE_NAME = '配送の追跡（17TRACK）を使う';
const EXPLANATIONS = [
  'オンにすると、発送した荷物の配送状況（配達中・配達済みなど）を 17TRACK から受け取り、お客様の注文の画面に出し、配達中・配達済みのメールを送ります。17TRACK には配送業者と伝票番号だけを渡します',
  '17TRACK の利用料がかかります（最初の200件は無料。その後は年払い）。佐川急便の荷物は、佐川急便の追跡が止まっている間は追えません',
  'オフの間も、伝票番号の直しと、手で配達済みにすることはできます',
];
const SAVED = '設定を保存しました。';

async function openSettings(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: 'SETTINGS', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ショップの設定', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '配送の追跡', level: 3 })).toBeVisible();
}

for (const viewport of deliveryViewports) {
  test.describe(`FR-ADMIN-104 delivery tracking settings (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-495-AC-02, FREQ-495-AC-03, FREQ-495-AC-04
    test('オンの取り込みの件数とオフの確認を表示する', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingFlagDirect(client, false);
        // 17TRACK（作り物）は1件目を「問題あり」と返す。オンにした後の読み直しが誰の呼び出しで起きても同じ答えになるよう、先に決める
        await setFakeTracking({ ...pairFor(numberPrefix, 'E104A'), responseKey: 'failure' });
        // オフの間に発送した物が2件（取り込みの対象）。オフの間は17TRACKに登録しない
        const a = await createShippedFixture(client, { numberPrefix, tag: 'E104A', notify: false, actor });
        const b = await createShippedFixture(client, { numberPrefix, tag: 'E104B', notify: false, actor });
        expect(await readRegistration(client, a.shipment.fulfillmentId)).toBeUndefined();
        expect(await readRegistration(client, b.shipment.fulfillmentId)).toBeUndefined();

        const log = newDeliveryBridgeLog();
        await mockAdminDeliveryBridge(page, { client, orderIds: [a.orderId, b.orderId], actor, log });
        await openSettings(page);
        const toggle = page.getByRole('switch', { name: TOGGLE_NAME, exact: true });
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await expect(page.getByText('鍵：設定済み', { exact: true })).toBeVisible();
        await expect(page.getByText('17TRACK の鍵を設定してください', { exact: true })).toHaveCount(0);
        for (const sentence of EXPLANATIONS) await expect(page.getByText(sentence, { exact: true })).toBeVisible();
        // 初期は誰も変えていないので、最後の変更の行は出ない
        await expect(page.getByTestId('shop-setting-delivery-tracking-updated')).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // オンにする前の確かめ: 取り込む件数は、確かめを開く直前に読み直した正確な件数（自分の2件以上）
        await toggle.click();
        const onDialog = page.getByRole('dialog', { name: '配送の追跡を使う', exact: true });
        await expect(onDialog).toBeVisible();
        const counted = log.backfillCounts[log.backfillCounts.length - 1];
        expect(counted).toBeGreaterThanOrEqual(2);
        await expect(
          onDialog.getByText(`30日以内に発送した配達済みでない発送（${counted}件）も 17TRACK に登録します。1件ごとに 17TRACK の件数を使います`, { exact: true }),
        ).toBeVisible();
        await expect(onDialog.getByRole('button', { name: '戻る', exact: true })).toBeVisible();
        await expectDialogFits(page, onDialog);
        await onDialog.getByRole('button', { name: 'オンにする', exact: true }).click();

        // 保存: 配送の欄だけを送る（自動の返金の2つは読み直した値のまま）。取り込んだ実数が返り、自分の2件が登録待ちになる
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
        const put = log.settingsPuts[log.settingsPuts.length - 1];
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: false, deliveryTracking: { enabled: true } });
        expect(put.backfilledCount).toBeGreaterThanOrEqual(2);
        for (const fx of [a, b]) {
          const registration = await readRegistration(client, fx.shipment.fulfillmentId);
          expect(['pending', 'registered']).toContain(registration?.state);
          expect(registration?.tracking_number).toBe(fx.shipment.trackingNumber.toUpperCase());
        }
        // 最後の変更: 人と日時（日本時間）
        const saved = (await client.query('select * from public.get_delivery_tracking_settings()')).rows[0];
        expect(saved).toMatchObject({ enabled: true, updated_by_email: actor.email });
        await expect(page.getByTestId('shop-setting-delivery-tracking-updated')).toHaveText(
          `最後の変更：${formatJst((saved.updated_at as Date).toISOString())}・${actor.email}`,
        );

        // 1件目は「問題あり」と読まれ、状況と要対応ができる（オフにした時の確かめのため）。
        // オンにした取り込みでほかの登録も一斉に動き出すので、自分の2件の番が回るよう、ほかを後回しにしてから読ませる
        await deferOtherRegistrations(client, numberPrefix);
        await pollWithMinuteJob(
          () => readAttention(client, a.shipment.fulfillmentId),
          (rows) => rows.some((row) => row.kind === 'delivery_failure' && row.resolved_at === null),
          '問題ありの要対応が開くこと',
        );
        expect((await readFulfillment(client, a.shipment.fulfillmentId)).delivery_status).toBe('failure');

        // オフにする: 確かめの画面の言葉。止める
        await toggle.click();
        const offDialog = page.getByRole('dialog', { name: '配送の追跡を止める', exact: true });
        await expect(offDialog).toBeVisible();
        await expect(offDialog.getByText('追跡を止め、配送の要対応を閉じます。記録した配送状況は残ります', { exact: true })).toBeVisible();
        await expectDialogFits(page, offDialog);
        await offDialog.getByRole('button', { name: 'オフにする', exact: true }).click();
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
        const offPut = log.settingsPuts[log.settingsPuts.length - 1];
        expect(offPut.body).toEqual({ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: false, deliveryTracking: { enabled: false } });
        expect(offPut.backfilledCount).toBe(0);

        // オフ: 登録は止め（外へ停止は送らない）、開いた要対応は自動で閉じ、記録した状況と出来事は残る
        for (const fx of [a, b]) {
          expect(await readRegistration(client, fx.shipment.fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'disabled' });
        }
        const attention = await readAttention(client, a.shipment.fulfillmentId);
        expect(attention).toHaveLength(1);
        expect(attention[0]).toMatchObject({ kind: 'delivery_failure', resolution: 'auto' });
        expect(attention[0].resolved_at).not.toBeNull();
        expect((await readFulfillment(client, a.shipment.fulfillmentId)).delivery_status).toBe('failure');
        expect((await readEvents(client, a.shipment.fulfillmentId)).map((event) => event.status)).toEqual(['confirmed', 'failure']);

        // 履歴は残る（追跡オフなので現在の状況の行は出さず、出来事の行だけが残る）
        await openOrderTab(page);
        const dialog = await openOrderHistory(page, a.orderId);
        await expect(dialog.getByRole('listitem').filter({ hasText: '配送の状況（1回目）' })).toHaveCount(2);
        await expect(dialog.getByText('問題あり', { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, dialog);
      });
    });

    // FREQ-495-AC-01, FREQ-495-AC-04
    test('鍵未設定ではオンにできず最後の変更を表示する', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        // 保存済みの「最後の変更」を、本物の関数でオン → オフにして作る（人と日時は DB が書く）
        const actor = await createAdminActor(client);
        await setTrackingFlagDirect(client, false);
        await setTrackingViaFunction(client, true, actor.id);
        await setTrackingViaFunction(client, false, actor.id);
        const saved = (await client.query('select * from public.get_delivery_tracking_settings()')).rows[0] as {
          enabled: boolean;
          updated_at: Date;
          updated_by_email: string;
          backfill_count: number;
        };
        expect(saved).toMatchObject({ enabled: false, updated_by_email: actor.email });

        // 窓口の答えの見本: 保存済みの値のまま、鍵だけが未設定（keyConfigured=false）
        const puts: unknown[] = [];
        await mockAdminSessionAs(page, 'admin');
        await mockOrderList(page, () => []);
        await page.route('**/api/admin/settings/shop', async (route) => {
          if (route.request().method() === 'PUT') puts.push(route.request().postDataJSON());
          await fulfillJson(route, {
            data: {
              autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
              autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null },
              deliveryTracking: {
                enabled: false,
                updatedAt: saved.updated_at.toISOString(),
                updatedByEmail: saved.updated_by_email,
                keyConfigured: false,
                backfillCount: Number(saved.backfill_count),
              },
            },
          });
        });
        await openSettings(page);

        // 鍵：未設定 と、鍵を設定する案内。トグルは押せない。最後の変更は保存済みの人と日時
        const toggle = page.getByRole('switch', { name: TOGGLE_NAME, exact: true });
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await expect(toggle).toBeDisabled();
        await expect(page.getByText('鍵：未設定', { exact: true })).toBeVisible();
        await expect(page.getByText('鍵：設定済み', { exact: true })).toHaveCount(0);
        await expect(page.getByText('17TRACK の鍵を設定してください', { exact: true })).toBeVisible();
        await expect(page.getByTestId('shop-setting-delivery-tracking-updated')).toHaveText(
          `最後の変更：${formatJst(saved.updated_at.toISOString())}・${actor.email}`,
        );
        for (const sentence of EXPLANATIONS) await expect(page.getByText(sentence, { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // 押しても確かめの画面は出ず、窓口へ保存も送らない
        await toggle.click({ force: true });
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(puts).toHaveLength(0);
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
      });
    });
  });
}
