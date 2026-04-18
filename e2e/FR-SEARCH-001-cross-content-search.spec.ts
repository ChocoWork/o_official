import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

test.describe('FR-SEARCH-001 cross-content search', () => {
  test('/search が q と tab を URL 同期し、種別タブで結果を切り替えられる', async ({ page }) => {
    const seed = await fetchSearchSeed(page);

    await page.goto(`/search?q=${encodeURIComponent(seed.query)}`);

    await expect(page.getByRole('heading', { level: 1, name: /search/i })).toBeVisible();
    await expect(page.locator('input[type="search"]')).toHaveValue(seed.query);
    await expect(page.getByRole('tab', { name: 'ALL' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ITEM' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'LOOK' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'NEWS' })).toBeVisible();

    await page.getByRole('tab', { name: 'NEWS' }).click();
    await expect(page).toHaveURL(/tab=news/i);
    await expect(page.getByText('NEWS', { exact: true }).first()).toBeVisible();

    await page.getByRole('tab', { name: 'ITEM' }).click();
    await expect(page).toHaveURL(/tab=item/i);
    await expect(page.getByText(seed.itemName).first()).toBeVisible();
  });
});