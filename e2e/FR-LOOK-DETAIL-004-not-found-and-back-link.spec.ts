import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-DETAIL-004 存在しないルックID', () => {
  test('エラーメッセージとLook一覧への戻りリンクを表示する', async ({ page }) => {
    await page.goto('/look/999999999');

    await expect(page.getByRole('heading', { name: /Look not found/i })).toBeVisible();
    const backLink = page.getByRole('link', { name: /Back to Lookbook/i });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/look');
  });
});
