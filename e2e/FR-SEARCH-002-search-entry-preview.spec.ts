import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

test.describe('FR-SEARCH-002 search entry and instant preview', () => {
  test('ヘッダー検索アイコンから search ページへ遷移し、/?q= で即時プレビューを表示する', async ({ page }) => {
    const seed = await fetchSearchSeed(page);

    await page.goto('/');
    await page.locator('a[href="/search"]').first().click();
    await expect(page).toHaveURL(/\/search$/);

    await page.goto(`/?q=${encodeURIComponent(seed.query)}`);
    await expect(page.getByRole('heading', { name: 'Search Preview' })).toBeVisible();
    await expect(page.getByText(seed.itemName).first()).toBeVisible();
  });
});