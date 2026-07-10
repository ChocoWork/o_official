import { test, expect, Page } from '@playwright/test';

// FREQ-75: LOADINGデザインギャラリーページ（/loading）を管理者にのみ表示すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

async function mockAuthMe(page: Page, options: { authenticated: boolean; role?: string }): Promise<void> {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        options.authenticated
          ? {
              authenticated: true,
              user: {
                id: 'test-user-id',
                email: 'admin@example.com',
                role: options.role,
                mfaVerified: true,
              },
            }
          : { authenticated: false },
      ),
    });
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOADING-001 admin only gallery (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('admin sees the Loading gallery with all sections', async ({ page }) => {
      // FREQ-75-AC-01
      await mockAuthMe(page, { authenticated: true, role: 'admin' });
      await page.goto('/loading');

      await expect(page.getByRole('heading', { name: 'Loading', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Standard' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Full Screen' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Animation Components' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Brand Name' })).toBeVisible();
    });

    test('anonymous user sees access denied and no gallery', async ({ page }) => {
      // FREQ-75-AC-02
      await mockAuthMe(page, { authenticated: false });
      await page.goto('/loading');

      await expect(page.getByText('アクセス権限がありません')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Loading', exact: true })).toHaveCount(0);
    });

    test('non-admin roles see access denied', async ({ page }) => {
      // FREQ-75-AC-03
      for (const role of ['user', 'supporter']) {
        await mockAuthMe(page, { authenticated: true, role });
        await page.goto('/loading');
        await expect(page.getByText('アクセス権限がありません')).toBeVisible();
      }
    });

    test('SHOW .TSX CODE toggles the code block', async ({ page }) => {
      // FREQ-75-AC-04
      await mockAuthMe(page, { authenticated: true, role: 'admin' });
      await page.goto('/loading');

      const toggle = page.getByRole('button', { name: 'SHOW .TSX CODE' }).first();
      await expect(toggle).toBeVisible();
      await toggle.click();

      const codeBlock = page.locator('pre').first();
      await expect(codeBlock).toBeVisible();

      await page.getByRole('button', { name: 'HIDE CODE' }).first().click();
      await expect(codeBlock).toHaveCount(0);
    });
  });
}
