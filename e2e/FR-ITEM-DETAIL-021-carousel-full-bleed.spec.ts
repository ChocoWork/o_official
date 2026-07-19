import { test, expect, Page } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

// FREQ-159: カルーセルを main の px-5 に影響されないフルブリード表示にし、
// ピーク表示がビューポート端まで見えるようにする

async function gotoFirstItemDetail(page: Page): Promise<boolean> {
  const item = await fetchFirstItemViaApi(page);
  if (!item) return false;
  await page.goto(`/item/${item.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'wide mobile', width: 540, height: 720 },
]) {
  test.describe(`FR-ITEM-DETAIL-021 カルーセルフルブリード (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-159-AC-01: カルーセルコンテナがビューポート全幅である', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const box = await page
        .getByTestId('item-detail-carousel')
        .boundingBox();
      expect(box).not.toBeNull();
      // main の px-5 に食い込まれず、ビューポート端まで広がっている
      expect(Math.round(box!.x)).toBe(0);
      expect(Math.round(box!.x + box!.width)).toBe(viewport.width);
    });

    test('FREQ-159-AC-02: 横スクロールが発生しない', async ({ page }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(scrollW).toBeLessThanOrEqual(clientW);
    });
  });
}
