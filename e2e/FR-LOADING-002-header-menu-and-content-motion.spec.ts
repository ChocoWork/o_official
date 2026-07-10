import { test, expect, Page } from '@playwright/test';

// FREQ-76: ヘッダーLOADINGメニュー（admin専用）・Animation ComponentsのREPLAY・Content Motionセクション
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const CONTENT_MOTION_PATTERNS = [
  'THREAD DRAW',
  'IMAGE WIPE',
  'SLOW ZOOM',
  'UNDERLINE TRACK',
  'FILL SWEEP',
  'SKELETON',
  'MARQUEE',
  'MASK LINES',
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

// desktop はナビ（lg 以上で表示）、mobile/tablet はドロワー内のリンクを対象とする
async function loadingLink(page: Page, viewportName: string) {
  if (viewportName === 'desktop') {
    return page.locator('header nav').getByRole('link', { name: 'LOADING' });
  }

  await page.getByRole('button', { name: 'Open menu' }).click();
  return page.getByRole('dialog').getByRole('link', { name: 'LOADING' });
}

for (const viewport of viewports) {
  test.describe(`FR-LOADING-002 header menu and content motion (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('admin sees LOADING menu and it navigates to /loading', async ({ page }) => {
      // FREQ-76-AC-01
      await mockAuthMe(page, { authenticated: true, role: 'admin' });
      await page.goto('/');

      const link = await loadingLink(page, viewport.name);
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', '/loading');
      await link.click();
      await expect(page).toHaveURL(/\/loading$/);
      await expect(page.getByRole('heading', { name: 'Loading', exact: true })).toBeVisible();
    });

    test('anonymous and non-admin users do not see LOADING menu', async ({ page }) => {
      // FREQ-76-AC-02
      for (const auth of [
        { authenticated: false as const },
        { authenticated: true as const, role: 'user' },
        { authenticated: true as const, role: 'supporter' },
      ]) {
        await page.unrouteAll();
        await mockAuthMe(page, auth);
        await page.goto('/');

        if (viewport.name === 'desktop') {
          await expect(page.locator('header nav').getByRole('link', { name: 'NEWS' })).toBeVisible();
          await expect(page.locator('header nav').getByRole('link', { name: 'LOADING' })).toHaveCount(0);
        } else {
          await page.getByRole('button', { name: 'Open menu' }).click();
          const drawer = page.getByRole('dialog');
          await expect(drawer.getByRole('link', { name: 'ABOUT' })).toBeVisible();
          await expect(drawer.getByRole('link', { name: 'LOADING' })).toHaveCount(0);
          await page.getByRole('button', { name: 'Close drawer' }).click();
        }
      }
    });

    test('REPLAY re-runs an Animation Components demo', async ({ page }) => {
      // FREQ-76-AC-03
      await mockAuthMe(page, { authenticated: true, role: 'admin' });
      await page.goto('/loading');
      await expect(page.getByRole('heading', { name: 'Loading', exact: true })).toBeVisible();

      // AnimatedCounter のデモをビューポートに入れ、初回カウントアップ完了を待つ
      const counterDemo = page.getByText('AnimatedCounter').first();
      await counterDemo.scrollIntoViewIfNeeded();
      const counterValue = page.locator('#main-content span', { hasText: /^\d+$/ }).last();
      await expect(counterValue).toHaveText('2026', { timeout: 10_000 });

      // REPLAY でカウントが再実行される（一旦 2026 未満へ戻り、再度 2026 に到達）
      await page.getByRole('button', { name: 'AnimatedCounter のアニメーションを再生' }).click();
      await expect
        .poll(async () => (await counterValue.textContent())?.trim(), { timeout: 3_000 })
        .not.toBe('2026');
      await expect(counterValue).toHaveText('2026', { timeout: 10_000 });
    });

    test('Content Motion section shows all 8 patterns', async ({ page }) => {
      // FREQ-76-AC-04
      await mockAuthMe(page, { authenticated: true, role: 'admin' });
      await page.goto('/loading');

      await expect(page.getByRole('heading', { name: 'Content Motion' })).toBeVisible();
      for (const pattern of CONTENT_MOTION_PATTERNS) {
        await expect(page.getByText(pattern, { exact: true })).toBeVisible();
      }
    });
  });
}
