import { expect, test } from '@playwright/test';

test.describe('FR-STOCKIST-001 カタログ表示', () => {
  test('公開済みストックリストをレスポンシブグリッドで表示する', async ({ page }) => {
    await page.goto('/stockist');

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(0);
  });
});
