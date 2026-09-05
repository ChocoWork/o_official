import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { OtpVerifyRequestSchema } from '@/features/auth/schemas/otp';
import { formatZodError } from '@/features/auth/schemas/common';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';

export async function POST(request: Request) {
  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:otp:verify', limit: 30, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (otp verify):', e);
    }

    const body = await request.json();
    const parsed = OtpVerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { code } = parsed.data;

    // 「パスワード検証済み」の署名 Cookie を必須とする（パスワードを迂回した OTP 単独ログインを防ぐ）。
    // 宛先もここから取る。クライアントから受け取らないので、偽装のしようがない。
    const { readLoginTwoFactorSessionFromCookieHeader } = await import('@/features/auth/services/login-2fa-session');
    const pending = readLoginTwoFactorSessionFromCookieHeader(request.headers.get('cookie'));
    if (!pending) {
      await logAudit({ action: 'auth.otp.verify', outcome: 'failure', detail: 'missing_or_invalid_password_session' });
      return NextResponse.json({ error: 'セッションの有効期限が切れました。もう一度ログインしてください。' }, { status: 401 });
    }

    // アカウント単位の総当たり対策。subject は必ず Cookie 由来にする。
    // クライアント入力の email を使うと、Cookie を持たない相手が他人の
    // アカウントの枠を故意に潰せる（DoS）。Cookie 検証の後に置くのもそのため。
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rlAccount = await enforceRateLimit({
        request,
        endpoint: 'auth:otp:verify',
        limit: 5,
        windowSeconds: 600,
        subject: pending.email,
      });

      if (rlAccount) {
        // 上限に達したら試行の窓ごと閉じる。Cookie を残すと、窓が明けてから
        // 同じログイン試行の続きとして再開できてしまう。
        // enforceRateLimit はテスト環境で素の Response を返しうるので、
        // 返り値を書き換えず新しい NextResponse を組み立てる。
        const { loginTwoFactorSessionCookieName, clearCookieOptions } = await import('@/lib/cookie');
        const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
        const retryAfter = rlAccount.headers.get('Retry-After');
        if (retryAfter) {
          limited.headers.set('Retry-After', retryAfter);
        }
        limited.cookies.set({
          name: loginTwoFactorSessionCookieName,
          value: '',
          ...clearCookieOptions(),
        });
        await logAudit({ action: 'auth.otp.verify', actor_email: pending.email, outcome: 'failure', detail: 'account_rate_limited' });
        return limited;
      }
    } catch (e) {
      console.error('Rate limit middleware error (otp verify account):', e);
    }

    const supabase = await createServiceRoleClient();

    // Supabase の公式サンプル（Passwordless email sign-in）はログイン OTP を
    // type: 'email' で検証する。複数 type を総当たりすると、1 回の入力で
    // Supabase 側の検証を最大 3 回消費し、signup / magiclink など別目的で
    // 発行されたトークンまで第 2 要素として受理しうる。
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      email: pending.email,
      token: code,
      type: 'email',
    });

    if (verifyError || !data?.session || !data?.user) {
      await logAudit({ action: 'auth.otp.verify', actor_email: pending.email, outcome: 'failure', detail: 'invalid_or_expired_otp' });
      return NextResponse.json({ error: '認証コードが無効、または期限切れです。' }, { status: 401 });
    }

    const res = NextResponse.json(
      {
        user: data.user,
        message: '認証に成功しました。',
      },
      { status: 200 },
    );

    // 使い捨ての「パスワード検証済み」Cookie を破棄する。
    const { loginTwoFactorSessionCookieName, clearCookieOptions } = await import('@/lib/cookie');
    res.cookies.set({ name: loginTwoFactorSessionCookieName, value: '', ...clearCookieOptions() });

    const { persistSessionAndCookies } = await import('@/features/auth/services/register');
    const persistResult = await persistSessionAndCookies(res, data.session, data.user);

    if (!persistResult?.ok) {
      await logAudit({
        action: 'auth.otp.verify',
        actor_email: data.user.email ?? pending.email,
        outcome: 'error',
        detail: `session_persist_failed: ${persistResult?.error || 'unknown'}`,
        resource_id: data.user.id,
      });
      return NextResponse.json({ error: 'ログイン処理に失敗しました。' }, { status: 500 });
    }

    // ログインのたびに走らせる。登録後に増えたゲスト注文も拾える。
    await linkGuestOrdersByEmail({
      userId: data.user.id,
      email: data.user.email ?? pending.email,
      emailConfirmedAt: data.user.email_confirmed_at ?? null,
    });

    await logAudit({
      action: 'auth.otp.verify',
      actor_email: data.user.email ?? pending.email,
      outcome: 'success',
      detail: 'verified_type:email',
      resource_id: data.user.id,
    });

    return res;
  } catch (err) {
    console.error('OTP verify handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
