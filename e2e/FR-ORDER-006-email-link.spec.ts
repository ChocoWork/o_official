import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import { mailBodies, mailsTo, runWorkerOnce } from './order-email-test-utils';
import {
  createOrderStatusScenario, expectOrderStatusPrivateVisible, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, queueOrderStatusPaidMail, readOrderStatusPrivate,
  readOrderStatusUrlFromMail, STATUS_PRIVATE, verifyOrderStatusInPage, withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-500-AC-01
  // FREQ-503-AC-01
  // FREQ-503-AC-02
  // FREQ-505-AC-04
  test(`${viewport.width}px 本物のメールのリンクから確認まで通りお客様の電話が無い`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const order = await createOrderStatusScenario(db, { kind: 'public' });
      expect(Number((await db.query('select count(*) as n from private.order_status_links where order_id=$1', [order.orderId])).rows[0].n)).toBe(0);
      // prepareOrderStatusTestLink は呼ばず、worker が新本文を作る本物の道だけでリンクを得る。
      const email = await queueOrderStatusPaidMail(db, order.orderId);
      await expect.poll(async () => {
        await runWorkerOnce(request);
        return (await mailsTo(request, email)).filter((mail) => mail.Subject.includes('ご注文ありがとうございます')).length;
      }, { timeout: 90_000, message: '注文確認のメールが1通届く' }).toBe(1);
      await expect.poll(async () => Boolean((await db.query(`select exists (
        select 1 from private.order_email_outbox e join private.order_status_links l on l.order_id=e.order_id
        where e.order_id=$1 and e.kind='paid' and e.status='sent'
          and l.verify_until=e.sent_at+interval '21 days') as completed`, [order.orderId])).rows[0].completed),
      { message: '送信完了と21日の期限が同じ取引で保存される' }).toBe(true);
      const url = await readOrderStatusUrlFromMail(request, email);
      const statusUrlHasExpectedLocalShape = url.origin === 'http://localhost:3000'
        && /^\/order-status\/[A-Za-z0-9_-]{43}$/.test(url.pathname) && !url.search && !url.hash;
      expect(statusUrlHasExpectedLocalShape).toBe(true);
      const mail = (await mailBodies(request, email))[0];
      expect(Boolean(mail)).toBe(true);
      const mailHasCustomerPhone = mail.Text.includes(STATUS_PRIVATE.phone);
      expect(mailHasCustomerPhone).toBe(false);
      expect(mail.Text.includes(STATUS_PRIVATE.name) && mail.Text.includes(STATUS_PRIVATE.address)).toBe(true);
      expect(mail.Text.split('\n').filter((line) => line.startsWith('ご注文の状況はこちら: ')).length).toBe(1);
      const state = (await db.query(
        `select count(*)=1 as unique_link,
           bool_and(l.verify_until=e.sent_at+interval '21 days') as deadline,
           bool_and(l.token=$2) as matches
         from private.order_status_links l join private.order_email_outbox e on e.order_id=l.order_id
         where l.order_id=$1 and e.kind='paid' and e.status='sent'`,
        [order.orderId, url.pathname.split('/').at(-1)],
      )).rows[0];
      expect({ uniqueLink: state.unique_link, deadline: state.deadline, matches: state.matches })
        .toEqual({ uniqueLink: true, deadline: true, matches: true });
      const token = url.pathname.split('/').at(-1)!;
      expect(await openOrderStatusPage(page, token)).toBe(200);
      await verifyOrderStatusInPage(page, order.lastFour!);
      const afterVerifyAccess = (await readOrderStatusPrivate(page, token)).body.access;
      expect(afterVerifyAccess).toBe('verified');
      await expectOrderStatusPrivateVisible(page);
      await expectNoHorizontalOverflow(page);
    });
  });
}
