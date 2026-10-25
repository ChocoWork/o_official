import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-005 LOOK一覧SEOメタ情報', () => {
  test('FR-LOOK-ALL-005-AC-01 LOOK一覧ページにタイトルとdescriptionメタを設定する', async ({ page }) => {
    await page.goto('/look');

    await expect(page).toHaveTitle(/LOOK/i);

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute('content', /.+/);
  });
});
