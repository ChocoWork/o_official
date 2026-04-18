import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

test.describe('FR-SEARCH-005 search history', () => {
  test('検索履歴を localStorage に保持し再訪時にサジェスト表示する', async ({ page }) => {
    const seed = await fetchSearchSeed(page);

    await page.goto('/search');
    const searchInput = page.locator('input[type="search"]');
    await searchInput.fill(seed.query);
    await searchInput.press('Enter');

    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(seed.query)}`));

    await page.goto('/search');
    await searchInput.focus();

    await expect(page.getByRole('button', { name: seed.query }).first()).toBeVisible();
    const historyValues = await page.evaluate(() => {
      return JSON.parse(window.localStorage.getItem('search.history') ?? '[]') as string[];
    });
    expect(historyValues).toContain(seed.query);
  });
});