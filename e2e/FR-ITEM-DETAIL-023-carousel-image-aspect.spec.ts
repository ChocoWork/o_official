import { test, expect, Page } from '@playwright/test';
import { fetchItemsViaApi } from './item-list-test-utils';

// FREQ-162 / FREQ-307: 768px 未満のカルーセルを画面幅比の隙間・2:3アスペクトにする

type ItemLike = { id: string | number; image_urls?: string[] };

async function gotoMultiImageItem(page: Page): Promise<boolean> {
  const items = (await fetchItemsViaApi(
    page,
    '?page=1&pageSize=50',
  )) as ItemLike[];
  const multiImageItem = items.find(
    (i) => Array.isArray(i.image_urls) && i.image_urls.length > 1,
  );
  if (!multiImageItem) return false;
  await page.goto(`/item/${multiImageItem.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

function carouselSlides(page: Page) {
  return page.getByTestId('item-detail-carousel-slide');
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'mobile M', width: 425, height: 1175 },
  { name: 'wide mobile', width: 540, height: 720 },
]) {
  test.describe(`FR-ITEM-DETAIL-023 カルーセル画像アスペクト (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-162 / FREQ-307: 隣接スライド間の隙間が画面幅の0.625%で余白との比が1:10である', async ({
      page,
    }) => {
      const ok = await gotoMultiImageItem(page);
      test.skip(!ok, '複数画像を持つ商品がないためスキップ');

      const first = await carouselSlides(page).nth(0).boundingBox();
      const second = await carouselSlides(page).nth(1).boundingBox();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();

      const gap = second!.x - (first!.x + first!.width);
      const expectedGap = viewport.width * 0.00625;
      // 従来の ±1px の許容差を保ち、固定2pxではなく画面幅比を検証する。
      expect(gap).toBeGreaterThanOrEqual(expectedGap - 1);
      expect(gap).toBeLessThanOrEqual(expectedGap + 1);
      const carousel = await page.getByTestId('item-detail-carousel').boundingBox();
      expect(carousel).not.toBeNull();
      const inset = first!.x - carousel!.x;
      expect(Math.abs(inset / first!.width - 1 / 14)).toBeLessThanOrEqual(0.005);
      expect(Math.abs(first!.width / viewport.width - 0.875)).toBeLessThanOrEqual(0.005);
      expect(Math.abs(gap / inset - 0.1)).toBeLessThanOrEqual(0.01);
      expect(second!.x).toBeLessThan(viewport.width);
      const widths = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    });

    test('FREQ-162: スライドの幅と高さの比が 2:3 である', async ({
      page,
    }) => {
      const ok = await gotoMultiImageItem(page);
      test.skip(!ok, '複数画像を持つ商品がないためスキップ');

      const slide = await carouselSlides(page).first().boundingBox();
      expect(slide).not.toBeNull();
      expect(slide!.width / slide!.height).toBeCloseTo(2 / 3, 1);
    });
  });
}
