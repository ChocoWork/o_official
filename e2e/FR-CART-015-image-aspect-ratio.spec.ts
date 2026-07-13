import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FREQ-113: /cart の商品画像を元画像の比率を保って切り抜きなしで表示する。
 */

const RATIO_TOLERANCE = 0.02;
const WIDTH_TOLERANCE_PX = 1;

const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-CART-015 商品画像を元比率で表示する (FREQ-113)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockCartApis(page, [
        sampleCartItem({
          items: {
            id: 101,
            name: 'Silk Blouse',
            price: 12000,
            image_url: '/original.jpg',
            category: 'TOPS',
          },
        }),
      ]);
      await page.goto('/cart');

      await expect(page.getByText('Silk Blouse')).toBeVisible();

      const img = page.locator('div.border-b.flex img').first();
      await expect(img).toBeVisible();
      // next/image の読み込み完了を待つ
      await expect
        .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0);

      const metrics = await img.evaluate((el: HTMLImageElement) => {
        const rect = el.getBoundingClientRect();
        return {
          naturalRatio: el.naturalWidth / el.naturalHeight,
          renderedRatio: rect.width / rect.height,
          renderedWidth: rect.width,
        };
      });

      // FREQ-113-AC-01: 表示比率が元画像の自然比と一致（切り抜き・歪みなし）
      expect(
        Math.abs(metrics.renderedRatio - metrics.naturalRatio),
        `ratio: natural=${metrics.naturalRatio.toFixed(3)} rendered=${metrics.renderedRatio.toFixed(3)}`,
      ).toBeLessThanOrEqual(RATIO_TOLERANCE);

      // FREQ-113-AC-02: 表示幅が 64px 相当
      expect(
        Math.abs(metrics.renderedWidth - 64),
        `width: got ${metrics.renderedWidth.toFixed(1)}px`,
      ).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
    });
  }
});
