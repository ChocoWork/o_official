import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-008 画像ソースのローカル/CDN管理化', () => {
  test('aboutページ画像に readdy.ai が使われていない', async ({ page }) => {
    await page.goto('/about');

    const images = page.locator('img');
    const count = await images.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const src = (await images.nth(i).getAttribute('src')) ?? '';
      expect(src.includes('readdy.ai')).toBeFalsy();
    }
  });
});
