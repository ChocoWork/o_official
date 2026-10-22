import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, inspectOrderStatusPublicTransport, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, prepareOrderStatusTestLink, readOrderStatusPrivate,
  withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-498-AC-01
  // FREQ-501-AC-04
  // FREQ-505-AC-02
  // FREQ-505-AC-04
  test(`${viewport.width}px リンクだけで公開の状況を見られ個人情報を読まない`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    let refreshRequestCount = 0;
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/auth/refresh') refreshRequestCount += 1; });
    await page.addInitScript(() => {
      Object.assign(window, { statusSessionExpiredEvents: 0 });
      window.addEventListener('auth:session-expired', () => {
        const state = window as unknown as { statusSessionExpiredEvents: number };
        state.statusSessionExpiredEvents += 1;
      });
    });
    await withOrderStatusDb(async (db) => {
      const scenario = await createOrderStatusScenario(db, { kind: 'public' });
      const token = await prepareOrderStatusTestLink(db, scenario.orderId);
      const initial = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/private'));
      expect(await openOrderStatusPage(page, token)).toBe(200);
      const privateResponse = await initial;
      expect(privateResponse.status()).toBe(200);
      const privateBody = await privateResponse.json();
      expect(privateBody.access).toBe('none');
      expect(Object.keys(privateBody).sort()).toEqual(['access', 'reason', 'verifiable']);
      await expect(page.getByRole('heading', { name: 'ご注文の状況', exact: true })).toBeVisible();
      await expect(page.getByText(`注文番号 ORD-${scenario.orderId.slice(0, 8).toUpperCase()}`, { exact: true })).toBeVisible();
      await expect(page.getByText(/^ご注文日 /)).toBeVisible();
      await expect(page.getByText('公開用の試験商品', { exact: true })).toBeVisible();
      await expect(page.getByText('数量: 4', { exact: true })).toBeVisible();
      await expect(page.getByText(/20,000/).first()).toBeVisible();
      await expect(page.getByRole('heading', { name: '支払金額', exact: true })).toBeVisible();
      expect(await inspectOrderStatusPublicTransport(page, token)).toEqual({ htmlPrivate: false, rscPrivate: false, rsc: true });
      expect((await readOrderStatusPrivate(page, token)).body.access).toBe('none');
      expect(refreshRequestCount).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { statusSessionExpiredEvents: number }).statusSessionExpiredEvents)).toBe(0);
      await expectNoHorizontalOverflow(page);
    });
  });
}
