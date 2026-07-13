import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FREQ-110: /cart の ORDER SUMMARY 開始位置を1つ目のカート商品の開始位置と揃える
 * FREQ-111: 「CONTINUE SHOPPING」導線を account 注文詳細の「購入履歴へ戻る」と同じ見た目・挙動に統一
 */

const ALIGN_TOLERANCE_PX = 4;

const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844, twoColumn: false },
  { label: 'tablet', width: 768, height: 1024, twoColumn: true },
  { label: 'desktop', width: 1280, height: 900, twoColumn: true },
] as const;

async function setupCart(page: import('@playwright/test').Page): Promise<void> {
  await mockCartApis(page, [
    sampleCartItem(),
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

test.describe('FR-CART-012 ORDER SUMMARY と1つ目の商品の開始位置整列 (FREQ-110)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setupCart(page);
      await page.goto('/cart');

      const summaryTitle = page.getByText('ORDER SUMMARY', { exact: true });
      await expect(summaryTitle).toBeVisible();

      const metrics = await page.evaluate(() => {
        const round = (n: number) => Math.round(n);
        const titles = Array.from(document.querySelectorAll('p'));
        const title = titles.find((p) => p.textContent?.trim() === 'ORDER SUMMARY');
        const box = title?.closest('.sticky') as HTMLElement | null;
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('div.border-b.flex'),
        );
        const firstRow = rows[0];
        const firstImg = firstRow?.querySelector('a');
        if (!title || !box || !firstRow || !firstImg) {
          throw new Error('required cart elements missing');
        }
        return {
          boxTop: round(box.getBoundingClientRect().top),
          titleTop: round(title.getBoundingClientRect().top),
          rowTop: round(firstRow.getBoundingClientRect().top),
          imgTop: round(firstImg.getBoundingClientRect().top),
        };
      });

      if (vp.twoColumn) {
        // FREQ-110-AC-01: サマリーカード上端 ≈ 1つ目の商品行上端
        expect(
          Math.abs(metrics.boxTop - metrics.rowTop),
          `box/row top diff: box=${metrics.boxTop} row=${metrics.rowTop}`,
        ).toBeLessThanOrEqual(ALIGN_TOLERANCE_PX);
        // FREQ-110-AC-02: 見出し上端 ≈ 1つ目の商品コンテンツ(画像)上端
        expect(
          Math.abs(metrics.titleTop - metrics.imgTop),
          `title/content top diff: title=${metrics.titleTop} img=${metrics.imgTop}`,
        ).toBeLessThanOrEqual(ALIGN_TOLERANCE_PX);
      } else {
        // モバイルは1カラム縦積み: サマリーは商品リストの下に配置される
        expect(metrics.boxTop).toBeGreaterThan(metrics.rowTop);
      }
    });
  }
});

test.describe('FR-CART-013 CONTINUE SHOPPING を購入履歴へ戻ると同スタイルに統一 (FREQ-111)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.label} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setupCart(page);
      await page.goto('/cart');

      const link = page.getByRole('link', { name: 'CONTINUE SHOPPING' });
      await expect(link).toBeVisible();

      // FREQ-111-AC-02: 先頭に左矢印アイコン
      await expect(link.locator('i.ri-arrow-left-line')).toHaveCount(1);

      const style = await link.evaluate((el) => {
        const cs = window.getComputedStyle(el);
        const parsePx = (v: string) => Number.parseFloat(v.replace('px', ''));
        return {
          color: cs.color,
          fontSizePx: parsePx(cs.fontSize),
          letterSpacingPx: parsePx(cs.letterSpacing),
        };
      });

      // FREQ-111-AC-01: 文字色 #767676 = rgb(118, 118, 118)
      expect(style.color).toBe('rgb(118, 118, 118)');

      // FREQ-111-AC-03: letter-spacing 0.08em 相当 (0.08 * font-size, 概ね 1px 前後)
      const expectedLetterSpacing = style.fontSizePx * 0.08;
      expect(
        Math.abs(style.letterSpacingPx - expectedLetterSpacing),
        `letter-spacing: expected≈${expectedLetterSpacing.toFixed(2)}px got ${style.letterSpacingPx.toFixed(2)}px`,
      ).toBeLessThanOrEqual(0.5);
    });
  }
});
