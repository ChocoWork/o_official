import { test, expect, Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createTestMember, loginAsMember } from './member-session-helpers';

/**
 * FR-LOGIN-033 ログインの確認の認証要素の選択・管理の更新の抑制・一般の会員のヘッダー（page.route のモック）
 * FREQ-515-AC-02: 認証要素が2つ以上ある時、2つ目を選んでコードを送ると、2つ目の認証要素で検証される
 * FREQ-316-AC-01: 管理APIが401・/api/auth/refresh が429でも、更新の発行が1回以下
 * FREQ-316-AC-02: /api/auth/refresh が401のとき「アクセス権限がありません」が出て、更新の発行が1回以下
 * SEC-AUTH-028-AC-01: 一般の会員のヘッダーとドロワーに MANAGE・LOADING が出ない
 */

// SEC-AUTH-028-AC-01 は本物の会員のログインを使う。確認コードと Cookie が通信記録に残らないよう trace を切る。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const FIRST_FACTOR_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_FACTOR_ID = '22222222-2222-4222-8222-222222222222';
const OTP_CODE = '123456';

async function mockAuthenticatedAdmin(page: Page, mfaVerified: boolean): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'admin-1', email: 'admin@example.com', role: 'admin', mfaVerified },
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
  test.describe(`FR-LOGIN-033 ログインの確認・更新の抑制・ヘッダー (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`FREQ-515-AC-02 ${viewport.name} (${viewport.width}px): 認証要素が2つあるとき2つ目を選んでコードを送ると2つ目の認証要素で検証される`, async ({ page }) => {
      await mockAuthenticatedAdmin(page, false);
      await page.route('**/api/auth/mfa/status', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              role: 'admin',
              currentLevel: 'aal1',
              nextLevel: 'aal2',
              hasVerifiedFactor: true,
              needsChallenge: true,
              factors: [
                { id: FIRST_FACTOR_ID, factorType: 'totp', friendlyName: '認証アプリ1' },
                { id: SECOND_FACTOR_ID, factorType: 'totp', friendlyName: '認証アプリ2' },
              ],
            },
          }),
        }),
      );
      await page.route('**/api/auth/mfa/verify', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { verified: true } }),
        }),
      );

      await page.goto('/auth/verified');

      // 認証要素が2つ以上ある時だけ選択欄が出る。最初は1つ目が選ばれている
      const factorSelect = page.getByLabel('認証要素');
      await expect(factorSelect).toBeVisible();
      await expect(factorSelect).toHaveValue(FIRST_FACTOR_ID);

      // 2つ目を選んでコードを送る
      await factorSelect.selectOption(SECOND_FACTOR_ID);
      await expect(factorSelect).toHaveValue(SECOND_FACTOR_ID);
      await page.getByLabel('認証コード（6〜8桁）').fill(OTP_CODE);

      const verifyRequestPromise = page.waitForRequest(
        (request) => request.url().includes('/api/auth/mfa/verify') && request.method() === 'POST',
      );
      await page.getByRole('button', { name: '2要素認証を完了' }).click();
      const verifyRequest = await verifyRequestPromise;

      // 送られた認証要素は2つ目（1つ目ではない）
      const body = JSON.parse(verifyRequest.postData() ?? '{}') as { factorId?: string; code?: string };
      expect(body.factorId).toBe(SECOND_FACTOR_ID);
      expect(body.factorId).not.toBe(FIRST_FACTOR_ID);
      expect(body.code).toBe(OTP_CODE);
    });

    test(`FREQ-316-AC-01 ${viewport.name} (${viewport.width}px): 管理APIが401・更新が429でも /api/auth/refresh の発行が1回以下`, async ({ page }) => {
      const getRefreshCount = countRefreshRequests(page);

      await mockAuthenticatedAdmin(page, true);
      await mockAdminApisUnauthorized(page);
      await page.route('**/api/auth/refresh', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Retry-After': '30' },
          body: JSON.stringify({ error: 'Too many requests' }),
        }),
      );

      // 管理APIが401を返し、更新が429を返した状況を作れたことを確かめてから数える
      const adminUnauthorized = page.waitForResponse(
        (response) => response.url().includes('/api/admin/') && response.status() === 401,
      );
      const refreshRateLimited = page.waitForResponse(
        (response) => response.url().includes('/api/auth/refresh') && response.status() === 429,
      );

      await page.goto('/admin');
      await adminUnauthorized;
      await refreshRateLimited;
      await page.waitForLoadState('networkidle');

      expect(getRefreshCount()).toBeLessThanOrEqual(1);
    });

    test(`FREQ-316-AC-02 ${viewport.name} (${viewport.width}px): 更新が401のとき「アクセス権限がありません」が表示され /api/auth/refresh の発行が1回以下`, async ({ page }) => {
      const getRefreshCount = countRefreshRequests(page);

      await mockAuthenticatedAdmin(page, true);
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
      await page.waitForLoadState('networkidle');

      expect(getRefreshCount()).toBeLessThanOrEqual(1);
    });

    test(`SEC-AUTH-028-AC-01 ${viewport.name} (${viewport.width}px): 一般の会員のヘッダーとドロワーに MANAGE・LOADING が表示されない`, async ({ page }) => {
      // 本物の会員でログインする（役割は app_metadata から読まれ、一般の会員は user）。回数の制限は試験ごとの送り元で分ける
      const member = await createTestMember('header-role');
      const [a, b, c] = randomBytes(3);
      await loginAsMember(page, member, `10.${a}.${b}.${c}`);
      expect(((await (await page.request.get('/api/auth/me')).json()) as { user?: { role?: string } }).user?.role).toBe('user');

      await page.goto('/');

      // 会員としてログインした表示になっている（アカウントへのリンク）
      await expect(page.getByRole('link', { name: 'アカウント', exact: true })).toBeVisible();

      if (viewport.width >= 1280) {
        // desktop: ヘッダーのナビゲーションが出ていて、MANAGE・LOADING だけが無い
        const headerNav = page.locator('header .header-nav-position');
        await expect(headerNav).toBeVisible();
        await expect(headerNav.getByText('ITEM', { exact: true })).toBeVisible();
        await expect(headerNav.getByText('MANAGE', { exact: true })).toHaveCount(0);
        await expect(headerNav.getByText('LOADING', { exact: true })).toHaveCount(0);
      } else {
        // mobile・tablet: ドロワーを開いて、MANAGE・LOADING だけが無い
        await page.getByRole('button', { name: 'Open menu' }).click();
        const drawer = page.locator('.header-drawer-shell');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('link', { name: 'STOCKIST', exact: true })).toBeVisible();
        await expect(drawer.getByText('MANAGE', { exact: true })).toHaveCount(0);
        await expect(drawer.getByText('LOADING', { exact: true })).toHaveCount(0);
      }

      // ヘッダー全体（ドロワーを含む）にも出ていない
      await expect(page.getByText('MANAGE', { exact: true })).toHaveCount(0);
      await expect(page.getByText('LOADING', { exact: true })).toHaveCount(0);
    });
  });
}
