import { test, expect } from '@playwright/test';

// FREQ-65: 非選択タブをグレー化し、送信ボタンは必須項目未入力の間は無効（グレー）、入力後は有効（黒）にすること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-012 auth tab and button states (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('unselected tab uses a grayish (non-pure-black) background', async ({ page }) => {
      // FREQ-65-AC-01: 非選択タブの背景色が純黒でないグレー系
      const registerTab = page.getByRole('tab', { name: '会員登録' });
      const bg = await registerTab.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(bg).not.toBe('rgb(0, 0, 0)');
      expect(bg).not.toBe('rgb(17, 17, 17)');
    });

    test('tabs use an underline (bottom border only), no box borders', async ({ page }) => {
      // FREQ-90: タブは下線（border-bottom）のみで区別し、四方を囲む枠線は持たない
      // （FREQ-65-AC-05 の「塗りのみ・border なし」は下線デザインへ置き換え）
      const tabs = page.getByRole('tab');
      const count = await tabs.count();
      for (let i = 0; i < count; i += 1) {
        const widths = await tabs.nth(i).evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            top: parseFloat(cs.borderTopWidth),
            right: parseFloat(cs.borderRightWidth),
            bottom: parseFloat(cs.borderBottomWidth),
            left: parseFloat(cs.borderLeftWidth),
          };
        });
        expect(widths.bottom).toBeGreaterThan(0);
        expect(widths.top).toBe(0);
        expect(widths.right).toBe(0);
        expect(widths.left).toBe(0);
      }
    });

    test('login button is disabled until email and password are filled', async ({ page }) => {
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });

      // FREQ-65-AC-02: 未入力時は無効
      await expect(loginButton).toBeDisabled();

      // FREQ-65-AC-03: EMAIL・PASSWORD 入力で有効
      await page.locator('#email').fill('test@example.com');
      await page.locator('#password').fill('password123');
      await expect(loginButton).toBeEnabled();
    });

    test('register button is disabled until all fields are filled', async ({ page }) => {
      await page.getByRole('tab', { name: '会員登録' }).click();

      const registerButton = page.getByRole('button', {
        name: '登録して確認メールを受け取る',
      });

      // FREQ-65-AC-04: 全項目未入力時は無効
      await expect(registerButton).toBeDisabled();

      await page.locator('#email').fill('test@example.com');
      await page.locator('#password').fill('password123');
      await page.locator('#confirm-password').fill('password123');
      await expect(registerButton).toBeEnabled();
    });
  });
}
