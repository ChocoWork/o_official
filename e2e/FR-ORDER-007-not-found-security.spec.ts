import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginCustomer } from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, createOrderStatusStateCase, isolateOrderStatusApiIp, openOrderStatusPage, orderStatusViewports,
  postOrderStatusVerify, prepareOrderStatusTestLink, readOrderStatusPrivate, setOrderStatusSessionForTest,
  withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-498-AC-04
  // FREQ-505-AC-02
  // FREQ-505-AC-03
  // FREQ-505-AC-04
  test(`${viewport.width}px 同じ404とnoindexとno-storeと送信元の守りを持つ`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const ip = await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const order = await createOrderStatusScenario(db, { kind: 'public' });
      const token = await prepareOrderStatusTestLink(db, order.orderId);
      const missing = randomBytes(32).toString('base64url');
      const hidden = [];
      for (const status of ['payment_in_progress', 'abandoned'] as const) {
        hidden.push(await prepareOrderStatusTestLink(db, (await createOrderStatusStateCase(db, status)).orderId));
      }
      const notFoundBodies = [];
      const notFoundPostBodies = [];
      for (const target of ['invalid-token', missing, ...hidden]) {
        expect(await openOrderStatusPage(page, target)).toBe(404);
        await expect(page.getByRole('heading', { name: 'このページは見つかりません', exact: true })).toBeVisible();
        const response = await readOrderStatusPrivate(page, target);
        expect(response.status).toBe(404);
        expect(response.cacheControl).toBe('no-store');
        expect(response.referrerPolicy).toBe('no-referrer');
        notFoundBodies.push(JSON.stringify(response.body));
        const post = await postOrderStatusVerify(request, target, '0000', { ip });
        expect(post.status).toBe(404);
        expect(post.cacheControl).toBe('no-store');
        expect(post.referrerPolicy).toBe('no-referrer');
        expect(post.body.code).toBe('ORDER_STATUS_NOT_FOUND');
        notFoundPostBodies.push(JSON.stringify(post.body));
        await expectNoHorizontalOverflow(page);
      }
      expect(new Set(notFoundBodies).size).toBe(1);
      expect(new Set(notFoundPostBodies).size).toBe(1);
      const cancelled = await createOrderStatusStateCase(db, 'cancelled');
      expect(await openOrderStatusPage(page, await prepareOrderStatusTestLink(db, cancelled.orderId))).toBe(200);
      await expect(page.getByText('キャンセル', { exact: true })).toBeVisible();
      await openOrderStatusPage(page, token);
      expect(await page.locator('meta[name="robots"]').evaluateAll((nodes) => nodes.some((node) => {
        const content = node.getAttribute('content') ?? '';
        return content.includes('noindex') && content.includes('nofollow');
      }))).toBe(true);
      const initial = await readOrderStatusPrivate(page, token);
      expect(initial.status).toBe(200);
      expect(initial.cacheControl).toBe('no-store');
      expect(initial.referrerPolicy).toBe('no-referrer');
      const now = new Date();
      await setOrderStatusSessionForTest(page, { orderId: order.orderId, token, issuedAt: now, verifyUntil: new Date(now.getTime() + 86_400_000) });
      expect((await readOrderStatusPrivate(page, token)).body.access).toBe('verified');
      for (const origin of ['https://foreign.example.invalid', null]) {
        const rejected = await postOrderStatusVerify(request, token, order.lastFour!, { ip, origin });
        expect(rejected.status).toBe(403);
        expect(rejected.cacheControl).toBe('no-store');
        expect(rejected.referrerPolicy).toBe('no-referrer');
      }
      // refresh Cookie のある本物のログインだけを CSRF 不足として試す。
      await loginCustomer(page, `e5-security-${viewport.width}`);
      expect((await page.context().cookies()).some((cookie) => cookie.name === 'sb-refresh-token')).toBe(true);
      const csrf = await postOrderStatusVerify(page.request, token, order.lastFour!, { ip });
      expect(csrf.status).toBe(403);
      expect(csrf.body.code).toBe('ORDER_STATUS_FORBIDDEN');
      expect(csrf.cacheControl).toBe('no-store');
      expect(csrf.referrerPolicy).toBe('no-referrer');
      await openOrderStatusPage(page, token);
      const tracking = page.getByRole('link', { name: '配送状況を確認する', exact: true });
      // public 場面の発送は無いので、番号のある場面でも実際の rel を確認する。
      expect(await tracking.count()).toBe(0);
      const shipped = await createOrderStatusScenario(db, { kind: 'returns' });
      const shippedToken = await prepareOrderStatusTestLink(db, shipped.orderId);
      await setOrderStatusSessionForTest(page, { orderId: shipped.orderId, token: shippedToken, issuedAt: now, verifyUntil: new Date(now.getTime() + 86_400_000) });
      await openOrderStatusPage(page, shippedToken);
      await expect(page.getByRole('link', { name: '配送状況を確認する', exact: true }).first()).toHaveAttribute('rel', 'noopener noreferrer');
      await expectNoHorizontalOverflow(page);
    });
  });
}
