import { test, expect } from '@playwright/test';

/**
 * FR-HEADER-001 Drawer にサイトタイトルが表示されないこと
 * FREQ-24-AC-01: Drawer内に「Le Fil des Heures」というテキストが表示されないこと
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-HEADER-001 Drawer にサイトタイトルが表示されないこと', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): Drawer 内にサイトタイトルが存在しない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      // メニューボタンをクリックして Drawer を開く
      const menuButton = page.locator('button[aria-label="Open menu"]');
      await expect(menuButton).toBeVisible();
      await menuButton.click();

      // Drawer が開くまで待機
      await page.waitForTimeout(300);

      // Drawer 内のサイトタイトルが存在しないことを確認
      const drawerShell = page.locator('.header-drawer-shell');
      await expect(drawerShell).toBeVisible();

      const titleInDrawer = drawerShell.locator('text="Le Fil des Heures"');
      await expect(titleInDrawer).toHaveCount(0);
    });
  }
});
