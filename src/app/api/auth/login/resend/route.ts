/**
 * ログインの認証コードの再送の窓口（src/app/api/auth/login/resend/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-161
 * @design DD-AUTH-016
 * @remarks 公開の窓口でパスワードは要求しない。パスワード検証を通ったことは 2FA Cookie が既に証明しているため、宛先は Cookie から取り、リクエスト本文は一切見ない。本文の email を信じると、他人の宛先へ当社ドメインからメールを送らせる導線になる。
 */
import { NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import {
  cookieOptionsForLoginTwoFactor,
  loginTwoFactorSessionCookieName,
} from '@/lib/cookie';
import {
  createLoginTwoFactorSessionToken,
  loginTwoFactorSessionMaxAgeSeconds,
  readLoginTwoFactorSessionFromCookieHeader,
} from '@/features/auth/services/login-2fa-session';

export async function POST(request: Request) {
  const pending = readLoginTwoFactorSessionFromCookieHeader(
    request.headers.get('cookie'),
  );

  if (!pending) {
    return NextResponse.json(
      {
        error:
          'セッションの有効期限が切れました。もう一度ログインしてください。',
      },
      { status: 401 },
    );
  }

  // /api/auth/login と同じ二段（IP と宛先）にする。IP 段が無いと、複数アカウントのパスワードを持つ相手が
  // 1 つの IP から並行に送信を回せる。枠（endpoint 名）もログインと共有する。抑えたいのは 1 アカウントへ
  // 送るメールの総量なので、分けるとログイン 5 通と再送 5 通で 10 通送れてしまう。
  const rlIp = await enforceRateLimit({
    request,
    endpoint: 'auth:login',
    limit: 50,
    windowSeconds: 600,
  });
  if (rlIp) return rlIp;

  const rlAccount = await enforceRateLimit({
    request,
    endpoint: 'auth:login',
    limit: 5,
    windowSeconds: 600,
    subject: pending.email,
  });
  if (rlAccount) return rlAccount;

  const supabase = await createPublicClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: pending.email,
    options: { shouldCreateUser: false },
  });

  if (error) {
    await logAudit({
      action: 'login',
      actor_email: pending.email,
      outcome: 'error',
      detail: `otp_resend_failed: ${error.message}`,
      resource_id: pending.userId,
    });
    return NextResponse.json(
      {
        error:
          '認証コードの送信に失敗しました。時間をおいて再度お試しください。',
      },
      { status: 500 },
    );
  }

  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.headers.set('Cache-Control', 'no-store');

  // 再送した直後に Cookie が切れると、届いたコードを入力できない。
  res.cookies.set({
    name: loginTwoFactorSessionCookieName,
    value: createLoginTwoFactorSessionToken({
      userId: pending.userId,
      email: pending.email,
      // 元の iat を引き継ぐ。渡さないと絶対上限の起点がリセットされ、
      // 再送を繰り返す限り保留状態を延ばせてしまう。
      issuedAt: pending.iat,
    }),
    ...cookieOptionsForLoginTwoFactor(loginTwoFactorSessionMaxAgeSeconds),
  });

  await logAudit({
    action: 'login',
    actor_email: pending.email,
    outcome: 'otp_resent',
    resource_id: pending.userId,
  });

  return res;
}
