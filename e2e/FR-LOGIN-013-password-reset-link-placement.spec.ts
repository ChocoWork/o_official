import { test, expect } from '@playwright/test';

// FREQ-66: 「パスワードをお忘れの方はこちら」を近接の原則に従いパスワード欄直下（ログインボタンの上）に右寄せ配置すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-013 password reset link placement (${viewport.name})`, () => {
    test('link sits below the password field, above the login button, right-aligned and closer to the password field', async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');

      const link = page.getByRole('link', { name: 'パスワードをお忘れの方はこちら' });
      const password = page.locator('#password');
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });

      const linkBox = await link.boundingBox();
      const passwordBox = await password.boundingBox();
      const buttonBox = await loginButton.boundingBox();
      expect(linkBox).not.toBeNull();
      expect(passwordBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();

      // FREQ-66-AC-01: リンクはログインボタンより上
      expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(buttonBox!.y);

      // FREQ-66-AC-02: パスワード欄との間隔 < ログインボタンとの間隔（近接）
      const gapToPassword = linkBox!.y - (passwordBox!.y + passwordBox!.height);
      const gapToButton = buttonBox!.y - (linkBox!.y + linkBox!.height);
      expect(gapToPassword).toBeLessThan(gapToButton);

      // FREQ-66-AC-03: 右寄せ（右端がパスワード欄の右端とほぼ一致）
      const linkRight = linkBox!.x + linkBox!.width;
      const passwordRight = passwordBox!.x + passwordBox!.width;
      expect(Math.abs(linkRight - passwordRight)).toBeLessThanOrEqual(2);
    });
  });
}
