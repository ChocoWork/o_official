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
      const supportRow = page.locator('[data-auth-support-row]');

      const linkBox = await link.boundingBox();
      const passwordBox = await password.boundingBox();
      const buttonBox = await loginButton.boundingBox();
      const supportRowBox = await supportRow.boundingBox();
      expect(linkBox).not.toBeNull();
      expect(passwordBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();
      expect(supportRowBox).not.toBeNull();

      // FREQ-66-AC-00: リンクは44px補助行の上端に揃える
      expect(Math.abs(linkBox!.y - supportRowBox!.y)).toBeLessThan(1);

      // FREQ-66-AC-01: リンクはログインボタンより上
      expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(buttonBox!.y);

      // FREQ-66-AC-02: パスワード欄との間隔 < ログインボタンとの間隔（近接）
      const gapToPassword = linkBox!.y - (passwordBox!.y + passwordBox!.height);
      const gapToButton = buttonBox!.y - (linkBox!.y + linkBox!.height);
      expect(Math.abs(gapToPassword - 13)).toBeLessThan(1);
      expect(gapToPassword).toBeLessThan(gapToButton);

      // FREQ-66-AC-03: 右寄せ（右端がパスワード欄の右端とほぼ一致）
      const linkRight = linkBox!.x + linkBox!.width;
      const passwordRight = passwordBox!.x + passwordBox!.width;
      expect(Math.abs(linkRight - passwordRight)).toBeLessThanOrEqual(2);
    });

    test('register confirm-password remains vertically centered in the shared support row', async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByRole('tab', { name: '会員登録' }).click();

      const supportRowBox = await page.locator('[data-auth-support-row]').boundingBox();
      const confirmFieldBox = await page
        .locator('[data-auth-support-row] > [data-ui-text-field]')
        .boundingBox();
      expect(supportRowBox).not.toBeNull();
      expect(confirmFieldBox).not.toBeNull();

      const supportCenter = supportRowBox!.y + supportRowBox!.height / 2;
      const fieldCenter = confirmFieldBox!.y + confirmFieldBox!.height / 2;
      expect(Math.abs(supportCenter - fieldCenter)).toBeLessThan(1);
    });
  });
}
