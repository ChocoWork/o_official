import { test, expect, type Locator } from '@playwright/test';

// /login のフォーム・配置まわりの AC を 1 AC = 1 テストに分けて確かめる。
// FR-LOGIN-008 / 012 / 013 / 015 / 016 は 1 テストに複数の AC を詰めていて、
// テスト名に付けられる ID が 1 つだけのため、ここに AC ごとに写して置く。
// ログイン操作とモックは使わない（/login の表示と配置だけを見る）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const metrics = async (locator: Locator) => {
  const fontSize = await locator.evaluate((el) => getComputedStyle(el).fontSize);
  const box = await locator.boundingBox();
  return { fontSize, height: Math.round(box?.height ?? 0) };
};

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-029 login form layout split ACs (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('FREQ-58-AC-01 login page shows the EMAIL and PASSWORD fields', async ({ page }) => {
      await expect(page.getByLabel('EMAIL')).toBeVisible();
      await expect(page.getByLabel('PASSWORD')).toBeVisible();
    });

    test('FREQ-65-AC-03 login button becomes enabled once EMAIL and PASSWORD are entered', async ({
      page,
    }) => {
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });
      await page.locator('#email').fill('test@example.com');
      await page.locator('#password').fill('Password123456789!');
      await expect(loginButton).toBeEnabled();
    });

    test('FREQ-66-AC-01 password reset link is shown above the login button', async ({ page }) => {
      const link = page.getByRole('link', { name: 'パスワードをお忘れの方はこちら' });
      const loginButton = page.getByRole('button', { name: 'ログイン', exact: true });
      await expect(link).toBeVisible();

      const linkBox = await link.boundingBox();
      const buttonBox = await loginButton.boundingBox();
      expect(linkBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();

      expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(buttonBox!.y);
    });

    test('FREQ-66-AC-03 password reset link is right-aligned with the password field right edge', async ({
      page,
    }) => {
      const link = page.getByRole('link', { name: 'パスワードをお忘れの方はこちら' });
      const password = page.locator('#password');

      const linkBox = await link.boundingBox();
      const passwordBox = await password.boundingBox();
      expect(linkBox).not.toBeNull();
      expect(passwordBox).not.toBeNull();

      const linkRight = linkBox!.x + linkBox!.width;
      const passwordRight = passwordBox!.x + passwordBox!.width;
      expect(Math.abs(linkRight - passwordRight)).toBeLessThanOrEqual(2);
    });

    test('FREQ-68-AC-02 Google buttons and primary CTAs match in height and font size across the login and register tabs', async ({
      page,
    }) => {
      const loginGoogle = await metrics(page.getByRole('button', { name: /Google/ }));
      const loginPrimary = await metrics(
        page.getByRole('button', { name: 'ログイン', exact: true }),
      );

      await page.getByRole('tab', { name: '会員登録' }).click();
      const regPrimaryButton = page.getByRole('button', { name: '登録して確認メールを受け取る' });
      await expect(regPrimaryButton).toBeVisible();
      const regGoogle = await metrics(page.getByRole('button', { name: /Google/ }));
      const regPrimary = await metrics(regPrimaryButton);

      // Google ボタン同士
      expect(loginGoogle.fontSize).toBe(regGoogle.fontSize);
      expect(Math.abs(loginGoogle.height - regGoogle.height)).toBeLessThanOrEqual(1);
      // 主要 CTA 同士
      expect(loginPrimary.fontSize).toBe(regPrimary.fontSize);
      expect(Math.abs(loginPrimary.height - regPrimary.height)).toBeLessThanOrEqual(1);
    });

    test('FREQ-69-AC-01 footer top is at or below the viewport bottom on the initial view', async ({
      page,
    }) => {
      const footer = await page.locator('footer').boundingBox();
      expect(footer).not.toBeNull();

      expect(footer!.y).toBeGreaterThanOrEqual(viewport.height - 1);
    });

    test('FREQ-69-AC-02 main bottom reaches the viewport bottom', async ({ page }) => {
      const main = await page.locator('#main-content').boundingBox();
      expect(main).not.toBeNull();

      expect(main!.y + main!.height).toBeGreaterThanOrEqual(viewport.height - 1);
    });
  });
}
