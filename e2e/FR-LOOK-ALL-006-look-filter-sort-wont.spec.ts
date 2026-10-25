import { expect, test, type Locator } from '@playwright/test';

/** React が要素を引き継いだ（イベントの処理が付いた）ことを待つ。付く前の操作は落ちる */
async function waitUntilHydrated(target: Locator) {
  await expect
    .poll(() => target.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps'))), { timeout: 15_000 })
    .toBe(true);
}

// FREQ-51: LOOK 一覧のフィルターを NEWS 同様に、PC では左サイドバー、
// モバイル・タブレットでは FILTER ボタンから開く drawer に配置する。
test.describe('FR-LOOK-ALL-006 シーズンフィルタ', () => {
  test('FREQ-51-AC-01 desktop では左サイドバーから season を切り替えられる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');

    // PC ではサイドバー（complementary）が表示され、FILTER ボタンは出ない。
    const sidebar = page.getByRole('complementary');
    await expect(sidebar).toBeVisible();
    await expect(page.locator('[data-filter-button="floating"]')).toBeHidden();

    await expect(sidebar.getByRole('checkbox', { name: 'ALL' })).toBeVisible();
    await expect(sidebar.getByRole('checkbox', { name: 'SS' })).toBeVisible();
    await expect(sidebar.getByRole('checkbox', { name: 'AW' })).toBeVisible();

    await waitUntilHydrated(sidebar.getByRole('checkbox', { name: 'AW' }));
    await sidebar.getByRole('checkbox', { name: 'AW' }).click();
    await expect(page).toHaveURL(/\/look\?season=AW$/);

    await sidebar.getByRole('checkbox', { name: 'ALL' }).click();
    await expect(page).toHaveURL(/\/look$/);
  });

  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`FREQ-51-AC-02 ${vp.name} では FILTER ボタンから drawer を開ける`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');

      // PC のサイドバーは出ず、FILTER ボタンが表示される。
      const filterButton = page.locator('[data-filter-button="floating"]');
      await expect(filterButton).toBeVisible();

      await waitUntilHydrated(filterButton);
      await filterButton.click();

      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();

      await drawer.getByRole('checkbox', { name: 'SS' }).click();
      await expect(page).toHaveURL(/\/look\?season=SS$/);
    });
  }
});
