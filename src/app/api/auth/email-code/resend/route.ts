/**
 * メールのコードの再送の窓口（src/app/api/auth/email-code/resend/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-300
 * @design DD-AUTH-059
 * @remarks 本文は見ない。宛先は保留の Cookie だけから取る（本文の email を信じると、他人の宛先へ当社ドメインからメールを送らせる導線になる）。
 * 枠は始めと同じ名前（`auth:email-code:send`）。10分に始め＋再送で5通まで。
 * 成功は Cookie を新しい期限で付け直す（元の iat・jti を引き継ぐ。渡さないと絶対上限の起点と確定の枠が新しくなる）。
 */
import { NextResponse } from 'next/server';
import { createServiceRoleAuthClient, isCaptchaRejection } from '@/lib/auth/service-role-auth-client';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { cookieOptionsForEmailCode, emailCodeSessionCookieName } from '@/lib/cookie';
import {
  createEmailCodeSessionToken,
  emailCodeSessionMaxAgeSeconds,
  readEmailCodeSessionFromCookieHeader,
} from '@/features/auth/services/email-code-session';

/** `NextResponse.json` は試験の環境（`Response.json` が無い）で動かないので、パスキーの窓口と同じく本文を自分で組む。 */
function json(body: unknown, init: { status: number; headers?: Record<string, string> }): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status: init.status,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

const AUDIT_ACTION = 'auth.email_code.resend';
const SEND_ENDPOINT = 'auth:email-code:send';
const UPSTREAM_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;
const FAILED_MESSAGE = '確認コードの送信に失敗しました。時間をおいて再度お試しください。';

export async function POST(request: Request) {
  try {
    const pending = readEmailCodeSessionFromCookieHeader(request.headers.get('cookie'));
    if (!pending) {
      return json({ error: 'セッションの有効期限が切れました。もう一度メールアドレスを入力してください。' }, { status: 401 });
    }

    const rlIp = await enforceRateLimit({ request, endpoint: SEND_ENDPOINT, limit: 50, windowSeconds: 600 });
    if (rlIp) return rlIp;
    const rlAccount = await enforceRateLimit({ request, endpoint: SEND_ENDPOINT, limit: 5, windowSeconds: 600, subject: pending.email });
    if (rlAccount) return rlAccount;

    const supabase = await createServiceRoleAuthClient();
    const { error } = await supabase.auth.signInWithOtp({ email: pending.email, options: { shouldCreateUser: false } });

    if (isCaptchaRejection(error)) {
      await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'error', detail: 'supabase_captcha_rejected' });
      return json({ error: FAILED_MESSAGE }, { status: 500 });
    }
    // 宛先は保留の Cookie で本人のものと決まっているので、始めと違い上流の制限を隠さず、画面が待ち直せるようにする。
    if (error?.status === 429) {
      await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'error', detail: 'supabase_rate_limited' });
      return json(
        { error: '送信が集中しています。しばらくしてから再度お試しください。' },
        { status: 429, headers: { 'Retry-After': String(UPSTREAM_RATE_LIMIT_RETRY_AFTER_SECONDS) } },
      );
    }
    if (error && (error.name === 'AuthRetryableFetchError' || (typeof error.status === 'number' && (error.status === 0 || error.status >= 500)))) {
      await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'error', detail: 'supabase_unavailable' });
      return json(
        { error: 'ただいま処理できません。時間をおいて再度お試しください。' },
        { status: 503, headers: { 'Retry-After': String(UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS) } },
      );
    }
    if (error) {
      await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'error', detail: 'otp_resend_failed' });
      return json({ error: FAILED_MESSAGE }, { status: 500 });
    }

    const res = json({ ok: true }, { status: 200 });
    res.headers.set('Cache-Control', 'no-store');
    res.cookies.set({
      name: emailCodeSessionCookieName,
      value: createEmailCodeSessionToken({ email: pending.email, issuedAt: pending.iat, jti: pending.jti }),
      ...cookieOptionsForEmailCode(emailCodeSessionMaxAgeSeconds),
    });

    await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'otp_resent' });
    return res;
  } catch (err) {
    console.error('Email code resend handler error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
}
