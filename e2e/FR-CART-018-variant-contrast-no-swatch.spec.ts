import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FREQ-116: /cart のバリアントから色円を削除し、ラベル(COLOR/SIZE)を値より小さく・淡く・字間狭で従属させる（対比）。
 */

const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-CART-018 バリアントの色円削除とラベル従属 (FREQ-116)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockCartApis(page, [sampleCartItem({ color: 'Gold', size: 'FREE' })]);
      await page.goto('/cart');

      const variant = page.locator('[data-testid="cart-variant"]').first();
      await expect(variant).toBeVisible();

      const m = await variant.evaluate((root) => {
        const parse = (v: string) => Number.parseFloat(v);
        const label = root.querySelector<HTMLElement>('[data-variant-label]')!;
        // 値セル = 各行の3番目のspan（ラベル / コロン / 値）
        const spans = Array.from(root.querySelectorAll<HTMLElement>(':scope > span'));
        const value = spans[2];
        const labelCs = getComputedStyle(label);
        const valueCs = getComputedStyle(value);
        const lum = (color: string) => {
          const m = color.match(/\d+/g)!.map(Number);
          return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
        };
        return {
          hasSwatch: !!root.querySelector('.rounded-full, [style*="border-radius: 50%"]'),
          labelSize: parse(labelCs.fontSize),
          valueSize: parse(valueCs.fontSize),
          labelSpacing: labelCs.letterSpacing === 'normal' ? 0 : parse(labelCs.letterSpacing),
          labelSizePx: parse(labelCs.fontSize),
          labelLum: lum(labelCs.color),
          valueLum: lum(valueCs.color),
        };
      });

      // FREQ-116-AC-01: 色付きの円形スウォッチが存在しない
      expect(m.hasSwatch).toBe(false);

      // FREQ-116-AC-02: ラベル font-size < 値 font-size
      expect(m.labelSize).toBeLessThan(m.valueSize);

      // FREQ-116-AC-03: ラベルの字間が従来 0.08em 相当より狭い（0.08em × 約11px ≒ 0.9px 未満）
      expect(m.labelSpacing).toBeLessThan(0.08 * m.labelSizePx);

      // FREQ-116-AC-04: ラベル色が値色より淡い（輝度が高い）
      expect(m.labelLum).toBeGreaterThan(m.valueLum);
    });
  }
});
