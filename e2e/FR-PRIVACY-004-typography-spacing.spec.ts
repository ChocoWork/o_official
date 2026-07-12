import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-101: 本文に line-height 1.9 を付与し、見出し階層を明確化する（/privacy・/terms 共通）。
 */
for (const path of ['/privacy', '/terms']) {
  test.describe(`FR-PRIVACY-004 タイポグラフィと余白 (${path})`, () => {
    for (const vp of viewports) {
      test(`${vp.name}: 本文行間が広く、見出しが本文より大きい`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);

        const paragraph = page.locator('section p').first();
        const metrics = await paragraph.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            fontSize: parseFloat(cs.fontSize),
            lineHeight: parseFloat(cs.lineHeight),
          };
        });

        // 本文の行間比が 1.5 より大きい（1.9 相当）こと
        expect(metrics.lineHeight / metrics.fontSize).toBeGreaterThan(1.5);

        const headingSize = await page
          .getByRole('heading', { level: 2 })
          .first()
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

        // セクション見出しが本文より大きいこと
        expect(headingSize).toBeGreaterThan(metrics.fontSize);
      });
    }
  });
}
