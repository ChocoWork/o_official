import { test, expect } from '@playwright/test';

// FREQ-89: ログインの Email/Password 入力欄を下線＋アイコン＋パスワード表示切替（黄金比）に刷新すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const fontPx = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-019 underline input fields (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('AC-01: Email に mail アイコン / Password に lock アイコンが表示される', async ({ page }) => {
      await expect(page.locator('i.ri-mail-line')).toBeVisible();
      await expect(page.locator('i.ri-lock-line')).toBeVisible();
    });

    test('AC-02: 入力欄は下線のみ（border-bottom のみ）で表示される', async ({ page }) => {
      const email = page.getByLabel('Email');
      const styles = await email.evaluate((el) => {
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
    });

    test('AC-03: Password 表示切替ボタンで type が password↔text に切り替わる', async ({ page }) => {
      const password = page.getByLabel('Password', { exact: true });
      await expect(password).toHaveAttribute('type', 'password');

      const showToggle = page.getByRole('button', { name: 'パスワードを表示' });
      await expect(showToggle).toBeVisible();
      await showToggle.click();

      await expect(password).toHaveAttribute('type', 'text');
      await expect(
        page.getByRole('button', { name: 'パスワードを非表示' }),
      ).toBeVisible();
    });

    test('AC-04: 先頭アイコンが入力本文より大きい（黄金比 √φ 倍相当）', async ({ page }) => {
      const iconSize = await fontPx(page.locator('i.ri-mail-line'));
      const inputSize = await fontPx(page.getByLabel('Email'));
      expect(iconSize).toBeGreaterThan(inputSize);
    });

    test('AC-05: 左アイコンの左・右トグルの右に黄金比 x/y（font/φ）の余白がある', async ({ page }) => {
      const spacing = await page.evaluate(() => {
        const email = document.querySelector('#email') as HTMLElement;
        const emailIcon = document.querySelector('.ri-mail-line') as HTMLElement;
        const pwd = document.querySelector('#password') as HTMLElement;
        const toggle = document.querySelector('.text-field__toggle') as HTMLElement;
        const emailControl = email.closest('.text-field__control') as HTMLElement;
        const pwdControl = pwd.closest('.text-field__control') as HTMLElement;

        const x = parseFloat(getComputedStyle(email).fontSize);
        const leftSpace =
          emailIcon.getBoundingClientRect().left -
          emailControl.getBoundingClientRect().left;
        const rightSpace =
          pwdControl.getBoundingClientRect().right -
          toggle.getBoundingClientRect().right;
        return { expected: x / 1.618, leftSpace, rightSpace };
      });

      // x/y = font/φ に対して ±1.5px の許容
      expect(Math.abs(spacing.leftSpace - spacing.expected)).toBeLessThan(1.5);
      expect(Math.abs(spacing.rightSpace - spacing.expected)).toBeLessThan(1.5);
    });
  });
}
