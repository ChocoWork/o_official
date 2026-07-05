import { test, expect } from '@playwright/test';

// FREQ-71: /login のログインフォームを iPhone SE（375×667）で 1 画面に収めること。tablet/PC は現状維持。

test.describe('FR-LOGIN-017 iPhone SE one screen', () => {
  test('login form fits within the iPhone SE viewport without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/login');

    const card = await page.locator('#auth-panel').locator('xpath=..').boundingBox();
    const footer = await page.locator('footer').boundingBox();
    expect(card).not.toBeNull();
    expect(footer).not.toBeNull();

    // FREQ-71-AC-01: カード下端がビューポート内、Footer が見えない
    expect(card!.y + card!.height).toBeLessThanOrEqual(667);
    expect(footer!.y).toBeGreaterThanOrEqual(667 - 1);
  });

  test('register form also fits within the iPhone SE viewport without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/login');
    await page.getByRole('tab', { name: '会員登録' }).click();
    await expect(page.getByLabel('PASSWORD（確認）')).toBeVisible();

    const card = await page.locator('#auth-panel').locator('xpath=..').boundingBox();
    const footer = await page.locator('footer').boundingBox();

    // FREQ-71-AC-03: 会員登録タブも 375×667 で 1 画面に収まり、Footer が見えないこと
    expect(card!.y + card!.height).toBeLessThanOrEqual(667);
    expect(footer!.y).toBeGreaterThanOrEqual(667 - 1);
  });

  test('desktop keeps the original (non-reduced) vertical spacing', async ({ page }) => {
    // FREQ-71-AC-02: desktop ではモバイル用の縮小が適用されない（sm: 以上は従来値）
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/login');

    // Google ボタンの下マージンが sm:mb-8（32px）であること（mb-6=24px でないこと）
    const googleMb = await page
      .getByRole('button', { name: /Google/ })
      .evaluate((el) => getComputedStyle(el).marginBottom);
    expect(googleMb).toBe('32px');
  });
});
