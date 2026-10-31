import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow, fillShippingForm, stubPostalCode } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-CHECKOUT-058 (${viewport.width}px)`, () => {
    test('FREQ-552-AC-01: 入力と最終確認と注文の確認メールは同じ割引名と額になる', async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('breakdown', async (s) => {
        const item = await s.item(20_000);
        await s.cart('guest', [{ ...item, quantity: 2 }]);
        const input = discountInput({ method: 'automatic', code: null }); const id = await s.createDiscount(input);
        await installDiscountDbBridge(page, s, 'guest');
        await stubPostalCode(page);
        await page.goto('/checkout');
        await expect(page.locator('.checkout-summary')).toContainText(`割引（${input.name}）`);
        await expect(page.locator('.checkout-summary')).toContainText('4,000');
        await fillShippingForm(page, s.guestEmail);
        await page.getByRole('button', { name: '確認へ進む', exact: true }).click();
        await expect(page.getByRole('heading', { name: '注文内容の最終確認', exact: true })).toBeVisible();
        await expect(page.locator('.checkout-summary')).toContainText(`割引（${input.name}）`);
        await expect(page.locator('.checkout-summary')).toContainText('4,000');
        await expect(page.locator('.checkout-total')).toContainText('36,000');
        await expect(page.getByRole('textbox', { name: 'プロモーションコード', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /を削除$/ })).toHaveCount(0);
        const draft = await s.latestDraft('guest');
        const frozen = await s.frozen(draft.draftId);
        const orderId = await s.accept(draft, 'guest'); await s.recordPaid(orderId);
        expect((await s.update(id, { name: '改名した現在名' })).status).toBe(200);
        const breakdown = await s.breakdown(orderId);
        expect(breakdown.rows.map(row => ({ name: row.name, amount: row.amount }))).toEqual([{ name: input.name, amount: 4_000 }]);
        expect(breakdown.rows.reduce((sum, row) => sum + row.amount, 0)).toBe(frozen.discount_result.discountAmount);
        const mail = await s.compose(orderId);
        // Compare booleans so a failing assertion cannot print the email body or recipient.
        expect(mail.includes(`割引（${input.name}）: -￥4,000`)).toBe(true);
        expect(mail.includes('合計: ￥36,000')).toBe(true);
        expect(mail.includes('改名した現在名')).toBe(false);
        expect(breakdown.rows.every(row => row.amount > 0)).toBe(true);
        expect(breakdown.rows.every(row => row.lineAllocations.reduce((n, line) => n + line.amount, 0) === row.amount)).toBe(true);
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
