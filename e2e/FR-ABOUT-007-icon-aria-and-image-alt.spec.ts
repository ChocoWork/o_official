import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-007 aria-hidden と alt改善', () => {
  test('FR-ABOUT-007-AC-01 装飾アイコンの全部に aria-hidden=true がある', async ({ page }) => {
    await page.goto('/about');

    // 装飾アイコン（Remix Icon の i 要素・role=img でない svg）。画像の alt は FR-ABOUT-007-AC-02（009）が持つ。
    // アイコンが 0 個の今は、全部に付いているという条件を空で満たす。
    const icons = page.locator('main i[class^="ri-"], main i[class*=" ri-"], main svg:not([role="img"])');
    const count = await icons.count();

    for (let i = 0; i < count; i += 1) {
      await expect(icons.nth(i)).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
