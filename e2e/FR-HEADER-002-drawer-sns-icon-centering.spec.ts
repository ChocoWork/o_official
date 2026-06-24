import { test, expect } from '@playwright/test';

/**
 * FR-HEADER-002 Drawer の SNS アイコンが枠内中央に配置されること
 * FREQ-25-AC-01: SNSアイコンのリンク要素が flex かつ items-center justify-center で実装されていること
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-HEADER-002 Drawer SNS アイコン中央配置', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): SNS アイコンが枠内中央に配置されている`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const menuButton = page.locator('button[aria-label="Open menu"]');
      await menuButton.click();
      await page.waitForTimeout(300);

      const followSection = page.locator('.header-drawer-follow');
      await expect(followSection).toBeVisible();

      // SNS アイコンリンクの flex 配置を確認
      const snsLinks = followSection.locator('a');
      const count = await snsLinks.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const link = snsLinks.nth(i);
        const display = await link.evaluate((el) => getComputedStyle(el).display);
        const alignItems = await link.evaluate((el) => getComputedStyle(el).alignItems);
        const justifyContent = await link.evaluate((el) => getComputedStyle(el).justifyContent);

        expect(display).toBe('flex');
        expect(alignItems).toBe('center');
        expect(justifyContent).toBe('center');
      }
    });
  }
});
