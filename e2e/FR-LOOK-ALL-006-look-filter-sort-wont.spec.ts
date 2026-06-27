import { expect, test } from '@playwright/test';

// FREQ-51: LOOK 一覧のフィルターを NEWS 同様に、PC では左サイドバー、
// モバイル・タブレットでは FILTER ボタンから開く drawer に配置する。
test.describe('FR-LOOK-ALL-006 シーズンフィルタ', () => {
  test('desktop では左サイドバーから season を切り替えられる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await page.waitForLoadState('networkidle');

    // PC ではサイドバー（complementary）が表示され、FILTER ボタンは出ない。
    const sidebar = page.getByRole('complementary');
    await expect(sidebar).toBeVisible();
    await expect(page.locator('[data-filter-button="floating"]')).toBeHidden();

    await expect(sidebar.getByRole('checkbox', { name: 'ALL' })).toBeVisible();
    await expect(sidebar.getByRole('checkbox', { name: 'SS' })).toBeVisible();
    await expect(sidebar.getByRole('checkbox', { name: 'AW' })).toBeVisible();

    await sidebar.getByRole('checkbox', { name: 'AW' }).click();
    await expect(page).toHaveURL(/\/look\?season=AW$/);

    await sidebar.getByRole('checkbox', { name: 'ALL' }).click();
    await expect(page).toHaveURL(/\/look$/);
  });

  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name} では FILTER ボタンから drawer を開ける`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await page.waitForLoadState('networkidle');

      // PC のサイドバーは出ず、FILTER ボタンが表示される。
      const filterButton = page.locator('[data-filter-button="floating"]');
      await expect(filterButton).toBeVisible();

      await filterButton.click();

      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();

      await drawer.getByRole('checkbox', { name: 'SS' }).click();
      await expect(page).toHaveURL(/\/look\?season=SS$/);
    });
  }
});
