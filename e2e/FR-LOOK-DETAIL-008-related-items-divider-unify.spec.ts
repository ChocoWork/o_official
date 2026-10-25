import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-176: LOOK詳細ページの関連アイテムリストの上下の外枠線を、
// アイテム間の区切り線と同じ太さ・色（1px solid rgba(0,0,0,0.1)）に統一する。

// Tailwind v4 は black/10 を oklab(0 0 0 / 0.1)、List.css は rgb(0 0 0 / 0.1) を
// rgba(0, 0, 0, 0.1) として算出するため、黒＋アルファ値にパースして比較する。
function parseBlackAlpha(color: string): number {
  const m =
    color.match(/^rgba\(0, 0, 0, ([\d.]+)\)$/) ??
    color.match(/^oklab\(0 0 0 \/ ([\d.]+)\)$/);
  if (!m) throw new Error(`黒系の色ではありません: ${color}`);
  return Number(m[1]);
}

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-DETAIL-008 関連アイテムの外枠線をアイテム間の線と統一', () => {
  for (const vp of VIEWPORTS) {
    test(`FREQ-176-AC-01 ${vp.name} 上下の外枠線とアイテム間の線が同じ色・太さ`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      const list = page.locator('[data-ui-list][data-ui-list-variant="showcase"]');
      // 先頭の LOOK（見本の LOOK 1）には商品が 2 つ紐づくので、リストは必ずある（無くなったら赤）
      await expect(list.first()).toBeVisible();

      const listStyles = await list.first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          topColor: cs.borderTopColor,
          topWidth: cs.borderTopWidth,
          bottomColor: cs.borderBottomColor,
          bottomWidth: cs.borderBottomWidth,
        };
      });

      // AC-01 / AC-02: 上端・下端の線が 1px・黒10%
      expect(listStyles.topWidth).toBe('1px');
      expect(listStyles.bottomWidth).toBe('1px');
      expect(parseBlackAlpha(listStyles.topColor)).toBeCloseTo(0.1, 5);
      expect(parseBlackAlpha(listStyles.bottomColor)).toBeCloseTo(0.1, 5);

      // アイテム間の区切り線と一致することを確認（LOOK 1 には商品が 2 つ紐づくので、必ず 2 件以上ある）
      const items = list.first().locator('[data-list-item]');
      expect(await items.count()).toBeGreaterThanOrEqual(2);
      const dividerStyles = await items.first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          color: cs.borderBottomColor,
          width: cs.borderBottomWidth,
        };
      });
      expect(dividerStyles.width).toBe(listStyles.topWidth);
      expect(parseBlackAlpha(dividerStyles.color)).toBeCloseTo(
        parseBlackAlpha(listStyles.topColor),
        5,
      );
    });
  }
});
