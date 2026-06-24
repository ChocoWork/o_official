import { test, expect } from '@playwright/test';

/**
 * FR-HEADER-005 Drawerの閉じる×ボタンがハンバーガーメニューと同じ座標に配置されること
 * FREQ-28-AC-01: ×ボタンの中心X座標がハンバーガーメニューボタンの中心X座標と±2px以内で一致すること
 */

// ハンバーガーメニューは1024px未満でのみ表示されるため、mobile/tabletのみテスト対象
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
];

test.describe('FR-HEADER-005 Drawer 閉じるボタンの座標', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): ×ボタンの中心XがハンバーガーメニューのX座標と±2px以内`, async ({ page }) => {
      test.setTimeout(60000);

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/', { waitUntil: 'domcontentloaded' });

      // ハンバーガーメニューボタンの中心Xを取得
      const menuButton = page.locator('button[aria-label="Open menu"]');
      await expect(menuButton).toBeVisible();
      const menuBox = await menuButton.boundingBox();
      expect(menuBox).not.toBeNull();
      const menuCenterX = menuBox!.x + menuBox!.width / 2;

      // Drawerを開く
      await menuButton.click();
      const drawerShell = page.locator('.header-drawer-shell');
      await expect(drawerShell).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(400);

      // ×ボタンの中心Xを取得
      const closeButton = page.locator('button[aria-label="Close drawer"]');
      await expect(closeButton).toBeVisible();
      const closeBox = await closeButton.boundingBox();
      expect(closeBox).not.toBeNull();
      const closeCenterX = closeBox!.x + closeBox!.width / 2;

      expect(Math.abs(closeCenterX - menuCenterX)).toBeLessThanOrEqual(2);
    });
  }
});
