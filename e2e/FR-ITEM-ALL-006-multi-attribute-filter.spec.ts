import { expect, test } from '@playwright/test';
import { closeItemFilters, expandItemFilterSection, gotoItemList, openItemFilters } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-006 複数属性フィルタ', () => {
  test('サイズ・カラー・価格で絞り込み可能', async ({ page }) => {
    await gotoItemList(page);

    const drawer = await openItemFilters(page);

    const toggleAndAssertSection = async (label: string) => {
      await expandItemFilterSection(drawer, label);
      const toggleButton = drawer.getByRole('button', { name: label, exact: true });
      await expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
      await toggleButton.click();
      await expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
      await toggleButton.click();
      await expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
      return toggleButton;
    };

    await toggleAndAssertSection('CATEGORY');
    await toggleAndAssertSection('COLOR');
    await toggleAndAssertSection('STOCK');
    await toggleAndAssertSection('SIZE');
    await toggleAndAssertSection('SEASON');
    await toggleAndAssertSection('PRICE');

    // CATEGORY は初期展開。複数選択可能。
    const category = await expandItemFilterSection(drawer, 'CATEGORY');
    await category.getByRole('checkbox', { name: 'TOPS', exact: true }).check();
    await category.getByRole('checkbox', { name: 'BOTTOMS', exact: true }).check();
    await expect(category.getByRole('checkbox', { name: 'TOPS', exact: true })).toBeChecked();
    await expect(category.getByRole('checkbox', { name: 'BOTTOMS', exact: true })).toBeChecked();
    await expect(category.getByRole('checkbox', { name: 'ALL', exact: true })).not.toBeChecked();

    // ALL で他カテゴリ選択をリセット
    await category.getByRole('checkbox', { name: 'ALL', exact: true }).check();
    await expect(category.getByRole('checkbox', { name: 'TOPS', exact: true })).not.toBeChecked();
    await expect(category.getByRole('checkbox', { name: 'BOTTOMS', exact: true })).not.toBeChecked();
    await expect(category.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();

    const color = await expandItemFilterSection(drawer, 'COLOR');
    const colorOptions = color.getByRole('checkbox');
    const colorCount = await colorOptions.count();
    if (colorCount > 1) {
      await colorOptions.nth(1).check();
      await expect(colorOptions.nth(1)).toBeChecked();
      await color.getByRole('checkbox', { name: 'ALL', exact: true }).check();
      await expect(colorOptions.nth(1)).not.toBeChecked();
      await expect(color.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();
    }

    const size = await expandItemFilterSection(drawer, 'SIZE');
    const sizeOptions = size.getByRole('checkbox');
    const sizeCount = await sizeOptions.count();
    if (sizeCount > 1) {
      await sizeOptions.nth(1).check();
      await expect(sizeOptions.nth(1)).toBeChecked();
      await size.getByRole('checkbox', { name: 'ALL', exact: true }).check();
      await expect(sizeOptions.nth(1)).not.toBeChecked();
      await expect(size.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();
    }

    const stock = await expandItemFilterSection(drawer, 'STOCK');
    await stock.getByRole('checkbox', { name: 'IN STOCK', exact: true }).check();
    await expect(stock.getByRole('checkbox', { name: 'IN STOCK', exact: true })).toBeChecked();
    await expect(stock.getByRole('checkbox', { name: 'ALL', exact: true })).not.toBeChecked();
    await stock.getByRole('checkbox', { name: 'ALL', exact: true }).check();
    await expect(stock.getByRole('checkbox', { name: 'IN STOCK', exact: true })).not.toBeChecked();
    await expect(stock.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();

    const season = await expandItemFilterSection(drawer, 'SEASON');
    await season.getByRole('checkbox', { name: 'AW', exact: true }).check();
    await expect(season.getByRole('checkbox', { name: 'AW', exact: true })).toBeChecked();
    await expect(season.getByRole('checkbox', { name: 'SS', exact: true })).not.toBeChecked();
    await expect(season.getByRole('checkbox', { name: 'ALL', exact: true })).not.toBeChecked();
    await season.getByRole('checkbox', { name: 'ALL', exact: true }).check();
    await expect(season.getByRole('checkbox', { name: 'AW', exact: true })).not.toBeChecked();
    await expect(season.getByRole('checkbox', { name: 'SS', exact: true })).not.toBeChecked();
    await expect(season.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();

    const price = await expandItemFilterSection(drawer, 'PRICE');
    await price.getByLabel('Minimum value').press('ArrowRight');
    await price.getByLabel('Maximum value').press('ArrowLeft');
    await closeItemFilters(drawer);

    await expect(page).not.toHaveURL(/(?:\?|&)category=/i, { timeout: 15000 });
    await expect(page).toHaveURL(/priceMin=\d+/i, { timeout: 15000 });
    await expect(page).toHaveURL(/priceMax=\d+/i, { timeout: 15000 });
  });

  test('RESET後に閉じてもフィルタカウントが増えない', async ({ page }) => {
    await gotoItemList(page);

    const drawer = await openItemFilters(page);
    const category = await expandItemFilterSection(drawer, 'CATEGORY');
    const stock = await expandItemFilterSection(drawer, 'STOCK');
    const price = await expandItemFilterSection(drawer, 'PRICE');
    const initialMin = await price.getByLabel('Minimum value').inputValue();
    const initialMax = await price.getByLabel('Maximum value').inputValue();
    await category.getByRole('checkbox', { name: 'TOPS', exact: true }).check();
    await stock.getByRole('checkbox', { name: 'IN STOCK', exact: true }).check();
    await price.getByLabel('Minimum value').press('ArrowRight');
    await expect(page).toHaveURL(/priceMin=\d+/i);

    await drawer.getByRole('button', { name: 'RESET' }).click();
    await expect(category.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();
    await expect(stock.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();
    await expect(category.getByRole('checkbox', { name: 'TOPS', exact: true })).not.toBeChecked();
    await expect(stock.getByRole('checkbox', { name: 'IN STOCK', exact: true })).not.toBeChecked();
    await expect(price.getByLabel('Minimum value')).toHaveValue(initialMin);
    await expect(price.getByLabel('Maximum value')).toHaveValue(initialMax);
    await closeItemFilters(drawer);

    await expect(page).not.toHaveURL(/(?:\?|&)(category|stock|priceMin|priceMax|collectionSeasons|collectionYearMin|collectionYearMax)=/i, { timeout: 15000 });
    if ((await page.evaluate(() => window.innerWidth)) < 1024) {
      await expect(page.locator('[data-filter-button="floating"]')).toHaveText('FILTER');
    }
    await expect(page.getByText('商品が見つかりません')).toHaveCount(0);

    const reopened = await openItemFilters(page);
    const restoredCategory = await expandItemFilterSection(reopened, 'CATEGORY');
    const restoredStock = await expandItemFilterSection(reopened, 'STOCK');
    await expect(restoredCategory.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();
    await expect(restoredStock.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();
    await closeItemFilters(reopened);

    await expect(page).not.toHaveURL(/(?:\?|&)(category|stock|priceMin|priceMax|collectionSeasons|collectionYearMin|collectionYearMax)=/i);
    if ((await page.evaluate(() => window.innerWidth)) < 1024) {
      await expect(page.locator('[data-filter-button="floating"]')).toHaveText('FILTER');
    }
    await expect(page.getByText('商品が見つかりません')).toHaveCount(0);
  });
});
