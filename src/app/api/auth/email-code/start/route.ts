/**
 * メールのコードのログイン・新規の始めの窓口（src/app/api/auth/email-code/start/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-298
 * @design DD-AUTH-059
 * @remarks 登録の有無を調べない。先に `admin.createUser`（確認済み・パスワード無し・印 `email_code_signup_pending`）を呼び、
 * 登録済みなら `email_exists` で断られるので握りつぶし、全員に同じく `signInWithOtp({ shouldCreateUser: false })` を呼ぶ。
 * 成功は常に 202 と同じ本文・同じ Set-Cookie（未登録・登録済み・店員で見分けがつかない。SEC-AUTH-048）。
 * GoTrue の宛先ごとの送信の間隔の 429 は 202 に隠す（登録済みの見分けになるため）。監査 `email_code_send_throttled` とログで残す。
 * 順番: IP の枠 → 本文の形 → Turnstile → メール単位の枠（Turnstile の後に数える。先に数えると他人の枠を使い切らせて締め出せる）→ createUser → signInWithOtp。
 * 枠の名前は再送と共有（`auth:email-code:send`）。分けると10分に10通送れてしまう。
 * 旧の会員登録で作った未確認のアドレスには、コードでなく確認メールが届く（段4まで。画面の常時の案内と台帳に書く）。サーバーで確認済みにはしない。
 * admin の呼び出しは createServiceRoleClient、コードの送信は captcha を免除される createServiceRoleAuthClient。
 */
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient, isCaptchaRejection } from '@/lib/auth/service-role-auth-client';
import { logAudit } from '@/lib/audit';
import { EmailCodeStartRequestSchema } from '@/features/auth/schemas/email-code';
import { formatZodError } from '@/features/auth/schemas/common';
import { getClientIp } from '@/lib/request-ip';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { applyReturnIntentCookie, issueReturnIntent } from '@/features/auth/return-intent/return-intent-service';
import { cookieOptionsForEmailCode, emailCodeSessionCookieName } from '@/lib/cookie';
import { createEmailCodeSessionToken, emailCodeSessionMaxAgeSeconds } from '@/features/auth/services/email-code-session';

/** `NextResponse.json` は試験の環境（`Response.json` が無い）で動かないので、パスキーの窓口と同じく本文を自分で組む。 */
function json(body: unknown, init: { status: number; headers?: Record<string, string> }): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status: init.status,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

const AUDIT_ACTION = 'auth.email_code.start';
const SEND_ENDPOINT = 'auth:email-code:send';
const UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

function classifyUpstream(
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
    const rl = await enforceRateLimit({ request, endpoint: SEND_ENDPOINT, limit: 50, windowSeconds: 600 });
    if (rl) return rl;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid request' }, { status: 400 });
    }
    const parsed = EmailCodeStartRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, turnstileToken } = parsed.data;

    const { verifyTurnstile } = await import('@/lib/turnstile');
    const turnstile = await verifyTurnstile(turnstileToken, getClientIp(request));
    if (!turnstile.ok) {
      await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'failure', detail: turnstile.error || 'turnstile_failed' });
      return json({ error: 'Bot detection failed' }, { status: 403 });
    }

    const rlAccount = await enforceRateLimit({ request, endpoint: SEND_ENDPOINT, limit: 5, windowSeconds: 600, subject: email });
    if (rlAccount) return rlAccount;

    // 登録の有無を調べずに作りにいく。登録済みの断り（email_exists）は握りつぶし、応答を同じにする。
    const admin = await createServiceRoleClient();
    const { error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { email_code_signup_pending: true },
    });
    if (createError) {
      const code = (createError as { code?: string }).code;
      if (code === 'email_address_invalid') {
        await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'failure', detail: 'email_address_invalid' });
        return json({ error: 'メールアドレスの形式が正しくありません。' }, { status: 400 });
      }
      if (code !== 'email_exists' && code !== 'user_already_exists') {
        await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'error', detail: 'supabase_create_user_failed' });
        return json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    const supabase = await createServiceRoleAuthClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });

    if (isCaptchaRejection(otpError)) {
      await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'error', detail: 'supabase_captcha_rejected' });
      return json({ error: 'Internal server error' }, { status: 500 });
    }
    const upstream = classifyUpstream(otpError);
    // GoTrue の宛先ごとの送信の間隔（429）は、直前に認証のメールを受けた既存のアドレスだけで起きる。
    // 429 のまま返すと未登録と見分けがつくので、成功と同じ応答にする（SEC-AUTH-048）。メールが届かない時は画面の再送（60秒後）で戻れる。
    // プロジェクト全体の送信の上限でも同じ 429 になるので、監査の符号とログで気付けるようにする。
    const throttled = upstream === 'rate_limited';
    if (throttled) {
      await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'error', detail: 'email_code_send_throttled' });
      console.error('email-code start: GoTrue rate limited the code mail (email_code_send_throttled)');
    }
    if (upstream === 'unavailable') {
      await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'error', detail: 'supabase_unavailable' });
      return json(
        { error: 'ただいま処理できません。時間をおいて再度お試しください。' },
        { status: 503, headers: { 'Retry-After': String(UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS) } },
      );
    }
    if (otpError && !throttled) {
      await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'error', detail: 'otp_send_failed' });
      return json({ error: '確認コードの送信に失敗しました。時間をおいて再度お試しください。' }, { status: 500 });
    }

    const res = json(
      { step: 'code', message: '確認コードを送信しました。メールに届いたコードを入力してください。' },
      { status: 202 },
    );
    res.cookies.set({
      name: emailCodeSessionCookieName,
      value: createEmailCodeSessionToken({ email }),
      ...cookieOptionsForEmailCode(emailCodeSessionMaxAgeSeconds),
    });

    // 戻り先が無い・不正・保存の失敗でも、前の試みの古い控えの Cookie を使わせないよう必ず消す側へ倒す。
    const { action } = await issueReturnIntent({ rawNext: parsed.data.next, purpose: 'login' });
    applyReturnIntentCookie(res, action);

    if (!throttled) {
      await logAudit({ action: AUDIT_ACTION, actor_email: email, outcome: 'code_sent' });
    }
    return res;
  } catch (err) {
    console.error('Email code start handler error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
}
