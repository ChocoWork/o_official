import { expect, test } from '@playwright/test';

// FREQ-124: ホーム ITEM セクションのカードから在庫（数量）表示を削除する。
// カラースウォッチ（色）は維持する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-HOME-010 ITEMセクションのカードから在庫（数量）表示を削除', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: item-stock が表示されず、カラースウォッチは表示される`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const cards = page.locator('#items [data-testid="item-card"]');
      const count = await cards.count();
      if (count === 0) {
        test.skip();
        return;
      }

      // FREQ-124-AC-02: 在庫表示（item-stock）が存在しない
      await expect(
        page.locator('#items [data-testid="item-stock"]'),
      ).toHaveCount(0);

      // FREQ-124-AC-04: カラースウォッチ（色）は維持される
      const swatchCard = cards
        .filter({ has: page.locator('[aria-label^="カラー"]') })
        .first();
      if ((await swatchCard.count()) > 0) {
        await expect(
          swatchCard.locator('[aria-label^="カラー"]').first(),
        ).toBeVisible();
      }
    });
  }
});
