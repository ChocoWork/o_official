/**
 * FR-ADMIN-065 注文の履歴（状態の変化とメール）・送ったメールの中身・お客様への再送
 * 対応 FREQ: FREQ-436（AC-01・AC-02）
 *
 * 画面は、今までの管理画面の E2E と同じく窓口を差し替えて確かめる（本物の管理者のログインには2段階認証が要る）。
 * 再送で2通目が本当に届くことは、手元の DB の関数・worker の定期処理の入口・手元のメール受けで確かめる。
 * 履歴のダイアログと送ったメールの中身は、目で見るために3つの画面幅の写しを test-results/group-d/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { createActor, createPaidOrder, mailsTo, runWorkerOnce, uniqueEmail, withLocalDb } from './order-email-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const SUBJECT = '【Le Fil des Heures】ご注文ありがとうございます（ORD-A1B2C3D4）';

const ORDER_ROW = {
  id: ORDER_ID,
  customerName: '山田 花子',
  customerEmail: 'hanako@example.com',
  orderDate: '2026-10-09',
  itemCount: '1点',
  items: [{ name: 'シルクブラウス', quantity: 1 }],
  totalAmount: '¥28,800',
  status: '決済完了',
  canShip: true,
};

const SENT_EMAIL = {
  type: 'email', at: '2026-10-09T01:00:00.000Z', emailId: 'b1b2c3d4-1111-2222-8333-444455556666', kind: 'paid',
  kindLabel: '注文確認', manual: false, requestedByEmail: null, stateLabel: '配達済み', warning: false, attempts: 1,
  errorLabel: null, sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: '2026-10-09T01:01:00.000Z',
  canViewContent: true, bodyErased: false, resendable: true,
};

function historyBody(resent: boolean) {
  const manual = {
    ...SENT_EMAIL, at: '2026-10-09T02:00:00.000Z', emailId: 'c1b2c3d4-1111-2222-8333-444455556666', manual: true,
    requestedByEmail: 'admin@example.com', stateLabel: '送信待ち', sentAt: null, deliveryEventAt: null, canViewContent: false, resendable: false,
  };
  return {
    order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    entries: [
      ...(resent ? [manual] : []),
      { ...SENT_EMAIL, resendable: !resent },
      { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
      { type: 'created', at: '2026-10-09T00:59:00.000Z' },
    ],
  };
}

async function mockAdminApis(page: Page, state: { resent: boolean; resendBodies: unknown[] }): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'admin@example.com', role: 'admin', mfaVerified: true } }),
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
      body: JSON.stringify({ data: [ORDER_ROW], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }),
    }));
  await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(historyBody(state.resent)) }));
  await page.route(`**/api/admin/orders/${ORDER_ID}/emails/${SENT_EMAIL.emailId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'available', subject: SUBJECT, bodyText: '山田 花子 様\n\nご注文を承りました。', sentAt: SENT_EMAIL.sentAt }),
    }));
  await page.route(`**/api/admin/orders/${ORDER_ID}/emails/resend`, (route) => {
    state.resendBodies.push(route.request().postDataJSON());
    state.resent = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, emailId: 'c1b2c3d4-1111-2222-8333-444455556666' }) });
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-065 order history and email resend (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('履歴に状態の変化とメールが並び、中身を開け、再送すると「手で再送」が出る。Escape で閉じる', async ({ page }) => {
      // FREQ-436-AC-01
      const state = { resent: false, resendBodies: [] as unknown[] };
      await mockAdminApis(page, state);
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ORDER' }).click();

      const historyButton = page.getByRole('button', { name: 'ORD-A1B2C3D4 の履歴' });
      await historyButton.click();
      const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('宛先: hanako@example.com')).toBeVisible();
      await expect(dialog.getByRole('listitem').nth(0)).toContainText('注文確認のメール');
      await expect(dialog.getByRole('listitem').nth(0)).toContainText('配達済み');
      await expect(dialog.getByRole('listitem').nth(1)).toContainText('支払い手続き中 → 決済完了');
      await expect(dialog.getByRole('listitem').nth(2)).toContainText('注文を受け付けました');
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-d/order-history-${viewport.width}.png`, animations: 'disabled' });

      await dialog.getByRole('button', { name: '中身を見る' }).click();
      const content = page.getByRole('dialog', { name: '注文確認のメールの中身' });
      await expect(content.getByText(SUBJECT)).toBeVisible();
      await expect(content.getByText(/ご注文を承りました。/)).toBeVisible();
      await page.screenshot({ path: `test-results/group-d/order-email-content-${viewport.width}.png`, animations: 'disabled' });
      await content.getByRole('button', { name: '戻る' }).click();

      await page.getByRole('dialog', { name: 'この注文の履歴' }).getByRole('button', { name: 'お客様へ再送' }).click();
      const confirm = page.getByRole('dialog', { name: 'お客様へ再送' });
      await expect(confirm.getByText('注文確認のメールを、お客様（注文のメールアドレス）へもう一度送ります')).toBeVisible();
      await confirm.getByRole('button', { name: '再送する' }).click();

      const after = page.getByRole('dialog', { name: 'この注文の履歴' });
      await expect(after.getByText('再送を受け付けました。少し待つと届きます。')).toBeVisible();
      await expect(after.getByText('手で再送（admin@example.com）')).toBeVisible();
      await expect(after.getByRole('button', { name: 'お客様へ再送' })).toHaveCount(0);
      expect(state.resendBodies).toEqual([{ kind: 'paid' }]);

      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(historyButton).toBeFocused();
    });

    test('再送すると、同じ件名のメールが2通目として届き、履歴に手の再送が残る（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-436-AC-02
      // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
      test.setTimeout(120_000);
      const email = uniqueEmail(`resend-${viewport.name}`);
      const { orderId, actorId } = await withLocalDb(async (db) => {
        const created = await createPaidOrder(db, email);
        await db.query("select private.enqueue_order_email($1, 'paid', 'order_confirmed')", [created]);
        return { orderId: created, actorId: await createActor(db) };
      });

      await runWorkerOnce(request);
      await expect.poll(async () => (await mailsTo(request, email)).length, { timeout: 30_000 }).toBe(1);
      // 再送は送信済みの行が要る。メールが着いてから行が送信済みになるまでに、別の worker が送った時のわずかな差がある
      await expect.poll(
        async () => withLocalDb(async (db) =>
          (await db.query("select status from private.order_email_outbox where order_id = $1 and kind = 'paid'", [orderId])).rows),
        { timeout: 15_000, message: '最初のメールの行が送信済みになること' },
      ).toEqual([{ status: 'sent' }]);

      await withLocalDb((db) => db.query("select public.request_order_email_resend($1, 'paid', $2)", [orderId, actorId]));
      await runWorkerOnce(request);
      await expect.poll(async () => (await mailsTo(request, email)).length, { timeout: 30_000 }).toBe(2);

      const subjects = new Set((await mailsTo(request, email)).map((message) => message.Subject));
      expect([...subjects]).toEqual([expect.stringContaining('ご注文ありがとうございます')]);
      // メールが着いても、行が送信済みになるのは送った後。別の worker が送った時のわずかな差を待つ
      await expect.poll(
        async () => withLocalDb(async (db) =>
          (await db.query('select origin, status from public.list_order_email_history($1)', [orderId])).rows),
        { timeout: 15_000, message: '履歴に手の再送と自動の2行が、どちらも送信済みで新しい順に並ぶこと' },
      ).toEqual([{ origin: 'manual', status: 'sent' }, { origin: 'auto', status: 'sent' }]);
    });
  });
}
