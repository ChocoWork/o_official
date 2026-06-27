import { expect, test } from '@playwright/test';

// FREQ-50-AC-01: LOOK 一覧ページに「LOOK BOOK」見出しテキストが表示されないこと。
for (const vp of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const) {
  test.describe(`FR-LOOK-ALL-008 LOOK BOOK 見出し非表示 (${vp.name})`, () => {
    test('ページ最上部に LOOK BOOK 見出しが無い', async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await page.waitForLoadState('networkidle');

      await expect(
        page.getByRole('heading', { name: 'LOOK BOOK' }),
      ).toHaveCount(0);
    });
  });
}
