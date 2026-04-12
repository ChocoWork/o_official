import { test, expect } from '@playwright/test';

test.describe('FR-HOME-009 heading structure', () => {
  test('home page uses a single h1 and section headings as h2', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1:has-text("Le Fil des Heures")')).toBeVisible();

    const sectionHeadings = page.locator('h2');
    const texts = await sectionHeadings.allTextContents();
    expect(texts).toEqual(expect.arrayContaining(['ITEMS', 'LOOK', 'NEWS', 'ABOUT', 'STOCKIST']));
  });
});
