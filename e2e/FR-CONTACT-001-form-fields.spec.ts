import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-001 フォームフィールド表示', () => {
  test('名前・メール・件名・メッセージ入力を表示する', async ({ page }) => {
    await page.goto('/contact');

    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="subject"]')).toBeVisible();
    await expect(page.locator('textarea[name="message"]')).toBeVisible();
  });
});
