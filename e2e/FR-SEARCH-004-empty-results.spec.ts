import { expect, test } from '@playwright/test';

test.describe('FR-SEARCH-004 empty results', () => {
  test('検索結果がゼロ件のときメッセージと人気商品を表示する', async ({ page }) => {
    const missingQuery = 'zzzz-no-search-hit-20260418';

    await page.goto(`/search?q=${encodeURIComponent(missingQuery)}`);

    await expect(page.getByText(`「${missingQuery}」の検索結果はありません`)).toBeVisible();
    await expect(page.getByRole('heading', { name: /popular items/i })).toBeVisible();
    await expect(page.locator('a[href^="/item/"]').first()).toBeVisible();
  });
});