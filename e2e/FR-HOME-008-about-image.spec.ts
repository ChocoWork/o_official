import { test, expect } from '@playwright/test';

test.describe('FR-HOME-008 about section image', () => {
  test('uses static local asset for ABOUT section image', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const aboutImage = page.locator('img[alt="About Le Fil des Heures"]');
    await expect(aboutImage).toHaveCount(1);

    const src = await aboutImage.getAttribute('src');
    expect(src).toContain('about.png');
  });
});
