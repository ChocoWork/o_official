import { test, expect } from '@playwright/test';

// FREQ-61: ログインと新規登録を1ページに統合し、タブで切り替えられるようにすること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-009 auth tabs (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('shows login tab selected on /login', async ({ page }) => {
      await page.goto('/login');

      // FREQ-61-AC-01: ログイン・新規登録タブが表示され、ログインタブが選択状態
      const loginTab = page.getByRole('tab', { name: 'ログイン' });
      const registerTab = page.getByRole('tab', { name: '会員登録' });
      await expect(loginTab).toBeVisible();
      await expect(registerTab).toBeVisible();
      await expect(loginTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Email')).toBeVisible();
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Confirm Password')).toHaveCount(0);
    });

    test('switches to register form when register tab is clicked', async ({ page }) => {
      await page.goto('/login');

      // FREQ-63-AC-02: 新規登録タブを押すとPASSWORD（確認）が表示され、URLは /login のまま
      await page.getByRole('tab', { name: '会員登録' }).click();
      await expect(page.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Confirm Password')).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
    });

    test('can switch back to login from register tab', async ({ page }) => {
      await page.goto('/login');

      await page.getByRole('tab', { name: '会員登録' }).click();
      await expect(page.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Confirm Password')).toBeVisible();

      await page.getByRole('tab', { name: 'ログイン' }).click();
      await expect(page.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
    });

    test('タブ内の切替リンクは撤去され、切替はタブのみで行う', async ({ page }) => {
      await page.goto('/login');

      // FREQ-90: タブ内の「会員登録はこちら」「既にアカウントをお持ちの方はこちら」導線は撤去
      await expect(
        page.getByRole('button', { name: '会員登録はこちら' }),
      ).toHaveCount(0);

      await page.getByRole('tab', { name: '会員登録' }).click();
      await expect(
        page.getByRole('button', { name: '既にアカウントをお持ちの方はこちら' }),
      ).toHaveCount(0);
      await expect(page.getByLabel('Confirm Password')).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
    });
  });
}
