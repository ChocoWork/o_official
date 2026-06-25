import { expect, Page, test } from '@playwright/test';

// FREQ-48: NEWS 一覧の FILTER 選択肢（間隔・要素自体）を ITEM 一覧の Accordion 内の
// 子要素と同じにする。
// AC-01: 選択肢リストの gap が一致。
// AC-02: 選択肢ラベルの letter-spacing が一致。

async function filterOptionStyle(page: Page, path: string) {
  await page.goto(path);
  const optionList = page.locator('.multiselect__option-list:visible').first();
  await expect(optionList).toBeVisible();
  const gap = await optionList.evaluate((el) => getComputedStyle(el).gap);

  const label = optionList.locator('[data-ui-checkbox-label]').first();
  await expect(label).toBeVisible();
  const letterSpacing = await label.evaluate(
    (el) => getComputedStyle(el).letterSpacing,
  );

  return { gap, letterSpacing };
}

test.describe('FR-NEWS-ALL-015 FILTER 選択肢が ITEM と一致', () => {
  test('desktop: 選択肢の gap と letter-spacing が ITEM と一致', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    const news = await filterOptionStyle(page, '/news');
    const item = await filterOptionStyle(page, '/item');

    expect(news.gap).toBe(item.gap);
    expect(news.letterSpacing).toBe(item.letterSpacing);
  });
});
