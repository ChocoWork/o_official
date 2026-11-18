/**
 * FR-LOGIN-069 店員が Google・メールのコード・古いパスワードで入ろうとすると、パスキーを案内する文が出てセッションが作られず、TOTP の登録は 410 で断られる
 * 対応: FR-AUTH-046-AC-04 / FR-AUTH-046-AC-05 / FR-AUTH-046-AC-06（設計: DD-AUTH-083、SEC-AUTH-037）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で流す。店員は provisionStaff（ソフトの認証器）で用意する。
 * 要求ごとに別の x-real-ip と origin を付ける（回数の枠を使い切らないため・proxy の Origin の確かめ）。Turnstile は E2E の公式のテスト鍵（常に通る）。
 * Google は、本物の Google を通さず、GoTrue がフックの拒否を戻りの URL に付けて返す形を模した値を、戻りの窓口に直に渡して確かめる（実機は段3b）。
 * メール・パスワード・トークンが通信記録に残らないよう trace は切る。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { provisionStaff } from '../scripts/e2e/passkey-staff';
import { readLatestCode } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';
import { loginViaApp } from './passkey-app-api';
import { setStaffPassword } from './passkey-hook-scenarios';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
const STAFF_MESSAGE = '店員の方は、パスキーでログインしてください。';
const MARKER_MESSAGE = '[staff-passkey-required] staff must sign in with a passkey';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  return `198.${randomInt(16, 20)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function uniqueEmail(label: string): string {
  return `e2e-staff-other-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

async function isAuthenticated(page: Page): Promise<boolean> {
  const me = await page.request.get('/api/auth/me');
  return ((await me.json()) as { authenticated?: boolean }).authenticated === true;
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-069 staff other paths rejected (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`FR-AUTH-046-AC-04 ${viewport.name}: 店員がメールのコードで確定すると、パスキーを案内する文が出て、セッションが作られない`, async ({ page }) => {
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      // 店員を作った直後は、GoTrue の同じアドレスへの送信の間隔（手元は1秒）の中にいる。間隔が過ぎるのを条件で待ってから始める。
      const intervalEnds = Date.now() + 1_500;
      await expect.poll(() => Date.now() >= intervalEnds, { intervals: [100], timeout: 5_000 }).toBe(true);
      const started = await page.request.post('/api/auth/email-code/start', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        data: { email: staff.email, turnstileToken: VALID_TURNSTILE_TOKEN },
        maxRedirects: 0,
      });
      expect(started.status()).toBe(202);
      const code = await readLatestCode(staff.email, new Set());

      await page.goto('/login/code');
      await page.getByLabel('確認コード 1桁目').click();
      await page.keyboard.type(code);
      await page.getByRole('button', { name: 'ログイン' }).click();

      await expect(page.getByText(STAFF_MESSAGE)).toBeVisible();
      expect(await isAuthenticated(page)).toBe(false);
    });

    test(`FR-AUTH-046-AC-04 ${viewport.name}: Google でフックに断られた戻りは、/login にパスキーを案内する文を出し、セッションの Cookie を作らない。ほかの error は出さない`, async ({ page, context }) => {
      await page.setExtraHTTPHeaders({ 'x-real-ip': uniqueIp() });

      await page.goto(`/api/auth/oauth/callback?error=access_denied&error_description=${encodeURIComponent(MARKER_MESSAGE)}`);
      await expect(page).toHaveURL(/\/login\?error=staff_passkey_required$/);
      await expect(page.getByText(STAFF_MESSAGE)).toBeVisible();
      expect(await isAuthenticated(page)).toBe(false);
      const names = (await context.cookies()).map((cookie) => cookie.name);
      expect(names.filter((name) => /^sb-.*(auth-token|session)/.test(name) || name === 'sb-access-token' || name === 'sb-refresh-token')).toEqual([]);

      await page.goto('/login?error=access_denied');
      await expect(page.getByRole('button', { name: 'パスキーでログイン' })).toBeVisible();
      await expect(page.getByText(STAFF_MESSAGE)).toHaveCount(0);
      await expect(page.getByText('access_denied')).toHaveCount(0);
    });

    test(`FR-AUTH-046-AC-04 ${viewport.name}: 店員が古いパスワードの道（/login/password）で入ろうとしても、セッションが作られない`, async ({ page }) => {
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      const password = await setStaffPassword(staff.userId);

      const response = await page.request.post('/api/auth/login', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        data: { email: staff.email, password, turnstileToken: VALID_TURNSTILE_TOKEN },
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      expect(response.status()).toBe(401);
      expect(((await response.json()) as { step?: string }).step).toBeUndefined();
      expect(await isAuthenticated(page)).toBe(false);
    });

    test(`FR-AUTH-046-AC-05 ${viewport.name}: パスキーで入った店員の TOTP の登録は 410 totp_retired で、要素が作られない`, async ({ page }) => {
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      const login = await loginViaApp(page.request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
      expect(login.status).toBe(200);

      const response = await page.request.post('/api/auth/mfa/enroll-totp', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        data: {},
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      expect(response.status()).toBe(410);
      expect(await response.json()).toEqual({ error: 'totp_retired' });
      const factors = await withLocalDb((db) => db.query('select count(*)::int as n from auth.mfa_factors where user_id = $1::uuid', [staff.userId]));
      expect(factors.rows[0].n).toBe(0);
    });

    test(`FR-AUTH-046-AC-06 ${viewport.name}: 認証のない TOTP の登録は 401 のまま（店員かどうかを漏らさない）`, async ({ request }) => {
      const response = await request.post('/api/auth/mfa/enroll-totp', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        data: {},
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(response.status()).toBe(401);
    });
  });
}
