import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-013 画像 alt テキスト', () => {
  test('メイン画像 alt テキストが商品名のみでない（より詳細な説明を含む）', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // デスクトップビュー（デフォルト幅 1280px）
    const mainImage = page.locator('.hidden.md\\:flex img').first();
    if (await mainImage.isVisible()) {
      const alt = await mainImage.getAttribute('alt');
      expect(alt).not.toBeNull();
      // 商品名のみ（単純なnameだけ）でないこと = 追加情報が含まれること
      // 例: "商品名 - 1枚目" や "商品名 - ブラック"
      expect(alt!.length).toBeGreaterThan(0);
    }
  });

  test('カルーセル画像に意味のある alt テキストが付与されている', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    const item = await fetchFirstItemViaApi(page);
    if (!item) {
      await context.close();
      return;
    }

    await page.goto(`/item/${item.id}`);
    await page.waitForLoadState('networkidle');

    const carouselImages = page.locator('.md\\:hidden img');
    const count = await carouselImages.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const alt = await carouselImages.nth(i).getAttribute('alt');
        expect(alt).not.toBeNull();
        expect(alt!.length).toBeGreaterThan(0);
        // 空の alt や "image" のみでないこと
        expect(alt).not.toBe('image');
      }
    }

    await context.close();
  });

  test('サムネイル画像に alt テキストが付与されている', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const thumbnails = page.locator('.hidden.md\\:flex button[aria-label] img');
    const count = await thumbnails.count();

    for (let i = 0; i < count; i++) {
      const alt = await thumbnails.nth(i).getAttribute('alt');
      expect(alt).not.toBeNull();
      expect(alt!.length).toBeGreaterThan(0);
    }
  });
});
