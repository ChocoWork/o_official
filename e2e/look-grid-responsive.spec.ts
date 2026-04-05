import { test } from '@playwright/test';
import path from 'path';

const VIEWPORTS = [
  { name: 'mobile-320',  width: 320,  height: 900 },
  { name: 'mobile-375',  width: 375,  height: 900 },
  { name: 'mobile-425',  width: 425,  height: 900 },
  { name: 'tablet-768',  width: 768,  height: 1024 },
  { name: 'desktop-1024', width: 1024, height: 900 },
  { name: 'desktop-1440', width: 1440, height: 900 },
];

const SCREENSHOT_DIR = 'c:\\work\\o_official\\screenshots\\look';

test.describe('LOOK grid responsive layout', () => {
  for (const vp of VIEWPORTS) {
    test(`catalog /look - ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `look-catalog-${vp.name}.png`),
        fullPage: true,
      });
    });

    test(`home /  (LOOK section) - ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const lookSection = page.locator('#look');
      await lookSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `look-home-${vp.name}.png`),
        fullPage: true,
      });
    });
  }
});
