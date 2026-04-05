import { test } from '@playwright/test';
import path from 'path';

const VIEWPORTS = [
  { name: 'mobile-320',  width: 320,  height: 812 },
  { name: 'mobile-375',  width: 375,  height: 812 },
  { name: 'mobile-425',  width: 425,  height: 812 },
  { name: 'tablet-768',  width: 768,  height: 1024 },
  { name: 'desktop-1024', width: 1024, height: 900 },
  { name: 'desktop-1440', width: 1440, height: 900 },
];

test.describe('NEWS detail page responsive', () => {
  for (const vp of VIEWPORTS) {
    test(`news detail – ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // NEWSリストページから最初の記事URLを取得
      await page.goto('/news', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      // Link wraps article — locate the first anchor on the page that starts with /news/
      const firstArticleHref = await page.locator('a[href^="/news/"]').first().getAttribute('href');

      if (firstArticleHref) {
        await page.goto(firstArticleHref, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
      } else {
        await page.goto('/news', { waitUntil: 'domcontentloaded' });
      }

      const screenshotDir = 'c:\\work\\o_official\\screenshots';
      await page.screenshot({
        path: `${screenshotDir}\\news-detail-${vp.name}.png`,
        fullPage: true,
      });

      // 2記事目（PREV+NEXTの両方がある記事）に移動してスクリーンショット
      const newsLinks = await page.locator('a[href^="/news/"]').all();
      const nextHref = newsLinks.length > 0 ? await newsLinks[0].getAttribute('href') : null;
      if (nextHref) {
        await page.goto(nextHref, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await page.screenshot({
          path: `${screenshotDir}\\news-detail-${vp.name}-mid.png`,
          fullPage: true,
        });
      }
    });
  }
});
