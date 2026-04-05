import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

test.describe('PUBLIC NEWS list layout', () => {
  for (const vp of VIEWPORTS) {
    test(`news catalog page – ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      await page.screenshot({
        path: `playwright-report/news-list-${vp.name}.png`,
        fullPage: false,
      });

      // ボーダーで仕切られたリストが存在する
      const firstArticle = page.locator('article.border-b').first();
      await expect(firstArticle).toBeVisible();

      // タイトルが表示されている
      await expect(firstArticle.locator('h2')).toBeVisible();

      // カテゴリ文字が visible text に含まれる (sm:hidden / hidden sm:block を考慮した innerText 検証)
      const articleText = await firstArticle.innerText();
      expect(articleText).toMatch(/SUSTAINABILITY|COLLABORATION|COLLECTION|STORE|EVENT/);
    });
  }

  test('homepage news section layout', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const newsSection = page.locator('#news');
    await newsSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'playwright-report/news-home-section-desktop.png',
      fullPage: false,
    });

    const borderItems = newsSection.locator('article.border-b');
    const firstArticle = borderItems.first();
    await expect(firstArticle).toBeVisible();
    await expect(firstArticle.locator('h2')).toBeVisible();
  });
});
