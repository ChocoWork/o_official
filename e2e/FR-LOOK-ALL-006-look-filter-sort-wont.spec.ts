import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-006 シーズンフィルタ', () => {
  test('desktop では左サイドバーから season を切り替えられる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await page.waitForLoadState('networkidle');

    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole('button', { name: /Open filter drawer/i })).toHaveCount(0);

    await expect(sidebar.getByRole('checkbox', { name: 'ALL' })).toBeVisible();
    await expect(sidebar.getByRole('checkbox', { name: 'SS' })).toBeVisible();
    await expect(sidebar.getByRole('checkbox', { name: 'AW' })).toBeVisible();

    await sidebar.getByRole('checkbox', { name: 'AW' }).click();
    await expect(page).toHaveURL(/\/look\?season=AW$/);

    const awHeadings = page.locator('main h5');
    const awHeadingTexts = await awHeadings.allTextContents();
    expect(awHeadingTexts.length).toBeGreaterThan(0);
    expect(awHeadingTexts.every((text) => text.includes('AW'))).toBeTruthy();

    await sidebar.getByRole('checkbox', { name: 'ALL' }).click();
    await expect(page).toHaveURL(/\/look$/);
  });

  test('tablet/mobile では FILTER ボタンから drawer を開ける', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/look');
    await page.waitForLoadState('networkidle');

    const filterButton = page.getByRole('button', { name: /Open filter drawer/i });
    await expect(filterButton).toBeVisible();

    await filterButton.click();

    const drawer = page.getByRole('complementary');
    await expect(drawer).toBeVisible();

    await drawer.getByRole('checkbox', { name: 'SS' }).click();
    await expect(page).toHaveURL(/\/look\?season=SS$/);

    const ssHeadings = page.locator('main h5');
    const ssHeadingTexts = await ssHeadings.allTextContents();
    expect(ssHeadingTexts.length).toBeGreaterThan(0);
    expect(ssHeadingTexts.every((text) => text.includes('SS'))).toBeTruthy();
  });
});
