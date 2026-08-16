import { expect, test } from '@playwright/test';

async function asideLeft(page: import('@playwright/test').Page): Promise<number> {
  const left = await page.evaluate(() => {
    const aside = document.querySelector('main aside');
    return aside ? aside.getBoundingClientRect().left : null;
  });

  if (typeof left !== 'number') {
    throw new Error('Failed to locate desktop filter aside');
  }

  return left;
}

test.describe('FR-LOOK-ALL-035 desktop filter left edge', () => {
  test('desktop（1280px）でフィルターが画面左端に寄っている', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/look');
    await page.waitForLoadState('networkidle');

    expect(await asideLeft(page)).toBeLessThanOrEqual(40);
  });

  test('wide desktop（1920px）でもフィルターが画面左端に寄っている', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto('/look');
    await page.waitForLoadState('networkidle');

    expect(await asideLeft(page)).toBeLessThanOrEqual(40);
  });

  test('mobile（390px）/ tablet（768px）ではデスクトップフィルターを表示しない', async ({ page }) => {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/look');
      await page.waitForLoadState('networkidle');

      await expect(page.locator('main aside')).toBeHidden();
    }
  });
});
