import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FREQ-115: /cart のバリアント表示を「色名 / サイズ」から
 * COLOR：<色名> / SIZE：<サイズ> の2行ラベル付き表示に変更する。
 */

const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-CART-017 バリアントを COLOR/SIZE 2行で表示 (FREQ-115)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockCartApis(page, [sampleCartItem({ color: 'Gold', size: 'FREE' })]);
      await page.goto('/cart');

      const row = page
        .locator('div.border-b.flex')
        .filter({ has: page.locator('input[type="number"]') })
        .first();
      await expect(row.getByText('Silk Blouse')).toBeVisible();

      // FREQ-115-AC-01: COLOR / SIZE ラベルと値が別行で表示
      await expect(row.getByText('COLOR', { exact: true })).toBeVisible();
      await expect(row.getByText('SIZE', { exact: true })).toBeVisible();
      await expect(row.getByText('Gold', { exact: true })).toBeVisible();
      await expect(row.getByText('FREE', { exact: true })).toBeVisible();

      // FREQ-115-AC-04: 旧スラッシュ連結表示をしない
      await expect(row.getByText('Gold / FREE')).toHaveCount(0);
    });
  }
});
