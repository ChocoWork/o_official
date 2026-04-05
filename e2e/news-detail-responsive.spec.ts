import { test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile',  width: 390,  height: 844 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

test.describe('NEWS detail page responsive', () => {
  for (const vp of VIEWPORTS) {
    test(`news detail – ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // NEWSリストページから最初の記事URLを取得
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      const firstLink = page.locator('article.border-b').first().locator('..').locator('a').first();
      // Link wraps article — locate the first anchor on the page that starts with /news/
      const firstArticleHref = await page.locator('a[href^="/news/"]').first().getAttribute('href');

      if (firstArticleHref) {
        await page.goto(firstArticleHref);
        await page.waitForLoadState('networkidle');
      } else {
        await page.goto('/news');
      }

      await page.screenshot({
        path: `playwright-report/news-detail-${vp.name}.png`,
        fullPage: true,
      });
    });
  }
});
