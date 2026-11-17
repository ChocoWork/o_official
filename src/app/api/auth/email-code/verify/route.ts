/**
 * メールのコードの確定の窓口。コードを確かめ、通ったらセッションを確定する（src/app/api/auth/email-code/verify/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-299
 * @design DD-AUTH-059
 * @remarks 宛先は保留の Cookie だけから取る（本文の email は読まない）。Cookie が無ければ 401。
 * 総当たりの枠は保留の Cookie ごと（`email:jti`、5回/10分）と宛先ごとの緩い上限（20回/10分）の2段。数えてから確かめる（6回目で 429）。
 * 使い切ったら保留の Cookie を消す。店員はフックが拒否する（403 `staff_passkey_required`。セッションも Cookie も作らない）。
 * 成功で印 `email_code_signup_pending` を外す（失敗は監査の符号だけで続行）。`offerPasskey` は role が user で、鍵の一覧が成功して0本の時だけ true（閉じる側に倒す）。
 */
import { NextResponse } from 'next/server';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { OtpVerifyRequestSchema } from '@/features/auth/schemas/otp';
import { formatZodError } from '@/features/auth/schemas/common';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';
import { clearCookieOptions, emailCodeSessionCookieName } from '@/lib/cookie';
import { readEmailCodeSessionFromCookieHeader } from '@/features/auth/services/email-code-session';
import { isStaffPasskeyRequiredError } from '@/lib/auth/staff-passkey-reject';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { readGuestShoppingTokens } from '@/features/cart/services/guest-shopping-token';
import { listPasskeys } from '@/lib/auth/passkey-gotrue';

/** `NextResponse.json` は試験の環境（`Response.json` が無い）で動かないので、パスキーの窓口と同じく本文を自分で組む。 */
function json(body: unknown, init: { status: number; headers?: Record<string, string> }): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status: init.status,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

const AUDIT_ACTION = 'auth.email_code.verify';
const VERIFY_ENDPOINT = 'auth:email-code:verify';

function clearPending(res: NextResponse) {
  res.cookies.set({ name: emailCodeSessionCookieName, value: '', ...clearCookieOptions() });
}

/** enforceRateLimit の 429 を、保留の Cookie を消した新しい応答にして返す（返り値を書き換えない）。 */
function limitedAndClosed(limited: Response): NextResponse {
  const res = json({ error: 'Too many requests' }, { status: 429 });
  const retryAfter = limited.headers.get('Retry-After');
  if (retryAfter) res.headers.set('Retry-After', retryAfter);
  clearPending(res);
  return res;
}

async function readOfferPasskey(accessToken: string, role: string): Promise<boolean> {
  if (role !== 'user') return false;
  try {
    const list = await listPasskeys(accessToken);
    return list.ok && Array.isArray(list.data) && list.data.length === 0;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const rl = await enforceRateLimit({ request, endpoint: VERIFY_ENDPOINT, limit: 30, windowSeconds: 600 });
    if (rl) return rl;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid request' }, { status: 400 });
    }
    const parsed = OtpVerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(formatZodError(parsed.error), { status: 400 });
    }
    const { code } = parsed.data;

    const pending = readEmailCodeSessionFromCookieHeader(request.headers.get('cookie'));
    if (!pending) {
      await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail: 'missing_or_invalid_pending_session' });
      return json({ error: 'セッションの有効期限が切れました。もう一度メールアドレスを入力してください。' }, { status: 401 });
    }

    // subject は必ず Cookie 由来。Cookie ごと（別の Cookie の失敗が本人の枠を使わない）→ 宛先ごとの緩い上限。
    const rlCookie = await enforceRateLimit({
      request,
      endpoint: VERIFY_ENDPOINT,
      limit: 5,
      windowSeconds: 600,
      subject: `${pending.email}:${pending.jti}`,
    });
    const rlEmail = rlCookie
      ? undefined
      : await enforceRateLimit({ request, endpoint: VERIFY_ENDPOINT, limit: 20, windowSeconds: 600, subject: pending.email });
    const limited = rlCookie ?? rlEmail;
    if (limited) {
      await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'failure', detail: 'account_rate_limited' });
      return limitedAndClosed(limited);
    }

    const supabase = await createPublicClient();
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      email: pending.email,
      token: code,
      type: 'email',
    });

    if (verifyError && isStaffPasskeyRequiredError(verifyError)) {
      await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'failure', detail: 'staff_passkey_required' });
      const denied = json({ error: 'staff_passkey_required' }, { status: 403 });
      clearPending(denied);
      return denied;
    }

    if (verifyError || !data?.session || !data.user) {
      await logAudit({ action: AUDIT_ACTION, actor_email: pending.email, outcome: 'failure', detail: 'invalid_or_expired_otp' });
      return json({ error: '認証コードが無効、または期限切れです。' }, { status: 401 });
    }

    const rawRole = data.user.app_metadata?.role;
    const role = rawRole === 'admin' || rawRole === 'supporter' ? rawRole : 'user';
    const offerPasskey = await readOfferPasskey(data.session.access_token, role);

    const res = json(
      {
        user: { id: data.user.id, email: data.user.email ?? pending.email, role },
        offerPasskey,
        message: '認証に成功しました。',
      },
      { status: 200 },
    );
    clearPending(res);

    const persistResult = await persistSessionAndCookies(res, data.session, data.user, readGuestShoppingTokens(request.headers.get('cookie')));
    if (!persistResult?.ok) {
      await logAudit({
        action: AUDIT_ACTION,
        actor_email: data.user.email ?? pending.email,
        outcome: 'error',
        detail: `session_persist_failed: ${persistResult?.error || 'unknown'}`,
        resource_id: data.user.id,
      });
      return json({ error: 'ログイン処理に失敗しました。' }, { status: 500 });
    }

    // 新規の印を外す。外す失敗でもログインは成功のまま（監査の符号だけ残す）。
    if (data.user.app_metadata?.email_code_signup_pending) {
      try {
        const admin = await createServiceRoleClient();
        const { error: markError } = await admin.auth.admin.updateUserById(data.user.id, {
          app_metadata: { email_code_signup_pending: null },
        });
        if (markError) {
          await logAudit({ action: AUDIT_ACTION, outcome: 'error', detail: 'signup_mark_clear_failed', resource_id: data.user.id });
        }
      } catch {
        await logAudit({ action: AUDIT_ACTION, outcome: 'error', detail: 'signup_mark_clear_failed', resource_id: data.user.id });
      }
    }

    await linkGuestOrdersByEmail({
      userId: data.user.id,
      email: data.user.email ?? pending.email,
      emailConfirmedAt: data.user.email_confirmed_at ?? null,
    });

    await logAudit({
      action: AUDIT_ACTION,
      actor_email: data.user.email ?? pending.email,
      outcome: 'success',
      detail: 'verified_type:email',
      resource_id: data.user.id,
    });

    return res;
  } catch (err) {
    console.error('Email code verify handler error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
}
