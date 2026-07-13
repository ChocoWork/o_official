import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FREQ-112: /cart の各商品行から単価×数量の行合計を撤去し、その位置に単価を表示する。
 * バリアント行の「単価 ¥X」キャプションは重複回避のため削除する。
 */

const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 900 },
] as const;

async function setupCart(page: import('@playwright/test').Page): Promise<void> {
  await mockCartApis(page, [
    // 単価 12,000 × 数量 1
    sampleCartItem(),
    // 単価 18,000 × 数量 2（行合計なら 36,000 になる）
    sampleCartItem({
      id: 'cart-2',
      item_id: 202,
      quantity: 2,
      color: 'Ivory',
      size: 'S',
      items: {
        id: 202,
        name: 'Tailored Pants',
        price: 18000,
        image_url: '/images/test-item-2.jpg',
        category: 'BOTTOMS',
      },
    }),
  ]);
}

test.describe('FR-CART-014 商品行に単価を表示する (FREQ-112)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setupCart(page);
      await page.goto('/cart');

      // 商品行は数量ステッパー（number入力）を持つ行に限定
      const itemRows = page
        .locator('div.border-b.flex')
        .filter({ has: page.locator('input[type="number"]') });
      await expect(itemRows).toHaveCount(2);

      // データ読み込み完了を待つ
      await expect(page.getByText('Tailored Pants')).toBeVisible();

      // FREQ-112-AC-01: 数量2の商品行でも金額は単価（18,000）で、行合計（36,000）ではない
      const qty2Row = itemRows.nth(1);
      await expect(qty2Row).toContainText('18,000');
      await expect(qty2Row).not.toContainText('36,000');

      // 数量1の商品行は単価12,000
      await expect(itemRows.nth(0)).toContainText('12,000');

      // FREQ-112-AC-02: 「単価」キャプションが表示されない
      await expect(page.getByText('単価', { exact: false })).toHaveCount(0);

      // FREQ-112-AC-03: 小計・合計は単価×数量の総和（12,000 + 18,000×2 = 48,000）
      const summary = page.getByText('ORDER SUMMARY', { exact: true }).locator('..');
      await expect(summary).toContainText('48,000');
    });
  }
});
