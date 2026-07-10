import { test, expect } from '@playwright/test';

// FREQ-67: 対比の原則に従い、フォントサイズとコンポーネントサイズで優先度を明快に示すこと
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const fontPx = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
const heightPx = async (locator: import('@playwright/test').Locator) => {
  const box = await locator.boundingBox();
  return box?.height ?? 0;
};

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-014 auth contrast hierarchy (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('primary login button has the largest font among controls', async ({ page }) => {
      // FREQ-67-AC-01: ログインボタン font > EMAIL 入力欄 font
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });
      const emailInput = page.locator('#email');
      expect(await fontPx(loginButton)).toBeGreaterThan(await fontPx(emailInput));
    });

    test('forgot-password link is smaller than body text', async ({ page }) => {
      // FREQ-67-AC-02: 「パスワードをお忘れの方はこちら」font < 本文（タブ見出し）font
      // （FREQ-90 でタブ内「会員登録はこちら」導線は撤去。同じ本文 md スケールのタブ見出しを基準にする）
      const forgot = page.getByRole('link', { name: 'パスワードをお忘れの方はこちら' });
      const body = page.getByRole('tab', { name: 'ログイン' });
      expect(await fontPx(forgot)).toBeLessThan(await fontPx(body));
    });

    test('primary login button is the tallest control', async ({ page }) => {
      // FREQ-67-AC-03: ログインボタン高さ >= EMAIL 入力欄・Google ボタン
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });
      const emailInput = page.locator('#email');
      const googleButton = page.getByRole('button', { name: /Google/ });
      const loginH = await heightPx(loginButton);
      expect(loginH).toBeGreaterThanOrEqual(await heightPx(emailInput));
      expect(loginH).toBeGreaterThanOrEqual(await heightPx(googleButton));
    });
  });
}
