import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail, gotoNewsList } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-004 category query navigation', () => {
  test('FR-NEWS-DETAIL-004-AC-01 categoryクエリで同カテゴリ遷移を維持する', async ({ page }) => {
    const firstHref = await gotoFirstNewsDetail(page);
    const categoryText = ((await page.locator('span').filter({ hasText: /^(ALL|COLLECTION|EVENT|COLLABORATION|SUSTAINABILITY|STORE)$/ }).first().textContent()) ?? 'ALL').trim();
    const activeCategory = categoryText.toUpperCase();

    await page.goto(`${firstHref}?category=${activeCategory}`, { waitUntil: 'domcontentloaded' });

    const viewAllLink = page.getByRole('link', { name: 'VIEW ALL' }).first();
    await expect(viewAllLink).toHaveAttribute('href', new RegExp(`/news\\?category=${activeCategory}$`));

    await gotoNewsList(page);
  });
});
