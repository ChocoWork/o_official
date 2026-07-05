import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { OtpVerifyRequestSchema } from '@/features/auth/schemas/otp';
import { formatZodError } from '@/features/auth/schemas/common';
import type { SupabaseClient } from '@supabase/supabase-js';

async function tryVerifyOtpWithTypes(
  supabase: SupabaseClient,
  email: string,
  code: string
) {
  const candidates: Array<'email' | 'magiclink' | 'signup'> = ['email', 'magiclink', 'signup'];
  for (const type of candidates) {
    const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type });
    if (!error && data?.session && data?.user) {
      return { data, type, error: null };
    }
  }
  return { data: null, type: null, error: new Error('OTP verification failed') };
}

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

    const { email, code } = parsed.data;

    // 「パスワード検証済み」の署名 Cookie を必須とする（パスワードを迂回した OTP 単独ログインを防ぐ）。
    const { readLoginTwoFactorSessionFromCookieHeader } = await import('@/features/auth/services/login-2fa-session');
    const pending = readLoginTwoFactorSessionFromCookieHeader(request.headers.get('cookie'));
    if (!pending || pending.email !== email) {
      await logAudit({ action: 'auth.otp.verify', actor_email: email, outcome: 'failure', detail: 'missing_or_invalid_password_session' });
      return NextResponse.json({ error: 'セッションの有効期限が切れました。もう一度ログインしてください。' }, { status: 401 });
    }

    const supabase = await createServiceRoleClient();
    const result = await tryVerifyOtpWithTypes(supabase, email, code);

    if (!result.data?.session || !result.data?.user) {
      await logAudit({ action: 'auth.otp.verify', actor_email: email, outcome: 'failure', detail: 'invalid_or_expired_otp' });
      return NextResponse.json({ error: '認証コードが無効、または期限切れです。' }, { status: 401 });
    }

    const res = NextResponse.json(
      {
        user: result.data.user,
        message: '認証に成功しました。',
      },
      { status: 200 },
    );

    // 使い捨ての「パスワード検証済み」Cookie を破棄する。
    const { loginTwoFactorSessionCookieName, clearCookieOptions } = await import('@/lib/cookie');
    res.cookies.set({ name: loginTwoFactorSessionCookieName, value: '', ...clearCookieOptions() });

    const { persistSessionAndCookies } = await import('@/features/auth/services/register');
    const persistResult = await persistSessionAndCookies(res, result.data.session, result.data.user);

    if (!persistResult?.ok) {
      await logAudit({
        action: 'auth.otp.verify',
        actor_email: result.data.user.email ?? email,
        outcome: 'error',
        detail: `session_persist_failed: ${persistResult?.error || 'unknown'}`,
        resource_id: result.data.user.id,
      });
      return NextResponse.json({ error: 'ログイン処理に失敗しました。' }, { status: 500 });
    }

    await logAudit({
      action: 'auth.otp.verify',
      actor_email: result.data.user.email ?? email,
      outcome: 'success',
      detail: `verified_type:${result.type ?? 'unknown'}`,
      resource_id: result.data.user.id,
    });

    return res;
  } catch (err) {
    console.error('OTP verify handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
