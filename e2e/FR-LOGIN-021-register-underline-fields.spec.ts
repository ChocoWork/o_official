import { test, expect } from '@playwright/test';

// FREQ-91: 会員登録タブをログインタブと同じ下線＋アイコン＋パスワード表示切替＋配置に統一すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-021 register underline fields (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByRole('tab', { name: '会員登録' }).click();
      await expect(page.getByLabel('Confirm Password')).toBeVisible();
    });

    test('AC-01: Email に mail、Password/確認 に lock アイコンが表示される', async ({ page }) => {
      await expect(page.locator('i.ri-mail-line')).toBeVisible();
      await expect(page.locator('i.ri-lock-line')).toHaveCount(2);
    });

    test('AC-02: 各入力欄は下線のみ（border-bottom のみ）で表示される', async ({ page }) => {
      for (const id of ['#email', '#password', '#confirm-password']) {
        const styles = await page.locator(id).evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            top: s.borderTopStyle,
            right: s.borderRightStyle,
            bottom: s.borderBottomStyle,
            left: s.borderLeftStyle,
          };
        });
        expect(styles.bottom).toBe('solid');
        expect(styles.top).toBe('none');
        expect(styles.right).toBe('none');
        expect(styles.left).toBe('none');
      }
    });

    test('AC-03: Password・確認の表示切替で type が切り替わる', async ({ page }) => {
      const password = page.locator('#password');
      const confirm = page.locator('#confirm-password');
      await expect(password).toHaveAttribute('type', 'password');
      await expect(confirm).toHaveAttribute('type', 'password');

      await page
        .getByRole('button', { name: 'パスワードを表示', exact: true })
        .click();
      await expect(password).toHaveAttribute('type', 'text');
      await expect(confirm).toHaveAttribute('type', 'password');

      await page.getByRole('button', { name: '確認用パスワードを表示' }).click();
      await expect(confirm).toHaveAttribute('type', 'text');
    });

    test('AC-04: 「Googleで登録」が送信ボタンより下に配置される', async ({ page }) => {
      const submit = await page
        .getByRole('button', { name: '登録して確認メールを受け取る' })
        .boundingBox();
      const google = await page
        .getByRole('button', { name: /Google/ })
        .boundingBox();
      expect(submit).not.toBeNull();
      expect(google).not.toBeNull();
      expect(google!.y).toBeGreaterThan(submit!.y);
    });
  });
}
