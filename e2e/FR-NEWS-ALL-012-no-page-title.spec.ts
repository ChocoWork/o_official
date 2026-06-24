import { test, expect } from '@playwright/test';

/**
 * FR-NEWS-ALL-012 NEWS 一覧ページにページ見出し「NEWS」を表示しないこと
 * FREQ-31-AC-01: NEWS 一覧ページにテキスト「NEWS」の見出し（h1）が表示されないこと
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-NEWS-ALL-012 NEWS 一覧ページにページ見出しを表示しない', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): ページ見出し h1「NEWS」が存在しない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      const pageHeading = page.getByRole('heading', { level: 1, name: 'NEWS' });
      await expect(pageHeading).toHaveCount(0);
    });
  }
});
