import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-182: 3カラムナビのアイコンを、にじむアイコンフォントから
// 細線ストローク（stroke-width 1）のインライン SVG に置換する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-DETAIL-014 ナビアイコンの細線 SVG 描画', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} アイコンがフォントではなく細線 SVG で描画される`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      const nav = page.locator('[data-testid="look-detail-bottom-nav"]');
      await nav.scrollIntoViewIfNeeded();

      // AC-01: 3アイコンがすべて svg で、アイコンフォント要素は存在しない
      const icons = nav.locator('[data-testid="look-detail-nav-icon"]');
      await expect(icons).toHaveCount(3);
      for (const tagName of await icons.evaluateAll((els) =>
        els.map((el) => el.tagName.toLowerCase()),
      )) {
        expect(tagName).toBe('svg');
      }
      await expect(nav.locator('i[class*="ri-"]')).toHaveCount(0);

      // AC-02 / AC-03: 線幅 1・塗りなし・線色は文字色を継承・正方形で 6xl サイズ
      const expectedSize = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.width = 'var(--lk-size-7xl)';
        document.body.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });

      const metrics = await icons.evaluateAll((els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            strokeWidth: style.strokeWidth,
            fill: style.fill,
            stroke: style.stroke,
            color: style.color,
            width: rect.width,
            height: rect.height,
          };
        }),
      );

      for (const metric of metrics) {
        expect(parseFloat(metric.strokeWidth)).toBeCloseTo(1, 1);
        expect(metric.fill).toBe('none');
        expect(metric.stroke).toBe(metric.color);
        expect(metric.width).toBeCloseTo(expectedSize, 0);
        expect(metric.height).toBeCloseTo(metric.width, 0);
      }
    });
  }
});
