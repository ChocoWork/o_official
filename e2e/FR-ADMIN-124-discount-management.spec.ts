import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-124 (${viewport.width}px)`, () => {
    test('FREQ-547-AC-01: 割引を作って一覧から詳細へ進み止めて再開し複製できる', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('management', async (s) => {
        const input = discountInput();
        await installDiscountDbBridge(page, s);
        await page.goto('/admin?tab=DISCOUNT');
        const menu = page.getByRole('navigation', { name: '管理メニュー', exact: true });
        await expect(menu.getByRole('button', { name: 'DISCOUNT', exact: true })).toBeVisible();
        const names = (await menu.getByRole('button').allTextContents()).map(name => name.trim());
        const contactIndex = names.findIndex(name => name.startsWith('CONTACT'));
        const discountIndex = names.findIndex(name => name.startsWith('DISCOUNT'));
        expect(contactIndex).toBeGreaterThanOrEqual(0);
        expect(discountIndex).toBe(contactIndex + 1);
        await page.getByRole('button', { name: '割引を作る', exact: true }).click();
        await page.getByRole('textbox', { name: '割引の名前', exact: true }).fill(input.name);
        await page.getByRole('textbox', { name: 'コード', exact: true }).fill(input.code!);
        await page.getByRole('textbox', { name: '割引率（％）', exact: true }).fill('10');
        await page.locator('input[type="datetime-local"]').first().fill('2026-01-01T00:30'); // 00:30 JST is 15:30 UTC on 2025-12-31: a UTC display would show another date and time
        await expect(page.getByRole('checkbox', { name: 'ログインしていない人も使える', exact: true })).not.toBeChecked();
        const createdPromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/discounts' && r.request().method() === 'POST');
        await page.getByRole('button', { name: '作成する', exact: true }).click();
        const created = await createdPromise;
        const body = await created.json() as { data: { discountId: string } };
        expect(created.status()).toBe(201);
        const id = body.data.discountId; s.trackDiscount(id);
        expect(Date.parse((await s.detail(id)).discount.startsAt)).toBe(Date.parse('2025-12-31T15:30:00Z'));
        await page.goto('/admin?tab=DISCOUNT');
        await page.getByRole('textbox', { name: '名前・コードで探す', exact: true }).fill(input.name);
        await page.getByRole('button', { name: '探す', exact: true }).click();
        await expect(page.getByRole('columnheader')).toHaveText(['割引名', '種類', '効き方', '状態', '期間', '使った回数', '上限']);
        await page.getByRole('button', { name: input.name, exact: true }).click();
        await expect(page).toHaveURL(`/admin/discounts/${id}`);
        await expect(page.getByRole('heading', { name: input.name, exact: true })).toBeVisible();
        await expect(page.locator('dl')).toContainText('2026-01-01 00:30');
        for (const [label, stopped] of [['止める', true], ['再開する', false]] as const) {
          await page.getByRole('button', { name: label, exact: true }).click();
          await expect.poll(async () => (await s.detail(id)).discount.stopped).toBe(stopped);
        }
        await page.getByRole('button', { name: '複製', exact: true }).click();
        await expect(page).not.toHaveURL(`/admin/discounts/${id}`);
        const copyId = new URL(page.url()).pathname.split('/').at(-1)!;
        s.trackDiscount(copyId);
        const copy = await s.detail(copyId);
        expect(copy.discount.id).not.toBe(id);
        expect(copy.discount.stopped).toBe(true);
        expect(copy.used).toBe(false);
        expect(copy.assignments).toEqual([]);
        const item = await s.item(20_000);
        await s.cart('member', [{ ...item, quantity: 2 }]);
        const draft = await s.createDraft([input.code!], 'member');
        const orderId = await s.accept(draft, 'member');
        await s.recordPaid(orderId);
        await page.goto(`/admin/discounts/${id}/edit`);
        await expect(page.getByRole('combobox', { name: '割引の種類', exact: true })).toBeDisabled();
        await expect(page.getByRole('textbox', { name: '割引の名前', exact: true })).toBeEnabled();
        const refused = await s.api('admin', `/api/admin/discounts/${id}`, 'PATCH', {
          patch: { value: { type: 'percent', value: 20 } }, expectedVersion: (await s.detail(id)).discount.version, requestKey: randomUUID(),
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'GROUP_H_USED_FIELDS_LOCKED' });
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
