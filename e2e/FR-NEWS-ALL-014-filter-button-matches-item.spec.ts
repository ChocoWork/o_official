import { expect, Page, test } from '@playwright/test';

// FREQ-47-AC-01: NEWS 一覧のモバイル・タブレットの FILTER ボタンの文字サイズ・字間が
// ITEM 一覧の FILTER ボタンと一致すること。

async function filterButtonTypography(page: Page, path: string) {
  await page.goto(path);
  const button = page.locator('[data-filter-button="floating"]');
  await expect(button).toBeVisible();
  return button.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fontSize: cs.fontSize, letterSpacing: cs.letterSpacing };
  });
}

for (const vp of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const) {
  test.describe(`FR-NEWS-ALL-014 FILTER ボタンが ITEM と一致 (${vp.name})`, () => {
    test('NEWS の FILTER ボタンの文字サイズ・字間が ITEM と一致', async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const news = await filterButtonTypography(page, '/news');
      const item = await filterButtonTypography(page, '/item');

      expect(news.fontSize).toBe(item.fontSize);
      expect(news.letterSpacing).toBe(item.letterSpacing);
    });
  });
}
