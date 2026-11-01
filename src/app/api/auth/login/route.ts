/**
 * ログインの1段目の窓口。メールとパスワードを確かめ、通ったらメールの確認コードを送る（src/app/api/auth/login/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-145
 * @design DD-AUTH-014
 * @remarks セッションはここでは発行せず、確認コードの検証に成功した時に確定する（/api/auth/otp/verify）。
 * そのためパスワードを通った印は短命の署名つき Cookie にだけ持たせる。
 * パスワードの確かめと確認コードの送信は、Supabase の captcha を免除される auth だけの client（サービスの鍵）で呼ぶ。
 * 利用者の鍵で呼ぶと captcha のトークンが要るが、アプリの Turnstile のトークンは 1 回しか使えず転送できない。
 * captcha の拒否は資格情報の誤り（401）に丸めず、5xx と監査で気付けるようにする（全員が入れなくなる故障を隠さない）。
 * 同じ理由で、パスワードの確かめでの GoTrue の回数の制限（429）は 429＋Retry-After と監査 supabase_rate_limited、
 * 5xx・通信の失敗は 503 と監査 supabase_unavailable にする。資格情報の誤り・未確認のメールだけが 401 のまま（見分けを作らない）。
 * ログインの後の戻り先は、確認コードを送れた所（保留の Cookie を置く所）でだけ控える。パスワードの誤り・ボット判定・制限の応答で表の行を増やさないため。
 * 戻り先の値の型や長さでログインを 400 にせず（ログインそのものは止めない）、番号は Cookie だけに置いて本文には出さない。
 * 各段の順番と送り先の設定の理由は、その行のコメントに書いた。
 */
import { NextResponse } from 'next/server';
import { createServiceRoleAuthClient, isCaptchaRejection } from '@/lib/auth/service-role-auth-client';
import { logAudit } from '@/lib/audit';
import { LoginRequestSchema } from '@/features/auth/schemas/login';
import { formatZodError } from '@/features/auth/schemas/common';
import { getClientIp } from '@/lib/request-ip';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { applyReturnIntentCookie, issueReturnIntent } from '@/features/auth/return-intent/return-intent-service';

// GoTrue の IP ごとの回数の制限は 5 分の窓。画面の再試行の目安として 1 分を返す。
const UPSTREAM_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** signInWithPassword の誤りのうち、利用者の資格情報ではなく GoTrue 側の制限・障害によるもの。 */
function classifyPasswordUpstreamFailure(
  error: { status?: number; name?: string } | null | undefined,
): 'rate_limited' | 'unavailable' | null {
  if (!error) return null;
  if (error.status === 429) return 'rate_limited';
  if (error.name === 'AuthRetryableFetchError') return 'unavailable';
  if (typeof error.status === 'number' && (error.status === 0 || error.status >= 500)) return 'unavailable';
  return null;
}

export async function POST(request: Request) {
  try {
    // Enforce IP-level rate limit for login attempts
    const rl = await enforceRateLimit({ request, endpoint: 'auth:login', limit: 50, windowSeconds: 600 });
    if (rl) return rl;
    const body = await request.json();
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, password, turnstileToken } = parsed.data;

    const { verifyTurnstile } = await import('@/lib/turnstile');
    const ip = getClientIp(request);
    const turnstile = await verifyTurnstile(turnstileToken, ip);
    if (!turnstile.ok) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'failure', detail: turnstile.error || 'turnstile_failed' });
      return NextResponse.json({ error: 'Bot detection failed' }, { status: 403 });
    }

    // Account-based rate limit (by email)
    // Turnstile の検証より後に数える。先に数えると、ボット判定を通さずに他人のメールアドレスを
    // 送るだけでその人の枠を使い切らせ、締め出せてしまう（パスワード再設定と同じ順番）。
    const rlAccount = await enforceRateLimit({ request, endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: email });
    if (rlAccount) return rlAccount;

    // captcha を免除される auth だけの client でパスワード検証のみ行う（セッション Cookie の副作用を持たない。
    // 得た session は Cookie に渡さず捨てる。DB には使わない）。
    const supabase = await createServiceRoleAuthClient();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (isCaptchaRejection(error)) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'error', detail: 'supabase_captcha_rejected' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // GoTrue の IP ごとの回数の制限（429）と障害（5xx・通信の失敗）は、パスワードの誤りと見分ける。
    // 正しいパスワードの会員が「パスワードが違う」と言われ、監視には failure の行しか残らない事態を避ける。
    // 資格情報の誤り・未確認のメール（400 email_not_confirmed）は今までどおり下の 401 に丸め、列挙の手掛かりを作らない。
    const upstream = classifyPasswordUpstreamFailure(error);
    if (upstream === 'rate_limited') {
      await logAudit({ action: 'login', actor_email: email, outcome: 'error', detail: 'supabase_rate_limited' });
      return NextResponse.json(
        { error: 'ログインの試行が集中しています。しばらくしてから再度お試しください。' },
        { status: 429, headers: { 'Retry-After': String(UPSTREAM_RATE_LIMIT_RETRY_AFTER_SECONDS) } },
      );
    }
    if (upstream === 'unavailable') {
      await logAudit({ action: 'login', actor_email: email, outcome: 'error', detail: 'supabase_unavailable' });
      return NextResponse.json(
        { error: 'ただいまログインを処理できません。時間をおいて再度お試しください。' },
        { status: 503, headers: { 'Retry-After': String(UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS) } },
      );
    }

    if (error || !data.session || !data.user) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'failure', detail: error?.message || 'invalid credentials' });
      return NextResponse.json({ error: 'メールアドレスまたはパスワードが正しくありません。' }, { status: 401 });
    }

    // パスワード検証済み。第2要素としてメール OTP を送信する（未登録ユーザーは作成しない）。
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });

    if (isCaptchaRejection(otpError)) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'error', detail: 'supabase_captcha_rejected', resource_id: data.user.id });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

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
