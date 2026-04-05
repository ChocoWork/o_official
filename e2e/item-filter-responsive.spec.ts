import { test } from '@playwright/test';

const MOBILE_VIEWPORTS = [
  { name: 'mobile-320', width: 320,  height: 812 },
  { name: 'mobile-375', width: 375,  height: 812 },
  { name: 'mobile-425', width: 425,  height: 812 },
];

const ALL_VIEWPORTS = [
  { name: 'mobile-320',  width: 320,  height: 812 },
  { name: 'mobile-375',  width: 375,  height: 812 },
  { name: 'mobile-425',  width: 425,  height: 812 },
  { name: 'tablet-768',  width: 768,  height: 1024 },
  { name: 'pc-1024',     width: 1024, height: 768 },
  { name: 'pc-1440',     width: 1440, height: 900 },
];

const SCREENSHOT_DIR = 'c:\\work\\o_official\\screenshots';

test.describe('ITEM page filter – all viewports (after fix)', () => {
  // Default state: capture filter area for all viewports
  for (const vp of ALL_VIEWPORTS) {
    test(`item filter default – ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${SCREENSHOT_DIR}\\after-${vp.name}-default.png`, fullPage: false });
    });
  }

  // Mobile: open dropdown state
  for (const vp of MOBILE_VIEWPORTS) {
    test(`item filter dropdown open – ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      const dropdownTrigger = page.locator('button[aria-haspopup="listbox"]').first();
      await dropdownTrigger.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SCREENSHOT_DIR}\\after-${vp.name}-open.png`, fullPage: false });

      // Select TOPS, BOTTOMS, OUTERWEAR
      await page.locator('label').filter({ hasText: /^TOPS$/ }).click();
      await page.waitForTimeout(200);
      await page.locator('label').filter({ hasText: /^BOTTOMS$/ }).click();
      await page.waitForTimeout(200);
      await page.locator('label').filter({ hasText: /^OUTERWEAR$/ }).click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${SCREENSHOT_DIR}\\after-${vp.name}-open-multiselected.png`, fullPage: false });

      await dropdownTrigger.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SCREENSHOT_DIR}\\after-${vp.name}-multiselected.png`, fullPage: false });
    });
  }
});
