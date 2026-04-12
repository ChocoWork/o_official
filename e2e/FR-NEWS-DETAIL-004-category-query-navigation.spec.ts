import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail, gotoNewsList } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-004 category query navigation', () => {
  test('categoryクエリで同カテゴリ遷移を維持し、無効値はALL扱いにする', async ({ page }) => {
    const firstHref = await gotoFirstNewsDetail(page);
    const categoryText = ((await page.locator('span').filter({ hasText: /^(ALL|COLLECTION|EVENT|COLLABORATION|SUSTAINABILITY|STORE)$/ }).first().textContent()) ?? 'ALL').trim();
    const activeCategory = categoryText.toUpperCase();

    await page.goto(`${firstHref}?category=${activeCategory}`, { waitUntil: 'domcontentloaded' });

    const viewAllLink = page.getByRole('link', { name: 'VIEW ALL' }).first();
    await expect(viewAllLink).toHaveAttribute('href', new RegExp(`/news\\?category=${activeCategory}$`));

    await page.goto(`${firstHref}?category=INVALID_CATEGORY`, { waitUntil: 'domcontentloaded' });
    const fallbackViewAllLink = page.getByRole('link', { name: 'VIEW ALL' }).first();
    await expect(fallbackViewAllLink).toHaveAttribute('href', '/news');

    await gotoNewsList(page);
  });
});
