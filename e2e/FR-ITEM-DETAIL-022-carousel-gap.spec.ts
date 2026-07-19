import { test, expect, Page } from '@playwright/test';
import { fetchItemsViaApi } from './item-list-test-utils';

// FREQ-162: モバイルカルーセルのスライド間隙間を 2px にする

type ItemLike = { id: string | number; image_urls?: string[] };

async function gotoMultiImageItem(page: Page): Promise<boolean> {
  const items = (await fetchItemsViaApi(page, '?page=1&pageSize=50')) as ItemLike[];
  const multiImageItem = items.find(
    (i) => Array.isArray(i.image_urls) && i.image_urls.length > 1,
  );
  if (!multiImageItem) return false;
  await page.goto(`/item/${multiImageItem.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'wide mobile', width: 540, height: 720 },
]) {
  test.describe(`FR-ITEM-DETAIL-022 カルーセルスライド間隙間 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-162: 隣接スライド間の隙間が約 2px である', async ({
      page,
    }) => {
      const ok = await gotoMultiImageItem(page);
      test.skip(!ok, '複数画像を持つ商品がないためスキップ');

      const slides = page.getByTestId('item-detail-carousel-slide');
      const first = await slides.nth(0).boundingBox();
      const second = await slides.nth(1).boundingBox();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();

      const gap = second!.x - (first!.x + first!.width);
      expect(gap).toBeGreaterThanOrEqual(1);
      expect(gap).toBeLessThanOrEqual(3);
    });
  });
}
