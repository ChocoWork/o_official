import { test, expect, Page } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

// FREQ-154: QUANTITY ステッパーを削除し、ADD TO CART は常に1点だけ追加する

async function gotoFirstItemDetail(page: Page): Promise<boolean> {
  const item = await fetchFirstItemViaApi(page);
  if (!item) return false;
  await page.goto(`/item/${item.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-016 QUANTITY 削除・1点追加 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-154-AC-01: QUANTITY が表示されない', async ({ page }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      await expect(page.getByText('QUANTITY')).toHaveCount(0);
    });

    test('FREQ-154-AC-02: ADD TO CART は quantity=1 で送信される', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      // カート API をモックして送信ペイロードを検証する
      let sentQuantity: number | null = null;
      await page.route('**/api/cart', async (route) => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON() as { quantity?: number };
          sentQuantity = body?.quantity ?? null;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true }),
          });
          return;
        }
        await route.continue();
      });

      // 未選択バリデーションを通すため、スウォッチとサイズを選択しておく
      const table = page.getByTestId('item-spec-table');
      const swatch = table.locator('button[aria-pressed][aria-label]').first();
      if ((await swatch.count()) > 0) await swatch.click();
      const sizeButton = table
        .locator('button[aria-pressed]:not([aria-label])')
        .first();
      if ((await sizeButton.count()) > 0) await sizeButton.click();

      await page.getByText('ADD TO CART').first().click();
      await expect.poll(() => sentQuantity).toBe(1);
    });
  });
}
