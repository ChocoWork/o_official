import { test } from '@playwright/test';
import fs from 'fs';

const VIEWPORTS = [
  { name: '320', width: 320, height: 568 },
  { name: '375', width: 375, height: 812 },
  { name: '425', width: 425, height: 896 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
];

const PAGES = [
  { path: '/news', name: 'news' },
  { path: '/item', name: 'item' },
  { path: '/look', name: 'look' },
  { path: '/stockist', name: 'stockist' },
  { path: '/about', name: 'about' },
  { path: '/contact', name: 'contact' },
  { path: '/login', name: 'login' },
  { path: '/terms', name: 'terms' },
  { path: '/privacy', name: 'privacy' },
];

// スクリーンショット保存先: playwright-report/spacing-before/ または spacing-after/
const DIR = process.env.SPACING_DIR ?? 'playwright-report/spacing';

test.describe('Page spacing review (above-the-fold)', () => {
  test.beforeAll(() => {
    fs.mkdirSync(DIR, { recursive: true });
  });

  for (const vp of VIEWPORTS) {
    for (const pg of PAGES) {
      test(`${pg.name} – ${vp.name}px`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(pg.path);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(800);

        await page.screenshot({
          path: `${DIR}/${pg.name}-${vp.name}.png`,
          fullPage: false,
          clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 600) },
        });
      });
    }
  }
});
