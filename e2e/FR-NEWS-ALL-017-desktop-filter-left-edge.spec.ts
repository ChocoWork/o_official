import { expect, test } from '@playwright/test';

// FREQ-274: NEWS / ITEM / LOOK の左フィルター（aside）がデスクトップで画面左端に寄る。
const FILTER_PAGES = ['/news', '/item', '/look'] as const;

async function asideLeft(page: import('@playwright/test').Page): Promise<number> {
  const left = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    return aside ? aside.getBoundingClientRect().left : null;
  });

  if (typeof left !== 'number') {
    throw new Error('Failed to locate desktop filter aside');
  }

  return left;
}

test.describe('FR-NEWS-ALL-017 desktop filter left edge', () => {
  test('FREQ-274-AC-02 desktop（1280px）でフィルターが画面左端に寄っている', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    for (const path of FILTER_PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('aside').first(), `${path} aside`).toBeVisible();

      expect(await asideLeft(page), `${path} aside left`).toBeLessThanOrEqual(40);
    }
  });

  test('FREQ-274-AC-01 wide desktop（1920px）でもフィルターが画面左端に寄っている', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });

    for (const path of FILTER_PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('aside').first(), `${path} aside`).toBeVisible();

      expect(await asideLeft(page), `${path} aside left`).toBeLessThanOrEqual(40);
    }
  });

  test('mobile（390px）/ tablet（768px）ではデスクトップフィルターを表示しない', async ({ page }) => {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      await expect(page.locator('main aside')).toBeHidden();
    }
  });
});
