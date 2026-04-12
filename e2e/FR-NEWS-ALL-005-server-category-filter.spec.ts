import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-005 server category filter', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('category クエリ指定時に一覧記事が指定カテゴリのみになる', async ({ page }) => {
    await page.goto('/news?category=EVENT');
    await page.waitForLoadState('networkidle');

    const articles = page.locator('article');
    await expect(articles.first()).toBeVisible();

    const categoryLabels = new Set([
      'ALL',
      'COLLECTION',
      'EVENT',
      'COLLABORATION',
      'SUSTAINABILITY',
      'STORE',
      'BLOG',
    ]);

    const count = await articles.count();
    for (let index = 0; index < count; index += 1) {
      const categoriesInArticle = await articles.nth(index).evaluate((article, labels) => {
        const textNodes = Array.from(article.querySelectorAll('span'))
          .map((node) => node.textContent?.trim() ?? '')
          .filter((value) => labels.includes(value));
        return Array.from(new Set(textNodes));
      }, Array.from(categoryLabels));

      expect(categoriesInArticle).toEqual(['EVENT']);
    }
  });
});
