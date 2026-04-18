import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

test.describe('FR-SEARCH-003 fulltext and highlight', () => {
  test('検索結果に一致箇所のハイライトを表示する', async ({ page }) => {
    const seed = await fetchSearchSeed(page);

    await page.goto(`/search?q=${encodeURIComponent(seed.query)}&tab=item`);

    await expect(page.getByText(seed.itemName).first()).toBeVisible();
    await expect(page.locator('mark').first()).toContainText(seed.query);
  });
});