/**
 * FR-LOGIN-080 消したパスワードのログイン・会員登録・確認リンクの窓口と画面は 404 で、どこからもリンクが無い
 * 対応: FR-AUTH-053-AC-01 / FR-AUTH-053-AC-02 / SEC-AUTH-061-AC-01（上位: SR-AUTH-030、THR-AUTH-059）
 *
 * パスキー段4の Task 28。Task 29 が再設定・変更の窓口と画面（`/auth/password-reset`・`/account/password` ほか）の確かめを足した。後のタスク（TOTP・`/auth/verified`）が、自分の消した物の確かめをここへ足す。
 * 窓口は HTTP で直に叩く（画面は開かない）。Origin を付けて proxy の Origin の確かめを通し、消えたことだけを確かめる。
 * 手元のアプリ（本番ビルド）で流す。3つの幅でくり返す（画面の確かめがあるため）。
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createTestMember, readLatestCode, readMailpitMessages } from './member-session-helpers';
import { stubTurnstileScript } from './turnstile-test-utils';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const REMOVED_SCREENS = ['/login/password', '/login/verify'] as const;
const REMOVED_RESET_SCREENS = ['/auth/password-reset', '/auth/password-reset/verify', '/account/password'] as const;
const REMOVED_POST_ENTRIES = [
  '/api/auth/login',
  '/api/auth/login/resend',
  '/api/auth/login/cancel',
  '/api/auth/otp/verify',
  '/api/auth/register',
] as const;
const REMOVED_RESET_POST_ENTRIES = [
  '/api/auth/password-reset/request',
  '/api/auth/password-reset/link',
  '/api/auth/password-reset/confirm',
  '/api/auth/password/change/start',
  '/api/auth/password/change/confirm',
] as const;

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-080 removed auth entries (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const path of REMOVED_SCREENS) {
      test(`FR-AUTH-053-AC-01 ${viewport.name}: 消した画面 ${path} は 404`, async ({ page }) => {
        const response = await page.goto(path);
        expect(response?.status()).toBe(404);
      });
    }

    for (const path of REMOVED_RESET_SCREENS) {
      test(`FR-AUTH-053-AC-02 ${viewport.name}: 消した再設定・変更の画面 ${path} は 404`, async ({ page }) => {
        const response = await page.goto(path);
        expect(response?.status()).toBe(404);
      });
    }

    const post404 = async (request: APIRequestContext, path: string) => {
      const response = await request.post(path, {
        headers: { origin: ORIGIN, 'x-real-ip': `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 253)}` },
        data: { email: 'user@example.com', password: 'Passw0rd!23456789', code: '12345678' },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(response.status()).toBe(404);
      const setCookies = response.headersArray().filter((header) => header.name.toLowerCase() === 'set-cookie');
      expect(setCookies).toEqual([]);
    };

    for (const path of REMOVED_POST_ENTRIES) {
      test(`FR-AUTH-053-AC-01 ${viewport.name}: 消した窓口 POST ${path} は 404 で、セッションの Cookie を出さない`, async ({ request }) => {
        await post404(request, path);
      });
    }

    for (const path of REMOVED_RESET_POST_ENTRIES) {
      test(`FR-AUTH-053-AC-02 ${viewport.name}: 消した再設定・変更の窓口 POST ${path} は 404 で、セッションの Cookie を出さない`, async ({ request }) => {
        await post404(request, path);
      });
    }

    test(`FR-AUTH-053-AC-02 ${viewport.name}: 消した再設定の状態の窓口 GET /api/auth/password-reset/session は 404`, async ({ request }) => {
      const response = await request.get('/api/auth/password-reset/session', { failOnStatusCode: false, maxRedirects: 0 });
      expect(response.status()).toBe(404);
    });

    test(`FR-AUTH-053-AC-01 ${viewport.name}: 消した確認リンクの窓口 GET /api/auth/confirm は 404（リンクの付いた戻り先でも同じ）`, async ({ request }) => {
      for (const query of ['', '?token_hash=invalid-token&type=signup', '?redirect_to=%2F%2Fevil.example']) {
        const response = await request.get(`/api/auth/confirm${query}`, { failOnStatusCode: false, maxRedirects: 0 });
        expect(response.status(), `GET /api/auth/confirm${query}`).toBe(404);
      }
    });

    test(`SEC-AUTH-061-AC-01 ${viewport.name}: /login にパスワードの欄・会員登録のタブ・消した画面へのリンクが無い`, async ({ page }) => {
      await stubTurnstileScript(page);
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeAttached();

      await expect(page.getByLabel(/password/i)).toHaveCount(0);
      await expect(page.getByRole('tab')).toHaveCount(0);
      await expect(page.getByRole('tab', { name: '会員登録' })).toHaveCount(0);
      await expect(page.locator('a[href*="/login/password"], a[href*="/login/verify"], a[href*="/api/auth/confirm"], a[href*="/auth/password-reset"]')).toHaveCount(0);
    });

    test(`SEC-AUTH-061-AC-01 ${viewport.name}: ヘッダーのログインのリンクは /login へ向き、消した画面を指さない`, async ({ page }) => {
      await page.goto('/about');
      const headerLogin = page.getByRole('banner').getByRole('link', { name: 'ログイン', exact: true });
      await expect(headerLogin).toHaveAttribute('href', /^\/login(\?|$)/);
      await expect(page.locator('a[href*="/login/password"], a[href*="/login/verify"]')).toHaveCount(0);
    });

    test(`SEC-AUTH-061-AC-01 ${viewport.name}: 旧の保留の Cookie（sb-login-2fa-session）を持っていても /login は転送せず、描く`, async ({ page }) => {
      await stubTurnstileScript(page);
      await page.goto('/');
      await page.context().addCookies([
        { name: 'sb-login-2fa-session', value: 'legacy-pending-value', url: ORIGIN, httpOnly: true, sameSite: 'Strict' },
      ]);
      await page.goto('/login');
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('button', { name: 'メールでコードを受け取る' })).toBeVisible();
    });

    for (const next of ['/login/password', '/login/verify', '/api/auth/confirm'] as const) {
      test(`SEC-AUTH-061-AC-01 ${viewport.name}: 消した窓口・画面 ${next} を戻り先（next）にしても、ログインの後は / に着く`, async ({ page }) => {
        const ip = `198.19.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 253)}`;
        const headers = { origin: ORIGIN, 'x-real-ip': ip };
        const member = await createTestMember(`n061-${viewport.name}`);
        await page.goto('/');
        const previousIds = new Set((await readMailpitMessages(member.email)).map((message) => message.ID));

        const started = await page.request.post('/api/auth/email-code/start', {
          headers,
          data: { email: member.email, turnstileToken: 'test-turnstile-token', next },
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        expect(started.status()).toBe(202);
        const code = await readLatestCode(member.email, previousIds);
        const verified = await page.request.post('/api/auth/email-code/verify', {
          headers,
          data: { code },
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        expect(verified.status()).toBe(200);

        const destination = await page.request.post('/api/auth/post-login', { headers, failOnStatusCode: false, maxRedirects: 0 });
        expect(destination.status()).toBe(200);
        expect(((await destination.json()) as { redirectTo?: string }).redirectTo).toBe('/');
      });
    }
  });
}
