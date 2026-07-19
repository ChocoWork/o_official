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
    test(`${vp.name} 上下の外枠線とアイテム間の線が同じ色・太さ`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      const list = page.locator('[data-ui-list][data-ui-list-variant="showcase"]');
      if ((await page.getByText('紐づけ商品はありません').count()) > 0) {
        // 紐づけ商品がない LOOK の場合はリスト自体が無いため対象外
        return;
      }
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

      // アイテムが2件以上あればアイテム間の区切り線と一致することを確認
      const items = list.first().locator('[data-list-item]');
      if ((await items.count()) >= 2) {
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
      }
    });
  }
});
