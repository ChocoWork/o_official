import { test, expect } from '@playwright/test';

/**
 * FR-FOOTER-001 フッターのSHOP・INFORMATIONの各リンク項目間に十分な余白があること
 * FREQ-30-AC-01: 隣接するリンク項目同士の縦方向の間隔が10px以上あること
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

test.describe('FR-FOOTER-001 フッターナビリンクの項目間隔', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): 隣接リンクの縦間隔が10px以上`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/', { waitUntil: 'domcontentloaded' });

      const allLink = page.getByRole('contentinfo').getByRole('link', { name: 'ALL', exact: true });
      const topsLink = page.getByRole('contentinfo').getByRole('link', { name: 'TOPS', exact: true });

      await allLink.scrollIntoViewIfNeeded();
      await expect(allLink).toBeVisible();
      await expect(topsLink).toBeVisible();

      const allBox = await allLink.boundingBox();
      const topsBox = await topsLink.boundingBox();
      expect(allBox).not.toBeNull();
      expect(topsBox).not.toBeNull();

      // 上の項目の下端から次の項目の上端までの余白
      const gap = topsBox!.y - (allBox!.y + allBox!.height);
      expect(gap).toBeGreaterThanOrEqual(10);
    });
  }
});
