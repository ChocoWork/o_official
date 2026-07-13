import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FREQ-114: /cart の商品名・価格のフォントサイズを ITEM一覧カードに合わせ、
 * バリアント（色/サイズ）を一段小さくして従属させる。
 */

const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-CART-016 商品名・価格を ITEM一覧カードに合わせる (FREQ-114)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockCartApis(page, [sampleCartItem()]);
      await page.goto('/cart');

      await expect(page.getByText('Silk Blouse')).toBeVisible();

      const m = await page.evaluate(() => {
        const round = (n: number) => Math.round(n * 100) / 100;
        const row = Array.from(document.querySelectorAll<HTMLElement>('div.border-b.flex')).find(
          (r) => r.querySelector('input[type="number"]'),
        );
        if (!row) throw new Error('cart row not found');
        const name = row.querySelectorAll('a')[1] as HTMLElement;
        const variant = row.querySelector<HTMLElement>('[data-testid="cart-variant"]');
        const price = Array.from(row.querySelectorAll('span')).find((s) =>
          s.textContent?.includes('¥'),
        ) as HTMLElement;
        if (!name || !variant || !price) throw new Error('cart elements missing');

        // ITEM一覧カードの基準サイズ（--lk-size-2xs）をプローブで実測
        const probe = document.createElement('span');
        probe.style.fontSize = 'var(--lk-size-2xs)';
        document.body.appendChild(probe);
        const size2xs = round(parseFloat(getComputedStyle(probe).fontSize));
        probe.remove();

        const px = (el: HTMLElement) => round(parseFloat(getComputedStyle(el).fontSize));
        return {
          size2xs,
          nameSize: px(name),
          nameFamily: getComputedStyle(name).fontFamily,
          priceSize: px(price),
          priceWeight: getComputedStyle(price).fontWeight,
          variantSize: px(variant),
        };
      });

      // FREQ-114-AC-01: 商品名 = --lk-size-2xs、acumin-pro
      expect(m.nameSize).toBe(m.size2xs);
      expect(m.nameFamily.toLowerCase()).toContain('acumin-pro');

      // FREQ-114-AC-02: 価格 = --lk-size-2xs、font-weight 500
      expect(m.priceSize).toBe(m.size2xs);
      expect(m.priceWeight).toBe('500');

      // FREQ-114-AC-03: バリアントは商品名・価格より小さい
      expect(m.variantSize).toBeLessThan(m.nameSize);
      expect(m.variantSize).toBeLessThan(m.priceSize);
    });
  }
});
