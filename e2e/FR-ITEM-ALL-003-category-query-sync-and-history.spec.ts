import { expect, test } from '@playwright/test';
import { closeItemFilters, expandItemFilterSection, gotoItemList, openItemFilters } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-003 カテゴリURL同期', () => {
  test('カテゴリ選択がURLに反映され、戻るで復元される', async ({ page }) => {
    await gotoItemList(page);

    const filters = await openItemFilters(page);
    const category = await expandItemFilterSection(filters, 'CATEGORY');
    await category.getByRole('checkbox', { name: 'TOPS', exact: true }).check();
    await closeItemFilters(filters);

    await expect(page).toHaveURL(/category=TOPS/i, { timeout: 15000 });

    const firstDetailHref = await page.locator('[data-testid="item-card-link"]').first().getAttribute('href');
    expect(firstDetailHref).toBeTruthy();

    await page.goto(firstDetailHref!);
    await page.goBack();

    await expect(page).toHaveURL(/category=TOPS/i, { timeout: 15000 });
    const restoredFilters = await openItemFilters(page);
    const restoredCategory = await expandItemFilterSection(restoredFilters, 'CATEGORY');
    await expect(restoredCategory.getByRole('checkbox', { name: 'TOPS', exact: true })).toBeChecked();
  });
});
