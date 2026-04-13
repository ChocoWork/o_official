import { expect, test } from '@playwright/test';

test.describe('FR-STOCKIST-004 HOME件数制御', () => {
  test('HOMEでは最大6件、モバイルでは上位3件が表示される', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const section = page.locator('#stockist');
    await expect(section).toBeVisible();
    const mobileCards = section.locator('article:visible');
    const mobileCount = await mobileCards.count();
    expect(mobileCount).toBeLessThanOrEqual(3);

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/');
    const desktopSection = page.locator('#stockist');
    const desktopCards = desktopSection.locator('article:visible');
    const desktopCount = await desktopCards.count();
    expect(desktopCount).toBeGreaterThan(0);
    expect(desktopCount).toBeLessThanOrEqual(6);
  });
});
