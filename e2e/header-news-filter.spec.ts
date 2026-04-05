import { test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile-320',  width: 320,  height: 568 },
  { name: 'mobile-375',  width: 375,  height: 812 },
  { name: 'mobile-425',  width: 425,  height: 896 },
  { name: 'tablet-768', width: 768,  height: 1024 },
  { name: 'pc-1024',    width: 1024, height: 768 },
  { name: 'pc-1440',    width: 1440, height: 900 },
];

test.describe('Header & NEWS filter responsive', () => {
  for (const vp of VIEWPORTS) {
    test(`news page – ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      await page.screenshot({
        path: `playwright-report/header-news-${vp.name}.png`,
        fullPage: false,
      });
    });
  }

  // モバイルでドロップダウンを開いた状態
  test('mobile filter dropdown open – 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    // ドロップダウンボタンをクリック
    await page.locator('button[aria-haspopup="listbox"]').click();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: 'playwright-report/news-filter-dropdown-open.png',
      fullPage: false,
    });
  });
});
