import { test, expect, Page } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

// FREQ-162: 768px 未満はカルーセル、768px 以上は画像58%／情報42%にする

async function gotoFirstItemDetail(page: Page): Promise<boolean> {
  const item = await fetchFirstItemViaApi(page);
  if (!item) return false;
  await page.goto(`/item/${item.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

function carousel(page: Page) {
  return page.getByTestId('item-detail-carousel');
}

function desktopImageBlock(page: Page) {
  return page.getByTestId('item-detail-desktop-images');
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'wide mobile', width: 540, height: 720 },
]) {
  test.describe(`FR-ITEM-DETAIL-019 モバイル配置 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-157-AC-01: 横スクロールカルーセルが表示され縦サムネイル列は表示されない', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      await expect(carousel(page)).toBeVisible();
      await expect(desktopImageBlock(page)).toBeHidden();
    });

    test('FREQ-157-AC-02: 商品情報が画像より下に縦積みで表示される', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const carouselBox = await carousel(page).boundingBox();
      const titleBox = await page.locator('h1').first().boundingBox();
      expect(carouselBox).not.toBeNull();
      expect(titleBox).not.toBeNull();

      // 商品名（h1）がカルーセルの下端より下にある＝縦積み
      expect(titleBox!.y).toBeGreaterThanOrEqual(
        carouselBox!.y + carouselBox!.height - 1,
      );
    });
  });
}

for (const viewport of [
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-019 2カラム配置 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-162: 画像の右側に商品情報を表示する', async ({ page }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      await expect(desktopImageBlock(page)).toBeVisible();
      await expect(carousel(page)).toBeHidden();

      const blockBox = await desktopImageBlock(page).boundingBox();
      const titleBox = await page.locator('h1').first().boundingBox();
      expect(blockBox).not.toBeNull();
      expect(titleBox).not.toBeNull();
      expect(titleBox!.x).toBeGreaterThanOrEqual(
        blockBox!.x + blockBox!.width - 1,
      );
    });
  });
}
