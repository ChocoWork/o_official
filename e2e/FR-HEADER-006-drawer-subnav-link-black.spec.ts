import { test, expect } from '@playwright/test';

/**
 * FR-HEADER-006 Drawerのアコーディオン子要素リンクの文字色が黒であること
 * FREQ-29-AC-01: 子要素リンクのcolorがrgb(17, 17, 17)であること
 */

// ハンバーガーメニューは1024px未満でのみ表示されるため、mobile/tabletのみテスト対象
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
];

test.describe('FR-HEADER-006 Drawer アコーディオン子要素リンクの色', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): 子要素リンクの色がrgb(17, 17, 17)`, async ({ page }) => {
      test.setTimeout(60000);

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/', { waitUntil: 'domcontentloaded' });

      const menuButton = page.locator('button[aria-label="Open menu"]');
      await expect(menuButton).toBeVisible();
      await menuButton.click();

      const drawerShell = page.locator('.header-drawer-shell');
      await expect(drawerShell).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(400);

      // アコーディオンを展開
      const firstTrigger = drawerShell.locator('[data-ui-accordion-trigger]').first();
      await expect(firstTrigger).toBeVisible();
      await firstTrigger.click();
      await page.waitForTimeout(300);

      const subnavLink = drawerShell.locator('.header-drawer-subnav-link').first();
      await expect(subnavLink).toBeVisible();

      const color = await subnavLink.evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe('rgb(17, 17, 17)');
    });
  }
});
