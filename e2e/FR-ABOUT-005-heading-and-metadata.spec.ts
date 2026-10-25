import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-005 見出し階層とmetadata', () => {
  test('FR-ABOUT-005-AC-01 h1 を持ち title/description メタを設定する', async ({ page }) => {
    await page.goto('/about');

    // title・description は FR-ABOUT-005-AC-02（009）が持つ。
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toBeVisible();
  });
});
