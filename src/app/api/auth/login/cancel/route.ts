import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { clearCookieOptions, loginTwoFactorSessionCookieName } from '@/lib/cookie';
import { readLoginTwoFactorSessionFromCookieHeader } from '@/features/auth/services/login-2fa-session';

// PUBLIC: 認証コード入力からの離脱。副作用は 2FA Cookie の破棄のみ。
//
// CSRF は proxy の Origin 検査（FREQ-327）が /api 配下の POST を既定で覆うため、
// ここでは扱わない。踏まれても被害は「ログインの中断」だけなのでレート制限も置かない。
export async function POST(request: Request) {
  const pending = readLoginTwoFactorSessionFromCookieHeader(
    request.headers.get('cookie'),
  );

  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.headers.set('Cache-Control', 'no-store');
  res.cookies.set({
    name: loginTwoFactorSessionCookieName,
    value: '',
    ...clearCookieOptions(),
  });

  // 記録するのは実際に保留セッションを捨てたときだけ。Cookie が無ければ
  // 捨てるものが無く、記録すべき事実も無い。無条件に書くと、レート制限の
  // 無いこの口から監査行を水増しできる。
  // 中断が多発するなら OTP の配送に問題がある、という信号になる。
  if (pending) {
    await logAudit({
      action: 'login',
      actor_email: pending.email,
      outcome: 'cancelled',
      detail: 'otp_step_abandoned',
    });
  }

  return res;
}
