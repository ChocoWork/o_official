import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-002 ルックカード表示と遷移', () => {
  test('FR-LOOK-ALL-002-AC-01 カードにシーズン・テーマ・画像・紐づけ商品名を表示し詳細へ遷移できる', async ({ page }) => {
    // AC-01 はモバイル（390px）。モバイルでは画像の下の情報パネルに、シーズン・テーマ・関連商品の名前が出る
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/look');

    // 関連商品を持つ最初のカード（見本の LOOK 1。紐づけ商品は Aoi Linen Tunic と Mizu Wide Trousers）
    const card = page
      .locator('[data-testid="look-card"]')
      .filter({ has: page.locator('.look-related-items') })
      .first();
    await expect(card).toBeVisible();

    const image = card.locator('img').first();
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', /.+/);

    const caption = card.locator('[data-testid="look-card-caption"]');
    // FREQ-138: シーズンのラベルは「2026 SS」形式
    await expect(caption.locator('p').first()).toHaveText('2026 SS');
    await expect(caption.locator('h3')).toHaveText(/Aoi Weekend Layers/i);
    await expect(card.locator('a.look-related-item-text div > span:nth-child(1)')).toHaveText([
      'Aoi Linen Tunic',
      'Mizu Wide Trousers',
    ]);

    // 詳細へ遷移できる
    await card.locator('a[href^="/look/"]').first().click();
    await expect(page).toHaveURL(/\/look\/\d+$/);
  });
});
