import { expect, test, type Page } from '@playwright/test';

// FREQ-52: LOOK 一覧フィルターの選択肢同士の間隔（option-list の gap）を
// NEWS 一覧フィルターと一致させる。PC はサイドバー、モバイル・タブレットは
// FILTER ボタンから開く drawer で同一の gap になることを検証する。

async function readSidebarOptionListGap(page: Page, path: string): Promise<number> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');

  const optionList = page
    .getByRole('complementary')
    .locator('.multiselect__option-list')
    .first();
  await expect(optionList).toBeVisible();

  return optionList.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).rowGap.replace('px', '')),
  );
}

async function readDrawerOptionListGap(page: Page, path: string): Promise<number> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');

  await page.locator('[data-filter-button="floating"]').click();
  const optionList = page
    .getByRole('dialog')
    .locator('.multiselect__option-list')
    .first();
  await expect(optionList).toBeVisible();

  return optionList.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).rowGap.replace('px', '')),
  );
}

test.describe('FR-LOOK-ALL-009 フィルター選択肢の間隔を NEWS と揃える', () => {
  test('desktop でサイドバーの option-list gap が LOOK と NEWS で一致する', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const lookGap = await readSidebarOptionListGap(page, '/look');
    const newsGap = await readSidebarOptionListGap(page, '/news');

    expect(lookGap).toBeGreaterThan(0);
    expect(Math.abs(lookGap - newsGap)).toBeLessThanOrEqual(0.5);
  });

  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name} で drawer の option-list gap が LOOK と NEWS で一致する`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const lookGap = await readDrawerOptionListGap(page, '/look');
      const newsGap = await readDrawerOptionListGap(page, '/news');

      expect(lookGap).toBeGreaterThan(0);
      expect(Math.abs(lookGap - newsGap)).toBeLessThanOrEqual(0.5);
    });
  }
});
