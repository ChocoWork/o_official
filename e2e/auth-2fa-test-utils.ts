import type { Page } from '@playwright/test';
import { createEmailCodeSessionToken } from '@/features/auth/services/email-code-session';
import { createLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';
import { emailCodeSessionCookieName } from '@/lib/cookie';

/**
 * パスワード検証を通過した直後の状態を作る。
 *
 * e2e は /api/auth/login をネットワーク層でモックするため、本物の 2FA Cookie が
 * 発行されない。/login/verify はサーバーで Cookie を検証するので、テスト側で
 * 本物の署名 Cookie を置く必要がある。
 *
 * 署名鍵は playwright.config.ts の loadEnvConfig が読む .env.local の
 * JWT_SECRET（または LOGIN_2FA_SESSION_SECRET）。
 * この仕組みは「認証前段の有効な状態」を偽造できるため、CI では本番の
 * JWT_SECRET を使わないこと。
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export async function setLoginTwoFactorCookie(
  page: Page,
  email = 'user@example.com',
  userId = 'e2e-user-id',
) {
  // 注意書きだけでなくコードで縛る。本番環境に対して「パスワード検証済み」の
  // 有効な状態を作れてはいけない。呼び出し前に同一オリジンのページへ
  // 遷移していること（Cookie の設定先をそこから取る）。
  const origin = new URL(page.url()).origin;
  if (!LOCAL_ORIGIN.test(origin)) {
    throw new Error(
      `setLoginTwoFactorCookie は localhost 専用。対象オリジン: ${origin}。` +
        '本番環境に対して認証前段の有効な状態を偽造してはいけない。',
    );
  }

  const value = createLoginTwoFactorSessionToken({ userId, email });

  await page.context().addCookies([
    {
      name: 'sb-login-2fa-session',
      value,
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

/**
 * メールのコードの流れの保留の Cookie（sb-email-code-session）を置く。
 * 始めの窓口（Turnstile を伴う）を通さずに、再送・確定の窓口へ入るため。localhost 専用。
 * 呼び出し前に同一オリジンのページへ遷移していること。
 */
export async function setEmailCodeSessionCookie(page: Page, email: string) {
  const origin = new URL(page.url()).origin;
  if (!LOCAL_ORIGIN.test(origin)) {
    throw new Error(
      `setEmailCodeSessionCookie は localhost 専用。対象オリジン: ${origin}。` +
        '本番環境に対して保留の状態を偽造してはいけない。',
    );
  }
  await page.context().addCookies([
    {
      name: emailCodeSessionCookieName,
      value: createEmailCodeSessionToken({ email }),
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

/** 2FA Cookie を消す。検証画面から弾かれることを確かめたいときに使う。 */
export async function clearLoginTwoFactorCookie(page: Page) {
  const remaining = (await page.context().cookies()).filter(
    (cookie) => cookie.name !== 'sb-login-2fa-session',
  );
  await page.context().clearCookies();
  if (remaining.length > 0) {
    await page.context().addCookies(remaining);
  }
}
