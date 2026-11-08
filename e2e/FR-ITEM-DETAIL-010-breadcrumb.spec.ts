import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

// FR-ITEM-DETAIL-010（2026-11-07 改定）: 商品詳細のパンくず（HOME > ITEMS > 商品名）は 2026-07 に削除済み。
// 今は「パンくずが出ないこと」と「ITEM 一覧へ戻る /item のリンクがあること」を検証する。
test.describe('FR-ITEM-DETAIL-010 パンくずなし・戻るリンク', () => {
  test('パンくずナビゲーションが表示されない', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await expect(page.locator('[aria-label="breadcrumb" i]')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: /breadcrumb/i })).toHaveCount(0);
  });

  test('パンくずの HOME > ITEMS > 商品名の並びが商品詳細の本文に無い', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // パンくずが無いので、商品名の見出しの前に HOME・ITEMS を並べたリストは存在しない
    await expect(page.locator('ol:has(a[href="/"]):has(a[href="/item"])')).toHaveCount(0);
  });

  test('"BACK TO ITEMS" リンクが正常時にも表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // パンくずの ITEMS リンクか別の戻るリンクが存在する
    const backLink = page.locator('a[href="/item"]').first();
    await expect(backLink).toBeVisible();
  });
});
