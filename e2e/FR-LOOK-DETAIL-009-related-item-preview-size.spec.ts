import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-177: LOOK詳細ページの関連アイテムのサムネイルを黄金比1段階（×√φ）拡大する。
// 既定の unit × φ³ に対し、unit × φ³ × √φ ≈ unit × 5.388 になること。

const PHI = (1 + Math.sqrt(5)) / 2;
const EXPECTED_RATIO = PHI ** 3 * Math.sqrt(PHI); // ≈ 5.388

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-DETAIL-009 関連アイテムのサムネイルを√φ倍に拡大', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} プレビュー高さが unit × φ³ × √φ`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      const list = page.locator('[data-ui-list][data-ui-list-variant="showcase"]');
      if ((await page.getByText('紐づけ商品はありません').count()) > 0) {
        // 紐づけ商品がない LOOK の場合はリスト自体が無いため対象外
        return;
      }
      await expect(list.first()).toBeVisible();

      const { unit, previewHeight } = await list.first().evaluate((el) => {
        const preview = el.querySelector('[data-list-preview]') as HTMLElement;
        return {
          unit: parseFloat(getComputedStyle(el).fontSize),
          previewHeight: preview.getBoundingClientRect().height,
        };
      });

      // AC-01: プレビュー高さ ≈ unit × φ³ × √φ（丸め誤差 ±1px 許容）
      expect(previewHeight).toBeGreaterThan(unit * EXPECTED_RATIO - 1);
      expect(previewHeight).toBeLessThan(unit * EXPECTED_RATIO + 1);
    });
  }
});
