import { test, expect } from '@playwright/test';

test.describe('FR-HOME-005 stockist home section', () => {
  test('renders stockist section on home with up to 6 cards', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const stockistSection = page.locator('#stockist');
    await expect(stockistSection).toBeVisible();

    const cards = stockistSection.locator('article');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);
    expect(cardCount).toBeLessThanOrEqual(6);
  });
});
