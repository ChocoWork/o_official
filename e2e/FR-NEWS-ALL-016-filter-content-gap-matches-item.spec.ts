import { expect, Page, test } from '@playwright/test';

// FREQ-49-AC-01: デスクトップで NEWS 一覧のフィルター縦線とコンテンツの距離
// （コンテンツ列の左 padding）が ITEM 一覧と一致すること。

async function contentPaddingLeft(page: Page, path: string, testId: string) {
  await page.goto(path);
  const column = page.getByTestId(testId);
  await expect(column).toBeVisible();
  return column.evaluate((el) => getComputedStyle(el).paddingLeft);
}

for (const width of [1024, 1280, 1536]) {
  test.describe(`FR-NEWS-ALL-016 フィルター縦線とコンテンツの距離が ITEM と一致 (${width}px)`, () => {
    test('NEWS のコンテンツ列の左 padding が ITEM と一致', async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });

      const news = await contentPaddingLeft(page, '/news', 'news-content-column');
      const item = await contentPaddingLeft(page, '/item', 'item-content-column');

      expect(news).toBe(item);
    });
  });
}
