import { test, expect } from '@playwright/test';

/**
 * FR-HEADER-004 Drawerのアコーディオン展開時に子要素と次の親要素との間に十分な余白があること
 * FREQ-27-AC-01: 子要素末尾から次の親アコーディオン項目border-topまでの間隔が20px以上あること
 */

// ハンバーガーメニューは1024px未満でのみ表示されるため、mobile/tabletのみテスト対象
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
];

test.describe('FR-HEADER-004 Drawer アコーディオン子要素と次の親要素の余白', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): アコーディオン展開時の子要素と次の親要素の間隔が20px以上`, async ({ page }) => {
      test.setTimeout(60000);

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/', { waitUntil: 'domcontentloaded' });

      const menuButton = page.locator('button[aria-label="Open menu"]');
      await expect(menuButton).toBeVisible();
      await menuButton.click();

      // Drawerの中のshellが表示されるまで待つ
      const drawerShell = page.locator('.header-drawer-shell');
      await expect(drawerShell).toBeVisible({ timeout: 5000 });

      // Drawerアニメーション完了を待つ
      await page.waitForTimeout(400);

      // Drawer内のアコーディオントリガーをクリック
      const firstTrigger = drawerShell.locator('[data-ui-accordion-trigger]').first();
      await expect(firstTrigger).toBeVisible();
      await firstTrigger.click();
      await page.waitForTimeout(300);

      // コンテンツエリアのpadding-bottomを確認
      const content = drawerShell.locator('[data-ui-accordion-content]').first();
      await expect(content).toBeVisible();

      const paddingBottom = await content.evaluate((el) => {
        return parseFloat(getComputedStyle(el).paddingBottom);
      });

      expect(paddingBottom).toBeGreaterThanOrEqual(20);
    });
  }
});
