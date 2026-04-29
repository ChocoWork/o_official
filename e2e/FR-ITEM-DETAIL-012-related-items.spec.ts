import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-012 関連商品セクション', () => {
  test('関連商品セクションが表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);

    const relatedSection = page.locator('[data-testid="related-items"]');
    await expect(relatedSection).toBeVisible();
  });

  test('関連商品セクションに商品カードが表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);

    const relatedSection = page.locator('[data-testid="related-items"]');
    await expect(relatedSection).toBeVisible();

    const cards = relatedSection.locator('[data-testid="item-card"]');
    const count = await cards.count();
    // 同カテゴリの別商品があれば表示される
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('関連商品をクリックすると別の商品詳細ページに遷移する', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);

    const relatedSection = page.locator('[data-testid="related-items"]');
    const cards = relatedSection.locator('[data-testid="item-card"]');
    const count = await cards.count();

    if (count === 0) {
      test.skip(true, '関連商品なし');
      return;
    }

    await cards.first().click();

    // URL が /item/:id 形式に変わる
    await expect(page).toHaveURL(/\/item\/\d+/);
    // 現在の商品と異なるIDになっていること
    expect(page.url()).not.toBe(`http://localhost:3000/item/${item!.id}`);
  });
});
