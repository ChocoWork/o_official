import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FREQ-117: /cart の数量セレクタ(Stepper)と「ご購入手続きへ」ボタンを一回り小さくする。
 */

const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-CART-019 数量セレクタと購入ボタンを一回り小さく (FREQ-117)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockCartApis(page, [sampleCartItem()]);
      await page.goto('/cart');

      // FREQ-117-AC-01: 数量セレクタ(Stepper)が 2xs
      const stepper = page.locator('[data-ui-stepper]').first();
      await expect(stepper).toBeVisible();
      await expect(stepper).toHaveAttribute('data-ui-size', '2xs');

      // FREQ-117-AC-02: 「ご購入手続きへ」ボタンが md
      const checkoutButton = page.locator('a[href="/checkout"]');
      await expect(checkoutButton).toBeVisible();
      await expect(checkoutButton).toHaveAttribute('data-ui-size', 'md');
    });
  }
});
