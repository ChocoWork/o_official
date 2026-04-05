import { test } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const VIEWPORTS = [
  { name: 'mobile-320',   width: 320,  height: 900 },
  { name: 'mobile-375',   width: 375,  height: 900 },
  { name: 'mobile-425',   width: 425,  height: 900 },
  { name: 'tablet-768',   width: 768,  height: 1024 },
  { name: 'desktop-1024', width: 1024, height: 900 },
  { name: 'desktop-1440', width: 1440, height: 900 },
];

// Use a known item ID with multiple images/colors/sizes
const ITEM_ID = '10';

const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots', 'item');

test.describe('Item detail page – responsive layout', () => {
  for (const vp of VIEWPORTS) {
    test(`item detail renders on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/item/${ITEM_ID}`, { waitUntil: 'networkidle' });
      // Wait for client-side data fetch: loading text disappears
      await page.waitForFunction(
        () => !document.body.innerText.includes('読み込み中'),
        { timeout: 15000 }
      );
      await page.waitForTimeout(300);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `item-detail-${vp.name}.png`),
        fullPage: true,
      });
    });
  }
});
