/**
 * ログインの1段目の窓口。メールとパスワードを確かめ、通ったらメールの確認コードを送る（src/app/api/auth/login/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-145
 * @design DD-AUTH-014
 * @remarks セッションはここでは発行せず、確認コードの検証に成功した時に確定する（/api/auth/otp/verify）。
 * そのためパスワードを通った印は短命の署名つき Cookie にだけ持たせる。
 * ログインの後の戻り先は、確認コードを送れた所（保留の Cookie を置く所）でだけ控える。パスワードの誤り・ボット判定・制限の応答で表の行を増やさないため。
 * 戻り先の値の型や長さでログインを 400 にせず（ログインそのものは止めない）、番号は Cookie だけに置いて本文には出さない。
 * 各段の順番と送り先の設定の理由は、その行のコメントに書いた。
 */
import { NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { LoginRequestSchema } from '@/features/auth/schemas/login';
import { formatZodError } from '@/features/auth/schemas/common';
import { applyReturnIntentCookie, issueReturnIntent } from '@/features/auth/return-intent/return-intent-service';

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

    const { email, password, turnstileToken } = parsed.data;

    const { verifyTurnstile } = await import('@/lib/turnstile');
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const turnstile = await verifyTurnstile(turnstileToken, ip);
    if (!turnstile.ok) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'failure', detail: turnstile.error || 'turnstile_failed' });
      return NextResponse.json({ error: 'Bot detection failed' }, { status: 403 });
    }

    // Account-based rate limit (by email)
    // Turnstile の検証より後に数える。先に数えると、ボット判定を通さずに他人のメールアドレスを
    // 送るだけでその人の枠を使い切らせ、締め出せてしまう（パスワード再設定と同じ順番）。
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rlAccount = await enforceRateLimit({ request, endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: email });
      if (rlAccount) return rlAccount;
    } catch (e) {
      console.error('Rate limit middleware error (login-account):', e);
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

    // 戻り先が無い・不正・保存の失敗でも、前の試みの古い控えの Cookie を使わせないよう必ず消す側へ倒す。
    const { action: returnIntentAction } = await issueReturnIntent({ rawNext: parsed.data.next, purpose: 'login' });
    applyReturnIntentCookie(res, returnIntentAction);

    await logAudit({ action: 'login', actor_email: email, outcome: 'password_verified', detail: 'otp_sent', resource_id: data.user.id });

    return res;
  } catch (err) {
    console.error('Login handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
