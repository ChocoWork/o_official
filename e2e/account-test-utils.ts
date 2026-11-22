import { expect, Page } from '@playwright/test';
import { CART_API_URL, toCartJson } from './shop-test-utils';

/**
 * 認証と、配送先・カート・お気に入りの読み込みを固定する。
 * 中身の要る spec は、呼んだ後に自分の route を登録する（後に登録した方が勝つ）。
 */
export async function mockOtpAuthentication(page: Page, email = 'user@example.com') {
  // ログインの後の行き先はサーバーが戻り先を使い切って返す（POST /api/auth/post-login）。
  // 偽の印のままだと実 API は 401 で /login へ倒れるので、/account の門から入った会員の戻り先として固定する。
  await page.route('**/api/auth/post-login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ redirectTo: '/account' }),
    });
  });

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: {
          id: 'test-user-id',
          email,
          role: 'user',
          mfaVerified: false,
        },
      }),
    });
  });

  // ACCOUNT はプロフィールと並行して配送先も読む。ここだけ実 API に届くと、
  // 偽 Cookie に対する 401 → refresh 失敗で認証モックまで未認証へ切り替わる。
  await page.route('**/api/profile/addresses', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ addresses: [] }),
    });
  });

  // カートとお気に入りの読み込みは会員の印を確かめる。偽の印のままだと実 API が 401 を返し、画面が印の更新を
  // 呼んで（失敗して）ログインの Cookie を消すため、後の認証モックが効かなくなる。読み込みは空で固定する
  await page.route(CART_API_URL, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toCartJson([])) });
  });
  await page.route('**/api/wishlist', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

/**
 * 認証を固定した（mockOtpAuthentication）まま /account を開く。
 * パスワードのログイン画面は消したので、画面での入力はせず、ログインの Cookie（偽の値）を置いて /account へ入る。
 * 本物のメールのコードのログインは loginAsMember（member-session-helpers.ts）が使う。
 */
export async function loginAndOpenAccount(page: Page, _email = 'user@example.com') {
  await page.goto('/login');
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: 'sb-access-token', value: 'test-access-token', url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'sb-refresh-token', value: 'test-refresh-token', url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'sb-csrf-token', value: 'test-csrf-token', url: origin, httpOnly: false, sameSite: 'Lax' },
  ]);

  await page.goto('/account');
  await page.waitForURL('**/account');
  await expect(page).toHaveURL(/\/account/);
}
