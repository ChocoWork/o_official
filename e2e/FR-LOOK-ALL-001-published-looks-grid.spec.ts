import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-001 公開済みルック一覧', () => {
  test('公開済みルックをカードグリッドで表示する', async ({ page }) => {
    await page.goto('/look');

    const lookLinks = page.locator('a[href^="/look/"]');
    await expect(lookLinks.first()).toBeVisible();

    const cardCount = await lookLinks.count();
    expect(cardCount).toBeGreaterThan(0);
  });
});
