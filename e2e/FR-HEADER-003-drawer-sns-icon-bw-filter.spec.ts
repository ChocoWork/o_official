import { test, expect } from '@playwright/test';

/**
 * FR-HEADER-003 Drawer の SNS アイコンが白黒のみで描画されること
 * FREQ-26-AC-01: 通常時 brightness(0)、ホバー時 brightness(0) invert(1) が適用されること
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-HEADER-003 Drawer SNS アイコン白黒フィルター', () => {
  for (const vp of viewports) {
    test(`${vp.name} (${vp.width}px): SNS アイコンに brightness filter が適用されている`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const menuButton = page.locator('button[aria-label="Open menu"]');
      await menuButton.click();
      await page.waitForTimeout(300);

      const followSection = page.locator('.header-drawer-follow');
      await expect(followSection).toBeVisible();

      // 通常状態: アイコンに brightness(0) が適用されていること
      const icons = followSection.locator('.header-drawer-follow-icon');
      const count = await icons.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const icon = icons.nth(i);
        const filter = await icon.evaluate((el) => getComputedStyle(el).filter);
        // brightness(0) が含まれていること（純黒）
        expect(filter).toMatch(/brightness\(0\)/);
      }
    });

    test(`${vp.name} (${vp.width}px): ホバー時に SNS アイコンが invert されること`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const menuButton = page.locator('button[aria-label="Open menu"]');
      await menuButton.click();
      await page.waitForTimeout(300);

      const followSection = page.locator('.header-drawer-follow');
      const firstLink = followSection.locator('a').first();

      // ホバー状態にする
      await firstLink.hover();
      await page.waitForTimeout(250);

      const icon = firstLink.locator('.header-drawer-follow-icon');
      const filter = await icon.evaluate((el) => getComputedStyle(el).filter);
      // brightness(0) invert(1) が含まれていること（純白）
      expect(filter).toMatch(/brightness\(0\)/);
      expect(filter).toMatch(/invert\(1\)/);
    });
  }
});
