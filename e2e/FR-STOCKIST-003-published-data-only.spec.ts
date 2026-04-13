import { expect, test } from '@playwright/test';

test.describe('FR-STOCKIST-003 公開データ取得', () => {
  test('stockistページは空状態または店舗カードを表示できる', async ({ page }) => {
    await page.goto('/stockist');

    const cards = page.locator('article');
    const emptyText = page.getByText('公開中の店舗情報がありません');
    const hasCards = (await cards.count()) > 0;
    const hasEmpty = await emptyText.isVisible().catch(() => false);

    expect(hasCards || hasEmpty).toBeTruthy();
    if (hasCards) {
      await expect(cards.first()).toBeVisible();
    }
  });
});
