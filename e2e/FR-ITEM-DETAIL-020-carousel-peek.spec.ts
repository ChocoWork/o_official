import { test, expect, Page } from '@playwright/test';
import { fetchItemsViaApi } from './item-list-test-utils';

// FREQ-158: モバイル・タブレットのカルーセルで左右に余白を設け、
// 2枚以上のときは前後の画像の端が余白部分に見えるピーク表示にする

type ItemLike = { id: string | number; image_urls?: string[] };

async function fetchItems(page: Page): Promise<ItemLike[]> {
  return (await fetchItemsViaApi(page, '?page=1&pageSize=50')) as ItemLike[];
}

async function gotoItemDetail(page: Page, id: string | number): Promise<void> {
  await page.goto(`/item/${id}`);
  await page.waitForLoadState('networkidle');
}

function carouselSlides(page: Page) {
  return page.getByTestId('item-detail-carousel-slide');
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'wide mobile', width: 540, height: 720 },
]) {
  test.describe(`FR-ITEM-DETAIL-020 カルーセルピーク表示 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-158-AC-01: 表示中の画像の左右に余白がある', async ({
      page,
    }) => {
      const items = await fetchItems(page);
      test.skip(items.length === 0, '公開商品データがないためスキップ');
      await gotoItemDetail(page, items[0].id);

      const slide = await carouselSlides(page).first().boundingBox();
      expect(slide).not.toBeNull();
      // 左に余白がある
      expect(slide!.x).toBeGreaterThan(0);
      // 右に余白がある（スライド右端がビューポート幅より内側）
      expect(slide!.x + slide!.width).toBeLessThan(viewport.width);
    });

    test('FREQ-158-AC-02: 2枚以上のとき次の画像が右側に見える', async ({
      page,
    }) => {
      const items = await fetchItems(page);
      const multiImageItem = items.find(
        (i) => Array.isArray(i.image_urls) && i.image_urls.length > 1,
      );
      test.skip(!multiImageItem, '複数画像を持つ商品がないためスキップ');
      await gotoItemDetail(page, multiImageItem!.id);

      const first = await carouselSlides(page).first().boundingBox();
      const second = await carouselSlides(page).nth(1).boundingBox();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // 2枚目のスライド左端がビューポート内（1枚目の右側）に見えている
      // （FREQ-161 によりスライド幅は画像アスペクト基準のため、
      //  広い画面では2枚目全体が見えることもある）
      expect(second!.x).toBeLessThan(viewport.width);
      expect(second!.x).toBeGreaterThan(first!.x + first!.width - 1);
    });
  });
}

test.describe('FR-ITEM-DETAIL-020 カルーセルピーク表示 (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('FREQ-158-AC-03: desktop ではカルーセルが表示されない', async ({
    page,
  }) => {
    const items = await fetchItems(page);
    test.skip(items.length === 0, '公開商品データがないためスキップ');
    await gotoItemDetail(page, items[0].id);

    await expect(page.getByTestId('item-detail-carousel')).toBeHidden();
    await expect(page.getByTestId('item-detail-desktop-images')).toBeVisible();
  });
});
