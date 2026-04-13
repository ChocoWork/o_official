import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-003 クライアントインタラクティブフォーム', () => {
  test('送信ボタンを含むインタラクティブフォームを表示する', async ({ page }) => {
    await page.goto('/contact');

    await expect(page.getByRole('heading', { level: 1, name: /Contact/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'SEND MESSAGE' })).toBeVisible();
  });
});
