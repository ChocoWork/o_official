import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

// FREQ-189: RECENT SEARCHES（検索履歴）の表示を削除し、
// 表示の唯一の利用先だった localStorage への保存も撤去した。
// 旧 FR-SEARCH-005（履歴を保持して再訪時に表示する）は本要件で廃止。

test.describe('FR-SEARCH-005 検索履歴の非表示', () => {
  test('AC-01/AC-02 履歴は表示されず localStorage にも保存されない', async ({ page }) => {
    const seed = await fetchSearchSeed(page);

    await page.goto('/search');
    const searchInput = page.locator('input[type="search"]');
    await searchInput.fill(seed.query);
    await searchInput.press('Enter');

    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(seed.query)}`));

    // 再訪してフォーカスしても RECENT SEARCHES は出ない
    await page.goto('/search');
    await searchInput.focus();

    await expect(page.getByText('RECENT SEARCHES')).toBeHidden();

    const storedHistory = await page.evaluate(() =>
      window.localStorage.getItem('search.history'),
    );
    expect(storedHistory).toBeNull();
  });
});
