import type { Page } from '@playwright/test';
import { createEmailCodeSessionToken } from '@/features/auth/services/email-code-session';
import { emailCodeSessionCookieName } from '@/lib/cookie';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

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
