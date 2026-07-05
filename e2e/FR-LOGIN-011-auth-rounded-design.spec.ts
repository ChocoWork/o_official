import { test, expect } from '@playwright/test';

// FREQ-64: note のログインUIを参考に認証UIを角丸デザインへ刷新すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const radiusOf = async (locator: import('@playwright/test').Locator) => {
  const value = await locator.evaluate(
    (el) => getComputedStyle(el).borderTopLeftRadius,
  );
  return parseFloat(value);
};

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-011 auth rounded design (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('card, email input and login button have rounded corners', async ({ page }) => {
      // FREQ-64-AC-01: カード枠・EMAIL入力欄・ログインボタンの border-radius が 0 より大きい
      const card = page.locator('#auth-panel').locator('xpath=..');
      const emailInput = page.locator('#email');
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });

      expect(await radiusOf(card)).toBeGreaterThan(0);
      expect(await radiusOf(emailInput)).toBeGreaterThan(0);
      expect(await radiusOf(loginButton)).toBeGreaterThan(0);
    });

    test('does not show a "ログインでお困りの方" link', async ({ page }) => {
      // FREQ-64-AC-02: 「ログインでお困りの方」導線が表示されない
      await expect(page.getByText('ログインでお困りの方')).toHaveCount(0);
    });

    test('login button radius is moderate (4-12px), not an oversized pill', async ({ page }) => {
      // FREQ-64-AC-04: 入力欄と調和する中庸な角丸。過度に丸いピル状(>12px)でないこと
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });
      const radius = await radiusOf(loginButton);
      expect(radius).toBeGreaterThanOrEqual(4);
      expect(radius).toBeLessThanOrEqual(12);
    });

    test('auth card border is a grayish (non-pure-black) tone', async ({ page }) => {
      // FREQ-64-AC-03: カード枠の枠線色が純黒でないグレー系
      const card = page.locator('#auth-panel').locator('xpath=..');
      const borderColor = await card.evaluate(
        (el) => getComputedStyle(el).borderTopColor,
      );
      expect(borderColor).not.toBe('rgb(0, 0, 0)');
    });
  });
}
