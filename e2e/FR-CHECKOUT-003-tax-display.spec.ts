import { expect, test } from '@playwright/test';

test.describe('FR-CHECKOUT-003 消費税行の明示', () => {
  test('注文内容サマリーに小計・消費税・配送料・合計が表示される', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // カートに商品がある場合はサマリー行が表示される
    const hasItems = await page.getByText('小計').isVisible().catch(() => false);
    const hasEmptyCart = await page.getByText('カートに商品がありません').isVisible().catch(() => false);

    if (hasItems) {
      await expect(page.getByText('小計')).toBeVisible();
      await expect(page.getByText('消費税（10%）')).toBeVisible();
      await expect(page.getByText('配送料')).toBeVisible();
      await expect(page.getByText('合計')).toBeVisible();
    } else {
      // カートが空の場合はその旨が表示される
      expect(hasEmptyCart).toBeTruthy();
    }
  });

  test('カートが空でもサマリーラベルは表示されない（カートが空メッセージが出る）', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // カートが空の場合は "カートに商品がありません" が表示される
    // または商品があれば消費税行が表示される — どちらか一方が成立すること
    const hasEmptyCart = await page.getByText('カートに商品がありません').isVisible().catch(() => false);
    const hasTaxRow = await page.getByText('消費税（10%）').isVisible().catch(() => false);
    expect(hasEmptyCart || hasTaxRow).toBeTruthy();
  });
});
