import { test, expect, Page } from '@playwright/test';

// FREQ-316: 管理 API の 401 に対する自動セッション更新が、レート制限を自分で焼き切らないこと。
// 修正前は 401 のたびに /api/auth/refresh を発行し、429 を受けてもそのまま叩き続けていた。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

async function mockAuthenticatedAdmin(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'admin-1', email: 'admin@example.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
}

// 管理 API がすべて 401 を返す＝アクセストークンが失効した状態を再現する。
async function mockAdminApisUnauthorized(page: Page): Promise<void> {
  await page.route('**/api/admin/**', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unauthorized' }),
    }),
  );
}

function countRefreshRequests(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/refresh')) {
      count += 1;
    }
  });
  return () => count;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-057 セッション更新の抑制 (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('refresh が 429 を返したら再発行しない', async ({ page }) => {
      const getRefreshCount = countRefreshRequests(page);

      await mockAuthenticatedAdmin(page);
      await mockAdminApisUnauthorized(page);
      await page.route('**/api/auth/refresh', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Retry-After': '30' },
          body: JSON.stringify({ error: 'Too many requests' }),
        }),
      );

      await page.goto('/admin');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);

      // 複数の管理 API が 401 になっても、更新要求はちょうど 1 回に抑えられる
      // （0 回だと経路自体が動いていないことになるので厳密一致で見る）
      expect(getRefreshCount()).toBe(1);
    });

    test('refresh が 401 を返したら未認証表示に落ちる', async ({ page }) => {
      const getRefreshCount = countRefreshRequests(page);

      await mockAuthenticatedAdmin(page);
      await mockAdminApisUnauthorized(page);
      await page.route('**/api/auth/refresh', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'No refresh token' }),
        }),
      );

      await page.goto('/admin');

      await expect(page.getByRole('heading', { name: 'アクセス権限がありません' })).toBeVisible({
        timeout: 15000,
      });
      expect(getRefreshCount()).toBe(1);
    });
  });
}
