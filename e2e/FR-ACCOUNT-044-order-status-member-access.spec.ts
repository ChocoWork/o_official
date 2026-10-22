import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginCustomer } from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, expectOrderStatusPrivateVisible, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, prepareOrderStatusTestLink, readOrderStatusPrivate,
  reloadOrderStatusPage, setOrderStatusSessionForTest, setOrderStatusTestState, withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-501-AC-01
  // FREQ-501-AC-02
  // FREQ-501-AC-03
  // FREQ-502-AC-04
  // FREQ-505-AC-04
  test(`${viewport.width}px 持ち主と別の会員と期限切れのログインを同じリンクで区別する`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    const owner = await loginCustomer(page, `e5-owner-${viewport.width}`);
    await withOrderStatusDb(async (db) => {
      const order = await createOrderStatusScenario(db, { kind: 'public', customerId: owner.userId });
      const token = await prepareOrderStatusTestLink(db, order.orderId);
      await openOrderStatusPage(page, token);
      const member = await readOrderStatusPrivate(page, token);
      expect(member.status).toBe(200);
      expect(member.body.access).toBe('member');
      await expectOrderStatusPrivateVisible(page);
      const ownerLink = page.getByRole('link', { name: '会員の注文のページへ', exact: true });
      expect(await ownerLink.evaluate((link, id) => link.getAttribute('href') === `/account/orders/${id}`, order.orderId)).toBe(true);
      await expectNoHorizontalOverflow(page);
      let refreshes = 0;
      const privateStatuses: number[] = [];
      const onRequest = (request: import('@playwright/test').Request) => {
        if (new URL(request.url()).pathname === '/api/auth/refresh') refreshes += 1;
      };
      const onResponse = (response: import('@playwright/test').Response) => {
        if (new URL(response.url()).pathname.endsWith('/private')) privateStatuses.push(response.status());
      };
      page.on('request', onRequest);
      page.on('response', onResponse);
      const access = (await page.context().cookies()).find((cookie) => cookie.name === 'sb-access-token');
      if (!access) throw new Error('会員のアクセス印が無い');
      try { await page.context().addCookies([{ ...access, value: 'e2e-expired-access' }]); }
      catch { throw new Error('アクセス印だけを失効させられない'); }
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect.poll(() => privateStatuses.includes(401) && privateStatuses.at(-1) === 200,
        { message: 'private の401が更新後に200で再送される' }).toBe(true);
      expect(refreshes).toBe(1);
      page.off('request', onRequest);
      page.off('response', onResponse);
      expect((await readOrderStatusPrivate(page, token)).body.access).toBe('member');
      await setOrderStatusTestState(db, { orderId: order.orderId, verifyUntil: new Date(Date.now() - 1_000).toISOString() });
      await reloadOrderStatusPage(page);
      expect((await readOrderStatusPrivate(page, token)).body.access).toBe('member');
      await expectOrderStatusPrivateVisible(page);
      await expectNoHorizontalOverflow(page);
      await page.context().clearCookies();
      await loginCustomer(page, `e5-other-${viewport.width}`);
      await openOrderStatusPage(page, token);
      const other = await readOrderStatusPrivate(page, token);
      expect(other.status).toBe(200);
      expect(other.body.access).toBe('none');
      await expect(page.getByRole('heading', { name: 'お届け先', exact: true })).toHaveCount(0);
      await expect(ownerLink).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      const verifyUntil = new Date(Date.now() + 21 * 86_400_000);
      await setOrderStatusTestState(db, { orderId: order.orderId, verifyUntil: verifyUntil.toISOString() });
      await setOrderStatusSessionForTest(page, { orderId: order.orderId, token, issuedAt: new Date(), verifyUntil });
      await reloadOrderStatusPage(page);
      expect((await readOrderStatusPrivate(page, token)).body.access).toBe('verified');
      await expectOrderStatusPrivateVisible(page);
      await expect(ownerLink).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });
  });
}
