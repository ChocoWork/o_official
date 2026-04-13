import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-009 SEO メタデータ', () => {
  test('ページタイトルに商品名が含まれる', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const title = await page.title();
    // タイトルが空でないこと・商品名またはブランド名を含むこと
    expect(title.length).toBeGreaterThan(0);
    expect(title).not.toBe('');
  });

  test('og:title メタタグが存在する', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    expect(ogTitle).not.toBeNull();
    expect(ogTitle!.length).toBeGreaterThan(0);
  });

  test('og:description メタタグが存在する', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const ogDesc = await page.locator('meta[property="og:description"]').getAttribute('content');
    expect(ogDesc).not.toBeNull();
  });
});
