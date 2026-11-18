/**
 * パスキーのログインの終わり（src/app/api/auth/passkey/login/finish/route.ts）。
 * UV の門 → GoTrue の検証 → 店員は認めた鍵かの確かめ → アプリのセッションの結び付け、の順に進める。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-274
 * @design DD-AUTH-055
 * @remarks 順番: 回数の制限 → 本文の形（`id` と `rawId` の一致を含む）→ UV の門（ここまで GoTrue を呼ばない）→ GoTrue の検証 → 店員の確かめ → セッションの保存。
 * GoTrue の失敗は理由を分けず `passkey_login_failed`（鍵の有無の調べに使わせない）。ただし店員の印つきの拒否（403）と回数の制限（429）は別にする。
 * 店員が認めていない鍵で入った時は、GoTrue のセッションを `revoke_auth_session` で終わらせてから断る。判定の DB が使えない時も同じく終わらせて 503 で閉じる。
 */
import { NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { PasskeyLoginFinishSchema, dropNullFields } from '@/features/auth/schemas/passkey';
import { readAuthenticatorDataFlags } from '@/lib/auth/passkey-uv';
import { isCredentialApproved, isStaff } from '@/lib/auth/passkey-approval-rpc';
import { isStaffPasskeyRequiredError } from '@/lib/auth/staff-passkey-reject';
import { endAuthSession } from '@/lib/auth/passkey-auth-session-end';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { readGuestShoppingTokens } from '@/features/cart/services/guest-shopping-token';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';
import { applyReturnIntentCookie, issueReturnIntent } from '@/features/auth/return-intent/return-intent-service';
import { withNoStore } from '@/lib/http/no-store';

const AUDIT_ACTION = 'auth.passkey.login.finish';

function json(body: unknown, status: number): NextResponse {
  return withNoStore(
    new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

async function deny(detail: string, body: unknown, status: number, actorId?: string): Promise<NextResponse> {
  await logAudit({
    action: AUDIT_ACTION,
    outcome: 'failure',
    detail,
    ...(actorId ? { actor_id: actorId } : {}),
  });
  return json(body, status);
}

type GoTrueSession = { access_token: string; refresh_token: string };
type GoTrueUser = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: { role?: unknown };
};

function isSession(value: unknown): value is GoTrueSession {
  if (!value || typeof value !== 'object') return false;
  const { access_token, refresh_token } = value as Record<string, unknown>;
  return typeof access_token === 'string' && access_token.length > 0 && typeof refresh_token === 'string';
}

function isUser(value: unknown): value is GoTrueUser {
  if (!value || typeof value !== 'object') return false;
  const { id } = value as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const limited = await enforceRateLimit({
      request,
      endpoint: 'auth:passkey:login:finish',
      limit: 30,
      windowSeconds: 600,
    });
    if (limited) return limited;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return await deny('invalid_request', { error: 'invalid_request' }, 400);
    }
    const parsed = PasskeyLoginFinishSchema.safeParse(raw);
    if (!parsed.success) return await deny('invalid_request', { error: 'invalid_request' }, 400);
    const { challenge_id: challengeId, credential, next } = parsed.data;

    // UV の門。ここまで GoTrue を呼ばない（SEC-AUTH-044）。
    const flags = readAuthenticatorDataFlags(credential.response.authenticatorData);
    if (!flags || !flags.userVerified) return await deny('uv_required', { error: 'uv_required' }, 400);

    const supabase = await createPublicClient();
    const { data, error } = await supabase.auth.passkey.verifyAuthentication({
      challengeId,
      credential: dropNullFields(credential) as never,
    });

    if (error) {
      if (isStaffPasskeyRequiredError(error)) {
        return await deny('staff_passkey_required', { error: 'staff_passkey_required' }, 403);
      }
      if ((error as { status?: number }).status === 429) {
        return await deny('gotrue_rate_limited', { error: 'Too many requests' }, 429);
      }
      return await deny('gotrue_failed', { error: 'passkey_login_failed' }, 401);
    }

    const session: unknown = data?.session;
    const user: unknown = data?.user;
    if (!isSession(session) || !isUser(user)) {
      // 形が違う応答。セッションが作られていたら終わらせる。
      if (isSession(session)) await endAuthSession(session.access_token);
      return await deny('gotrue_bad_response', { error: 'passkey_login_failed' }, 401);
    }

    // 店員は、アプリの窓口で認めた鍵だけで入れる。`rawId`（GoTrue が鍵を引く値と同じ）で引く（SEC-AUTH-044）。
    const staff = await isStaff(user.id);
    if (!staff.ok) {
      await endAuthSession(session.access_token);
      return await deny('staff_check_unavailable', { error: 'passkey_login_unavailable' }, 503, user.id);
    }
    if (staff.value) {
      const approved = await isCredentialApproved(user.id, credential.rawId);
      if (!approved.ok) {
        await endAuthSession(session.access_token);
        return await deny('approval_check_unavailable', { error: 'passkey_login_unavailable' }, 503, user.id);
      }
      if (!approved.value) {
        await endAuthSession(session.access_token);
        return await deny('passkey_not_approved', { error: 'passkey_not_approved' }, 403, user.id);
      }
    }

    const rawRole = user.app_metadata?.role;
    const role = rawRole === 'admin' || rawRole === 'supporter' ? rawRole : 'user';
    const res = json({ user: { id: user.id, email: user.email ?? null, role } }, 200);

    const persist = await persistSessionAndCookies(
      res,
      session as never,
      user as never,
      readGuestShoppingTokens(request.headers.get('cookie')),
    );
    if (!persist?.ok) {
      await logAudit({
        action: AUDIT_ACTION,
        outcome: 'error',
        detail: 'session_persist_failed',
        actor_id: user.id,
      });
      return json({ error: 'ログイン処理に失敗しました。' }, 500);
    }

    if (user.email) {
      await linkGuestOrdersByEmail({
        userId: user.id,
        email: user.email,
        emailConfirmedAt: user.email_confirmed_at ?? null,
      });
    }

    const intent = await issueReturnIntent({ rawNext: next, purpose: 'login' });
    applyReturnIntentCookie(res, intent.action);

    await logAudit({ action: AUDIT_ACTION, outcome: 'success', detail: 'passkey_login', actor_id: user.id });
    return res;
  } catch {
    console.error('passkey login finish handler error');
    return await deny('unexpected_error', { error: 'Internal server error' }, 500);
  }
}
