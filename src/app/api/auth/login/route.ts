import { NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { LoginRequestSchema } from '@/features/auth/schemas/login';
import { formatZodError } from '@/features/auth/schemas/common';

// ステップ1: メール + パスワードを検証し、成功したらメール OTP を送信する。
// セッションはまだ発行せず、OTP 検証成功時（/api/auth/otp/verify）に確定する。
export async function POST(request: Request) {
  try {
    // Enforce IP-level rate limit for login attempts
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:login', limit: 50, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (login):', e);
    }
    const body = await request.json();
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    // Account-based rate limit (by email)
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rlAccount = await enforceRateLimit({ request, endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: parsed.data.email });
      if (rlAccount) return rlAccount;
    } catch (e) {
      console.error('Rate limit middleware error (login-account):', e);
    }

    const { email, password, turnstileToken } = parsed.data;

    const siteKeyConfigured = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    if (siteKeyConfigured) {
      const { verifyTurnstile } = await import('@/lib/turnstile');
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
      const turnstile = await verifyTurnstile(turnstileToken, ip);
      if (!turnstile.ok) {
        await logAudit({ action: 'login', actor_email: email, outcome: 'failure', detail: turnstile.error || 'turnstile_failed' });
        return NextResponse.json({ error: 'Bot detection failed' }, { status: 403 });
      }
    }

    // 匿名クライアントでパスワード検証のみ行う（セッション Cookie の副作用を持たない）。
    const supabase = await createPublicClient();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session || !data.user) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'failure', detail: error?.message || 'invalid credentials' });
      return NextResponse.json({ error: 'メールアドレスまたはパスワードが正しくありません。' }, { status: 401 });
    }

    // パスワード検証済み。第2要素としてメール OTP を送信する（未登録ユーザーは作成しない）。
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });

    if (otpError) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'error', detail: `otp_send_failed: ${otpError.message}`, resource_id: data.user.id });
      return NextResponse.json({ error: '認証コードの送信に失敗しました。時間をおいて再度お試しください。' }, { status: 500 });
    }

    // 「パスワード検証済み」を表す短命の署名 Cookie を発行。OTP 検証時に必須とする。
    const { createLoginTwoFactorSessionToken, loginTwoFactorSessionMaxAgeSeconds } = await import('@/features/auth/services/login-2fa-session');
    const { loginTwoFactorSessionCookieName, cookieOptionsForLoginTwoFactor } = await import('@/lib/cookie');

    const pendingToken = createLoginTwoFactorSessionToken({ userId: data.user.id, email });

    const res = NextResponse.json(
      { step: 'otp', message: '認証コードを送信しました。メールに届いたコードを入力してください。' },
      { status: 200 },
    );
    res.cookies.set({
      name: loginTwoFactorSessionCookieName,
      value: pendingToken,
      ...cookieOptionsForLoginTwoFactor(loginTwoFactorSessionMaxAgeSeconds),
    });

    await logAudit({ action: 'login', actor_email: email, outcome: 'password_verified', detail: 'otp_sent', resource_id: data.user.id });

    return res;
  } catch (err) {
    console.error('Login handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
