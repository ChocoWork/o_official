import { expect, test } from '@playwright/test';

// FREQ-283: ヒーローの SCROLL の文字と縦線を、暗い写真の上でも読める白さにする。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-HOME-020 ヒーローの SCROLL の色', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} SCROLL ラベルと縦線が白 90% で描画される`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      // FREQ-283-AC-01
      // Tailwind v4 は色を oklab() で吐くため、getComputedStyle の文字列を
      // そのまま比較できない。canvas に 1px 塗って実際の sRGB 値を読む。
      const toRgba = (value: string) =>
        page.evaluate((color) => {
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('2d context unavailable');
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data);
        }, value);

      const label = page.locator('.hero-scroll-label').first();
      const labelColor = await label.evaluate((el) => getComputedStyle(el).color);
      // 白 90% = rgb(255,255,255) / alpha 0.9（255 * 0.9 = 229.5）
      expect(await toRgba(labelColor)).toEqual([255, 255, 255, 230]);

      const thread = page.locator('.hero-thread').first();
      const threadColor = await thread.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(await toRgba(threadColor)).toEqual([255, 255, 255, 230]);
    });
  }
});
