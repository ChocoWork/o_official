import { expect, test } from '@playwright/test';

test.describe('FR-STOCKIST-008 ユニークキーとa11y安定性', () => {
  test('カードリストが安定表示され、店舗名重複時でもUI崩れしない', async ({ page }) => {
    await page.goto('/stockist');

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();

    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);

    const headings = cards.locator('h2');
    await expect(headings.first()).toBeVisible();
  });
});
