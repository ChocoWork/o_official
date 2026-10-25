import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-004 card content', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('FR-NEWS-ALL-004-AC-01 記事カードが日付・分類・タイトル・概要を表示する', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();

    // 全カードで 日付・分類・タイトル・概要 が空でないこと。
    const contents = await cards.evaluateAll((els) =>
      els.map((el) => ({
        date: el.querySelector('time')?.textContent?.trim() ?? '',
        category: el.querySelector('[data-ui-tag-label]')?.textContent?.trim() ?? '',
        title: el.querySelector('h2')?.textContent?.trim() ?? '',
        summary: el.querySelector('p')?.textContent?.trim() ?? '',
      })),
    );

    expect(contents.length).toBeGreaterThan(0);
    for (const card of contents) {
      expect(card.date).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
      expect(card.category.length).toBeGreaterThan(0);
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.summary.length).toBeGreaterThan(0);
    }
  });
});
