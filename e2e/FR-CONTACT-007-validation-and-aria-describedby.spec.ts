import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-007 バリデーションとaria-describedby', () => {
  test('入力エラーを表示しaria-describedbyを関連付ける', async ({ page }) => {
    await page.goto('/contact');

    await page.locator('input[name="email"]').fill('invalid-email');
    await page.locator('input[name="email"]').blur();

    const errorMessage = page.getByText(/必須|入力してください|正しいメール/).first();
    await expect(errorMessage).toBeVisible();

    const emailInput = page.locator('input[name="email"]');
    const describedBy = await emailInput.getAttribute('aria-describedby');
    expect(describedBy && describedBy.length > 0).toBeTruthy();
  });
});
