import { test, expect } from '@playwright/test';

/**
 * FR-NEWS-ALL-013 NEWS 一覧ページの記事カードに画像を表示しないこと
 * FREQ-32-AC-01: NEWS 一覧ページの記事カード内に img 要素が表示されないこと
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-NEWS-ALL-013 NEWS 一覧の記事カードに画像を表示しない', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): 記事カード内に img が存在しない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      const firstCard = page.locator('article').first();
      await expect(firstCard).toBeVisible();

      const imagesInCards = page.locator('article img');
      await expect(imagesInCards).toHaveCount(0);
    });
  }
});
