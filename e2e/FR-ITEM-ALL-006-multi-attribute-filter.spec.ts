import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-006 複数属性フィルタ', () => {
  test('サイズ・カラー・価格で絞り込み可能', async ({ page }) => {
    await gotoItemList(page);

    await page.getByLabel('Open filter drawer').click();

    const drawer = page.getByRole('complementary');

    const toggleAndAssertSection = async (label: string) => {
      const toggleButton = drawer.getByRole('button', { name: `Toggle ${label} section` });
      await expect(toggleButton).toContainText('-');
      await toggleButton.click();
      await expect(toggleButton).toContainText('+');
      await toggleButton.click();
      await expect(toggleButton).toContainText('-');
      return toggleButton;
    };

    await toggleAndAssertSection('CATEGORY');
    await toggleAndAssertSection('COLOR');
    await toggleAndAssertSection('STOCK');
    await toggleAndAssertSection('SIZE');
    await toggleAndAssertSection('SEASON');
    await toggleAndAssertSection('PRICE');

    // CATEGORY は常時展開。複数選択可能。
    await drawer.locator('label', { hasText: 'TOPS' }).click();
    await drawer.locator('label', { hasText: 'BOTTOMS' }).click();
    await expect(drawer.getByLabel('CATEGORY TOPS')).toBeChecked();
    await expect(drawer.getByLabel('CATEGORY BOTTOMS')).toBeChecked();
    await expect(drawer.getByLabel('CATEGORY ALL')).not.toBeChecked();

    // ALL で他カテゴリ選択をリセット
    await drawer.locator('label:has(input[aria-label="CATEGORY ALL"])').click();
    await expect(drawer.getByLabel('CATEGORY TOPS')).not.toBeChecked();
    await expect(drawer.getByLabel('CATEGORY BOTTOMS')).not.toBeChecked();
    await expect(drawer.getByLabel('CATEGORY ALL')).toBeChecked();

    const colorOptions = drawer.locator('input[aria-label^="COLOR "]');
    const colorCount = await colorOptions.count();
    if (colorCount > 1) {
      const firstColorLabel = await colorOptions.nth(1).getAttribute('aria-label');
      if (firstColorLabel) {
        await drawer.locator(`label:has(input[aria-label="${firstColorLabel}"])`).click();
        await expect(drawer.getByLabel(firstColorLabel)).toBeChecked();
      }
      await drawer.locator('label:has(input[aria-label="COLOR ALL"])').click();
      if (firstColorLabel) {
        await expect(drawer.getByLabel(firstColorLabel)).not.toBeChecked();
      }
      await expect(drawer.getByLabel('COLOR ALL')).toBeChecked();
    }

    const sizeOptions = drawer.locator('input[aria-label^="SIZE "]');
    const sizeCount = await sizeOptions.count();
    if (sizeCount > 1) {
      const firstSizeLabel = await sizeOptions.nth(1).getAttribute('aria-label');
      if (firstSizeLabel) {
        await drawer.locator(`label:has(input[aria-label="${firstSizeLabel}"])`).click();
        await expect(drawer.getByLabel(firstSizeLabel)).toBeChecked();
      }
      await drawer.locator('label:has(input[aria-label="SIZE ALL"])').click();
      if (firstSizeLabel) {
        await expect(drawer.getByLabel(firstSizeLabel)).not.toBeChecked();
      }
      await expect(drawer.getByLabel('SIZE ALL')).toBeChecked();
    }

    await drawer.locator('label:has(input[aria-label="STOCK IN STOCK"])').click();
    await expect(drawer.getByLabel('STOCK IN STOCK')).toBeChecked();
    await expect(drawer.getByLabel('STOCK ALL')).not.toBeChecked();
    await drawer.locator('label:has(input[aria-label="STOCK ALL"])').click();
    await expect(drawer.getByLabel('STOCK IN STOCK')).not.toBeChecked();
    await expect(drawer.getByLabel('STOCK ALL')).toBeChecked();

    await drawer.locator('label:has(input[aria-label="SEASON AW"])').click();
    await expect(drawer.getByLabel('SEASON AW')).toBeChecked();
    await expect(drawer.getByLabel('SEASON SS')).not.toBeChecked();
    await expect(drawer.getByLabel('SEASON ALL')).not.toBeChecked();
    await drawer.locator('label:has(input[aria-label="SEASON ALL"])').click();
    await expect(drawer.getByLabel('SEASON AW')).not.toBeChecked();
    await expect(drawer.getByLabel('SEASON SS')).not.toBeChecked();
    await expect(drawer.getByLabel('SEASON ALL')).toBeChecked();

    await page.getByLabel('Minimum value').press('ArrowRight');
    await page.getByLabel('Maximum value').press('ArrowLeft');
    await page.getByLabel('Close filter drawer').click();

    await expect(page).not.toHaveURL(/(?:\?|&)category=/i, { timeout: 15000 });
    await expect(page).toHaveURL(/priceMin=\d+/i, { timeout: 15000 });
    await expect(page).toHaveURL(/priceMax=\d+/i, { timeout: 15000 });
  });

  test('RESET後に閉じてもフィルタカウントが増えない', async ({ page }) => {
    await gotoItemList(page);

    const filterButton = page.getByLabel('Open filter drawer');

    await page.getByLabel('Open filter drawer').click();
    const drawer = page.getByRole('complementary');

    await drawer.locator('label:has(input[aria-label="CATEGORY TOPS"])').click();

    await drawer.locator('label:has(input[aria-label="STOCK IN STOCK"])').click();

    await page.getByLabel('Minimum value').press('ArrowRight');

    await drawer.getByRole('button', { name: 'RESET' }).click();
    await page.getByLabel('Close filter drawer').click();

    await expect(page).not.toHaveURL(/(?:\?|&)(category|stock|priceMin|priceMax|collectionSeasons|collectionYearMin|collectionYearMax)=/i, { timeout: 15000 });
    await expect(filterButton).toContainText('FILTER +');
    await expect(filterButton).not.toContainText('(');
    await expect(page.getByText('商品が見つかりません')).toHaveCount(0);

    await page.getByLabel('Open filter drawer').click();
    await page.getByLabel('Close filter drawer').click();

    await expect(filterButton).toContainText('FILTER +');
    await expect(filterButton).not.toContainText('(');
    await expect(page.getByText('商品が見つかりません')).toHaveCount(0);
  });
});
