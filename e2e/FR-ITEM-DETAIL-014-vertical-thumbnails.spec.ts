import { test, expect, Page } from '@playwright/test';
import { fetchItemsViaApi } from './item-list-test-utils';

// FREQ-152: ITEM詳細ページのデスクトップ表示で、
// 商品画像をサムネイル縦列（左）＋メイン画像（右）の配置にする

async function gotoFirstItemDetail(page: Page): Promise<boolean> {
  const items = await fetchItemsViaApi(page, '?page=1&pageSize=50');
  if (items.length === 0) return false;
  // 複数画像を持つ商品を優先（サムネイル列の検証に必要）
  const multiImageItem = items.find(
    (i) =>
      Array.isArray((i as { image_urls?: string[] }).image_urls) &&
      (i as { image_urls?: string[] }).image_urls!.length > 1,
  );
  const item = multiImageItem ?? items[0];
  await page.goto(`/item/${item.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

function desktopImageBlock(page: Page) {
  return page.getByTestId('item-detail-desktop-images');
}

function thumbnails(page: Page) {
  return desktopImageBlock(page).locator('button[aria-label*="枚目を表示"]');
}

// FREQ-157 によりタブレットはモバイルと同じカルーセル配置になったため、
// サムネイル縦列の検証は desktop のみ
for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }]) {
  test.describe(`FR-ITEM-DETAIL-014 サムネイル縦列レイアウト (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-152-AC-01: サムネイル列がメイン画像の左側に縦並びで表示される', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const thumbs = thumbnails(page);
      const count = await thumbs.count();
      test.skip(count < 2, 'サムネイルが1枚以下のためスキップ');

      const block = desktopImageBlock(page);
      await expect(block).toBeVisible();

      // メイン画像コンテナ（サムネイル列の兄弟要素）
      const mainImage = block.locator('> div.relative').first();
      await expect(mainImage).toBeVisible();

      const thumb0 = await thumbs.nth(0).boundingBox();
      const thumb1 = await thumbs.nth(1).boundingBox();
      const main = await mainImage.boundingBox();
      expect(thumb0).not.toBeNull();
      expect(thumb1).not.toBeNull();
      expect(main).not.toBeNull();

      // サムネイルはメイン画像より左にある
      expect(thumb0!.x + thumb0!.width).toBeLessThanOrEqual(main!.x + 1);
      // サムネイルは縦に並んでいる（同じ x、2枚目は1枚目の下）
      expect(Math.abs(thumb0!.x - thumb1!.x)).toBeLessThan(2);
      expect(thumb1!.y).toBeGreaterThan(thumb0!.y + thumb0!.height - 1);
    });

    test('FREQ-152-AC-02: サムネイルをクリックするとメイン画像が切り替わる', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const thumbs = thumbnails(page);
      const count = await thumbs.count();
      test.skip(count < 2, 'サムネイルが1枚以下のためスキップ');

      const secondThumbSrc = await thumbs
        .nth(1)
        .locator('img')
        .getAttribute('src');

      await thumbs.nth(1).click();
      await expect(thumbs.nth(1)).toHaveClass(/ring-2/);

      const mainImg = desktopImageBlock(page)
        .locator('> div.relative img')
        .first();
      await expect(mainImg).toHaveAttribute('src', secondThumbSrc!);
    });
  });
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
]) {
  test.describe(`FR-ITEM-DETAIL-014 サムネイル縦列レイアウト (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-152-AC-03: カルーセルが表示され縦サムネイル列は表示されない', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      // 横スクロールカルーセルが表示される
      const carousel = page.getByTestId('item-detail-carousel');
      await expect(carousel).toBeVisible();

      // デスクトップ用のサムネイル縦列ブロックは非表示
      await expect(desktopImageBlock(page)).toBeHidden();
    });
  });
}

test.describe('FR-ITEM-DETAIL-014 タブレット画像レイアウト', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('FREQ-162: メイン画像を表示し、縦サムネイル列は lg まで表示しない', async ({
    page,
  }) => {
    const ok = await gotoFirstItemDetail(page);
    test.skip(!ok, '公開商品データがないためスキップ');

    await expect(desktopImageBlock(page)).toBeVisible();
    await expect(page.getByTestId('item-detail-carousel')).toBeHidden();
    const tabletThumbnails = thumbnails(page);
    if ((await tabletThumbnails.count()) > 0) {
      await expect(tabletThumbnails.first()).toBeHidden();
    }
  });
});
