/**
 * FR-ADMIN-066 発送の時に、発送のメールを送るかを選べる（最初は送る）
 * 対応 FREQ: FREQ-438（AC-01・AC-02）、FREQ-442（AC-04 は、この spec の「送らない」の試験と FR-ADMIN-071 の両方が確かめる）
 *
 * 画面は窓口を差し替えて、送る本文に「送るか」が載ることを確かめる。
 * 「外すと届かず、入れると1通届く」は、手元の DB の発送の関数・worker の定期処理の入口・手元のメール受けで確かめる（本計画 P11）。
 * 2026-10-10（グループ E-1）: 発送の画面は商品と数を選ぶ画面になり、窓口は POST /api/admin/orders/[id]/fulfillments に、
 * 発送の関数は admin_create_fulfillment に変わった。発送のメールの行は、その発送の自動の1行になる。
 * 発送の画面（チェックが見える所）は、目で見るために3つの画面幅の写しを test-results/group-d/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import type { CreateFulfillmentRequest, CreateFulfillmentResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  createActor,
  createFulfillment,
  createPaidOrder,
  mailsTo,
  orderItemIdsOf,
  outboxRows,
  runWorkerUntil,
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

const SHIPPED_SUBJECT = '商品を発送いたしました';

const ORDER_A = 'd1b2c3d4-1111-2222-8333-444455556666';
const ORDER_B = 'e1b2c3d4-1111-2222-8333-444455556666';
const LINE_A = 'd1000000-0000-4000-8000-000000000001';
const LINE_B = 'e1000000-0000-4000-8000-000000000001';

const ORDERS = [
  adminOrder({ id: ORDER_A, items: [orderLine({ id: LINE_A })] }),
  adminOrder({ id: ORDER_B, items: [orderLine({ id: LINE_B })] }),
];

async function mockAdminApis(page: Page, bodies: CreateFulfillmentRequest[]): Promise<void> {
  await mockAdminSession(page);
  await mockOrderList(page, () => ORDERS);
  await page.route('**/api/admin/orders/*/fulfillments', async (route) => {
    const orderId = new URL(route.request().url()).pathname.split('/')[4];
    if (route.request().method() === 'GET') {
      await fulfillJson(route, shipMaterials({ orderId, lines: [materialLine({ orderItemId: orderId === ORDER_A ? LINE_A : LINE_B })] }));
      return;
    }
    bodies.push(route.request().postDataJSON() as CreateFulfillmentRequest);
    await fulfillJson(route, {
      fulfillmentId: 'f0000000-0000-4000-8000-000000000001',
      number: 1,
      completesOrder: true,
      orderStatus: 'shipped',
      replayed: false,
    } satisfies CreateFulfillmentResponse);
  });
}

/** screenshotPath を渡すと、チェックが入った最初の発送の画面を写す */
async function ship(page: Page, row: number, notify: boolean, screenshotPath?: string): Promise<void> {
  await page.getByRole('button', { name: '発送済みにする' }).nth(row).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
  // 発送の画面は材料を読み終えてから入力する
  await expect(dialog.getByLabel('今回送る数')).toHaveCount(1);
  const checkbox = dialog.getByRole('checkbox', { name: 'お客様に発送のメールを送る' });
  await expect(checkbox).toBeChecked();
  // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
  if (screenshotPath) await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  if (!notify) await checkbox.uncheck();
  await dialog.getByLabel('追跡番号').fill(`E2E-${row}`);
  await dialog.getByRole('button', { name: '発送する' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-066 ship email opt-out (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送の画面の「お客様に発送のメールを送る」は最初から入っていて、外すと「送らない」を送る', async ({ page }) => {
      // FREQ-438-AC-01
      const bodies: CreateFulfillmentRequest[] = [];
      await mockAdminApis(page, bodies);
      await openOrderTab(page);

      await ship(page, 0, false, `test-results/group-d/order-ship-dialog-${viewport.width}.png`);
      await ship(page, 0, true);

      expect(
        bodies.map((body) => ({
          carrier: body.carrier,
          trackingNumber: body.trackingNumber,
          notifyCustomer: body.notifyCustomer,
          lines: body.lines,
        })),
      ).toEqual([
        { carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: false, lines: [{ orderItemId: LINE_A, quantity: 1 }] },
        { carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: true, lines: [{ orderItemId: LINE_A, quantity: 1 }] },
      ]);
      // 画面を開くたびに、新しい重複防止キーを作る
      expect(bodies[0].requestKey).toMatch(UUID_PATTERN);
      expect(bodies[1].requestKey).toMatch(UUID_PATTERN);
      expect(bodies[1].requestKey).not.toBe(bodies[0].requestKey);
    });

    test('「送らない」で発送した注文には発送のメールが届かず、「送る」なら1通届く（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-438-AC-02, FREQ-442-AC-04
      // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
      test.setTimeout(120_000);
      const silentEmail = uniqueEmail(`ship-silent-${viewport.name}`);
      const notifiedEmail = uniqueEmail(`ship-notified-${viewport.name}`);
      const { silentOrder, notifiedOrder, notifiedFulfillmentId } = await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const silent = await createPaidOrder(db, silentEmail);
        const notified = await createPaidOrder(db, notifiedEmail);
        const [silentLine] = await orderItemIdsOf(db, silent);
        const [notifiedLine] = await orderItemIdsOf(db, notified);
        await createFulfillment(db, silent, actor, {
          trackingNumber: 'E2E-SILENT',
          notify: false,
          lines: [{ orderItemId: silentLine, quantity: 1 }],
        });
        const shipment = await createFulfillment(db, notified, actor, {
          trackingNumber: 'E2E-NOTIFIED',
          notify: true,
          lines: [{ orderItemId: notifiedLine, quantity: 1 }],
        });
        return { silentOrder: silent, notifiedOrder: notified, notifiedFulfillmentId: shipment.fulfillmentId };
      });

      // worker は時間の予算で止まり、別の起動が取った行は飛ばすので、1回叩いただけでは送り切った証拠にならない。
      // 送る注文の発送の行が送信済みになるまで、worker の入口を叩き直す（FR-ADMIN-071・072 と同じ）。
      // 送信済みはメールを送った後に書かれるので、この確かめの後にメール受けを数え直せる。
      await runWorkerUntil(
        request,
        async () => (await withLocalDb((db) => outboxRows(db, notifiedOrder))).some((row) => row.status === 'sent'),
        '送る注文の発送のメールが送信済みになること',
      );
      // 送る注文の発送の行は、その発送の自動の1行だけ
      expect(await withLocalDb((db) => outboxRows(db, notifiedOrder))).toEqual([
        { fulfillment_id: notifiedFulfillmentId, origin: 'auto', status: 'sent', last_error_code: null },
      ]);
      await expect.poll(
        async () => (await mailsTo(request, notifiedEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT)).length,
        { timeout: 30_000 },
      ).toBe(1);
      expect((await mailsTo(request, silentEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT))).toHaveLength(0);
      expect(await withLocalDb((db) => outboxRows(db, silentOrder))).toHaveLength(0);
    });
  });
}
