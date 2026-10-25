import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-DETAIL-002 STYLING ITEMS', () => {
  test('FR-LOOK-DETAIL-002-AC-01 紐づけ商品一覧と商品遷移リンクを表示する', async ({ page }) => {
    // 見本の LOOK 1 の紐づけ商品: 商品1（Aoi Linen Tunic・89,000円）と商品3（Mizu Wide Trousers・20,999円）
    await page.goto('/look/1');

    await expect(page.getByText('STYLING ITEMS')).toBeVisible();
    await expect(page.getByText('紐づけ商品はありません')).toHaveCount(0);

    const layout = page.locator('[data-testid="look-detail-layout"]');
    const tunic = layout.locator('a[href="/item/1"]').filter({ hasText: 'Aoi Linen Tunic' }).first();
    const trousers = layout.locator('a[href="/item/3"]').filter({ hasText: 'Mizu Wide Trousers' }).first();
    await expect(tunic).toBeVisible();
    await expect(tunic).toContainText('89,000');
    await expect(trousers).toBeVisible();
    await expect(trousers).toContainText('20,999');
  });
});
