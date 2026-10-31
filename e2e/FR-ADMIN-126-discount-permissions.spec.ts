import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountPermissionScenario, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-126 (${viewport.width}px)`, () => {
    test('FREQ-543-AC-03: 未付与supporterは役割の権限で拒否され付与後だけ操作できる', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountPermissionScenario(async (s) => {
        const supporter = await s.actor('supporter', 'aal2');
        const input = discountInput();
        const id = await s.createDiscount(input);
        const path = `/api/admin/discounts/${id}`;
        await s.supporterPermissions([]);
        expect((await s.api(supporter, path)).status).toBe(403);
        expect(await s.permissionProbe(supporter.userId, id)).toBe('42501');
        await s.supporterPermissions(['admin.discounts.read']);
        expect((await s.api(supporter, path)).status).toBe(200);
        expect((await s.update(id, { name: 'read only' }, supporter)).status).toBe(403);
        expect((await s.detail(id)).discount.name).toBe(input.name); // the refused PATCH changed nothing
        await s.supporterPermissions(['admin.discounts.read', 'admin.discounts.manage']);
        expect(await s.permissionProbe(supporter.userId, id)).toBeNull();
        expect((await s.update(id, { name: 'granted' }, supporter)).status).toBe(200);
        expect((await s.detail(id)).discount.name).toBe('granted');
        // read and manage are independent: manage alone cannot read the detail.
        await s.supporterPermissions(['admin.discounts.manage']);
        expect((await s.api(supporter, path)).status).toBe(403);
        await s.supporterPermissions(['admin.discounts.read', 'admin.discounts.manage']);
        await installDiscountDbBridge(page, s, supporter);
        await page.goto(`/admin/discounts/${id}`);
        await expect(page.getByRole('button', { name: '止める', exact: true })).toBeVisible();
        await s.supporterPermissions([]);
        expect((await s.api(supporter, path)).status).toBe(403);
        expect((await s.update(id, { name: 'revoked' }, supporter)).status).toBe(403);
        await page.reload();
        await expect(page.getByRole('alert').filter({ hasText: '割引を見る権限がありません。' })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-543-AC-01: 管理routeは結付いたaal1を403、失効app sessionを401で拒む', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('auth-boundary', async (s) => {
        const aal1 = await s.actor('admin', 'aal1');
        const expired = await s.actor('admin', 'aal2');
        const id = await s.createDiscount(discountInput());
        await s.db.query('update public.sessions set revoked_at=now() where auth_session_id=$1', [expired.sessionId]);
        for (const [actor, status] of [[aal1, 403], [expired, 401]] as const) {
          expect((await s.api(actor, `/api/admin/discounts/${id}`)).status).toBe(status);
          expect((await s.update(id, { name: 'denied' }, actor)).status).toBe(status);
        }
        expect((await s.api('admin', `/api/admin/discounts/${id}`)).status).toBe(200);
        await installDiscountDbBridge(page, s);
        await page.goto(`/admin/discounts/${id}`);
        await expect(page.getByRole('button', { name: '止める', exact: true })).toBeEnabled();
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
