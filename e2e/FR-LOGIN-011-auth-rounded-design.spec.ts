import { test, expect } from '@playwright/test';

// FREQ-89/90: 認証UIを角丸カードから下線ベースのミニマルデザインへ刷新
// （FREQ-64「角丸デザイン」の受け付け基準を置換：カード枠を撤去・入力欄は下線・ボタンは直角）
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
  test.describe(`FR-LOGIN-011 auth minimal design (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('email input and login button are not rounded (minimal design)', async ({ page }) => {
      // FREQ-89: 入力欄は下線のみ（角丸なし）/ FREQ-90: ボタンは直角（square）
      const emailInput = page.locator('#email');
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });

      expect(await radiusOf(emailInput)).toBe(0);
      expect(await radiusOf(loginButton)).toBe(0);
    });

    test('does not show a "ログインでお困りの方" link', async ({ page }) => {
      await expect(page.getByText('ログインでお困りの方')).toHaveCount(0);
    });

    test('the tab group has no surrounding card frame', async ({ page }) => {
      // FREQ-90: タブ群を囲む角丸カード枠（border/radius）を撤去
      const card = page.locator('#auth-panel').locator('xpath=..');
      const frame = await card.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          borderWidth: parseFloat(s.borderTopWidth),
          radius: parseFloat(s.borderTopLeftRadius),
        };
      });
      expect(frame.borderWidth).toBe(0);
      expect(frame.radius).toBe(0);
    });
  });
}
