import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-183: 3カラムナビの配色を黒（hover で #474747）に、
// アイコンを 7xl に拡大し、ラベル字間を統一する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const BLACK = 'rgb(0, 0, 0)';

test.describe('FR-LOOK-DETAIL-015 ナビの黒配色とアイコン拡大', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} ラベル・アイコンが黒で字間が揃いアイコンが 7xl`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      const nav = page.locator('[data-testid="look-detail-bottom-nav"]');
      await nav.scrollIntoViewIfNeeded();

      // AC-01: ラベル3つが黒
      const labels = nav.locator('p');
      await expect(labels).toHaveCount(3);
      const labelStyles = await labels.evaluateAll((els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          return { color: style.color, letterSpacing: style.letterSpacing };
        }),
      );
      for (const style of labelStyles) {
        expect(style.color).toBe(BLACK);
      }

      // AC-03: 3ラベルの字間が同一
      const spacings = new Set(labelStyles.map((s) => s.letterSpacing));
      expect(spacings.size).toBe(1);

      // AC-01: アイコン3つが黒（stroke は currentColor 経由）
      const icons = nav.locator('[data-testid="look-detail-nav-icon"]');
      await expect(icons).toHaveCount(3);

      // AC-02: アイコンの描画サイズが var(--lk-size-7xl)
      const expectedSize = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.width = 'var(--lk-size-7xl)';
        document.body.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });

      const iconMetrics = await icons.evaluateAll((els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          return {
            color: style.color,
            stroke: style.stroke,
            width: el.getBoundingClientRect().width,
          };
        }),
      );

      for (const metric of iconMetrics) {
        expect(metric.color).toBe(BLACK);
        expect(metric.stroke).toBe(BLACK);
        expect(metric.width).toBeCloseTo(expectedSize, 0);
      }
    });
  }
});
