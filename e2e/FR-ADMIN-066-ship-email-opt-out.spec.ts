/**
 * FR-ADMIN-066 発送の時に、発送のメールを送るかを選べる（最初は送る）
 * 対応 FREQ: FREQ-438（AC-01・AC-02）
 *
 * 画面は窓口を差し替えて、送る本文に「送るか」が載ることを確かめる。
 * 「外すと届かず、入れると1通届く」は、手元の DB の発送の関数・worker の定期処理の入口・手元のメール受けで確かめる（本計画 P11）。
 * 発送の画面（チェックが見える所）は、目で見るために3つの画面幅の写しを test-results/group-d/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { createActor, createPaidOrder, mailsTo, runWorkerOnce, uniqueEmail, withLocalDb } from './order-email-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const SHIPPED_SUBJECT = '商品を発送いたしました';

const BASE = {
  customerName: '山田 花子',
  customerEmail: 'hanako@example.com',
  orderDate: '2026-10-09',
  itemCount: '1点',
  items: [{ name: 'シルクブラウス', quantity: 1 }],
  totalAmount: '¥28,800',
  status: '決済完了',
  canShip: true,
};

const ORDERS = [
  { ...BASE, id: 'd1b2c3d4-1111-2222-8333-444455556666' },
  { ...BASE, id: 'e1b2c3d4-1111-2222-8333-444455556666' },
];

async function mockAdminApis(page: Page, bodies: unknown[]): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true } }),
    }));
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }));
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }),
    }));
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ORDERS, pagination: { page: 1, pageSize: 20, total: ORDERS.length, totalPages: 1 } }),
    }));
  await page.route('**/api/admin/orders/*/status', (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, status: 'shipped' }) });
  });
}

/** screenshotPath を渡すと、チェックが入った最初の発送の画面を写す */
async function ship(page: Page, row: number, notify: boolean, screenshotPath?: string): Promise<void> {
  await page.getByRole('button', { name: '発送済みにする' }).nth(row).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
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
      const bodies: unknown[] = [];
      await mockAdminApis(page, bodies);
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ORDER' }).click();

      await ship(page, 0, false, `test-results/group-d/order-ship-dialog-${viewport.width}.png`);
      await ship(page, 0, true);

      expect(bodies).toEqual([
        { status: 'shipped', carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: false },
        { status: 'shipped', carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: true },
      ]);
    });

    test('「送らない」で発送した注文には発送のメールが届かず、「送る」なら1通届く（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-438-AC-02
      // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
      test.setTimeout(120_000);
      const silentEmail = uniqueEmail(`ship-silent-${viewport.name}`);
      const notifiedEmail = uniqueEmail(`ship-notified-${viewport.name}`);
      const { silentOrder, notifiedOrder } = await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const silent = await createPaidOrder(db, silentEmail);
        const notified = await createPaidOrder(db, notifiedEmail);
        await db.query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', 'E2E-SILENT', false)", [silent, actor]);
        await db.query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', 'E2E-NOTIFIED', true)", [notified, actor]);
        return { silentOrder: silent, notifiedOrder: notified };
      });

      await runWorkerOnce(request);

      // worker は時間の予算で止まるため、送る注文の発送の行が自動の1行だけで送信済みになるのを先に待つ。
      // 送信済みはメールを送った後に書かれるので、この確かめの後にメール受けを数え直せる。
      await expect.poll(
        async () => withLocalDb(async (db) =>
          (await db.query("select origin, status from private.order_email_outbox where order_id = $1 and kind = 'shipped'", [notifiedOrder])).rows),
        { timeout: 30_000, message: '送る注文の発送の行は、自動の1行だけで送信済みであること' },
      ).toEqual([{ origin: 'auto', status: 'sent' }]);
      await expect.poll(
        async () => (await mailsTo(request, notifiedEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT)).length,
        { timeout: 30_000 },
      ).toBe(1);
      expect((await mailsTo(request, silentEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT))).toHaveLength(0);
      const rows = await withLocalDb(async (db) =>
        (await db.query("select count(*)::int as count from private.order_email_outbox where order_id = $1 and kind = 'shipped'", [silentOrder])).rows[0]);
      expect(rows.count).toBe(0);
    });
  });
}
