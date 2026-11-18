/**
 * 店員の招待のリンクの受け口（src/app/api/auth/staff/invite/start/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-369
 * @design DD-AUTH-078
 * @remarks 案 B。順番: 回数（IP）→ 本文の形 → 回数（合言葉のハッシュ）→ 合言葉の消費 → お客さんの扱いのままセッションを作る →
 * その `session_id` に結んで窓を開ける → アプリの結び付けを書く。Origin は `src/proxy.ts` が `/api` の POST すべてで確かめる。
 * 無い・期限切れ・使用済み・取り消しは同じ 400 `invite_invalid`。消費した後の失敗は、作ったセッションを終わらせ、招待は使用済みのまま 500 にする
 * （同じ合言葉で繰り返せると、窓が開いたまま残る道ができる）。応答は no-store。合言葉は監査にも残さない。
 */
import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { hashInviteToken } from '@/features/auth/staff/invite-token';
import { bindStaffInviteWindow, consumeStaffInvite } from '@/features/auth/staff/staff-invite-store';
import { createInviteSession } from '@/features/auth/staff/staff-invite-session';
import { readAuthSessionId } from '@/lib/auth/app-session';
import { endAuthSession } from '@/lib/auth/passkey-auth-session-end';
import { withNoStore } from '@/lib/http/no-store';
import { createServiceRoleClient } from '@/lib/supabase/server';

const AUDIT_ACTION = 'auth.staff.invite.start';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function json(body: unknown, status: number): NextResponse {
  return withNoStore(
    new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

async function deny(detail: string, body: unknown, status: number, actorId?: string): Promise<NextResponse> {
  await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail, ...(actorId ? { actor_id: actorId } : {}) });
  return json(body, status);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const limited = await enforceRateLimit({
      request,
      endpoint: 'auth:staff:invite:start',
      limit: 20,
      windowSeconds: 600,
    });
    if (limited) return limited;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return await deny('invalid_request', { error: 'invite_invalid' }, 400);
    }
    const token = (raw as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      return await deny('invite_invalid', { error: 'invite_invalid' }, 400);
    }

    const tokenKey = Buffer.from(hashInviteToken(token)).toString('hex');
    const limitedByToken = await enforceRateLimit({
      request,
      endpoint: 'auth:staff:invite:start:token',
      limit: 5,
      windowSeconds: 600,
      subject: tokenKey,
    });
    if (limitedByToken) return limitedByToken;

    const service = await createServiceRoleClient();
    const consumed = await consumeStaffInvite({ rpc: (name, args) => service.rpc(name, args) }, token);
    if (!consumed.ok) return await deny('invite_invalid', { error: 'invite_invalid' }, 400);
    const { inviteId, userId } = consumed.value;

    // ここから先の失敗は、招待を使用済みのまま 500 にする。
    const failed = async (detail: string, accessToken?: string): Promise<NextResponse> => {
      if (accessToken) await endAuthSession(accessToken);
      return await deny(detail, { error: 'invite_start_failed' }, 500, userId);
    };

    const created = await createInviteSession(userId);
    if (!created) return await failed('session_create_failed');
    const { session, user } = created;

    const sessionId = readAuthSessionId(session.access_token);
    if (!sessionId) return await failed('session_id_missing', session.access_token);

    const bound = await bindStaffInviteWindow({ rpc: (name, args) => service.rpc(name, args) }, inviteId, sessionId);
    if (!bound.ok) return await failed('window_bind_failed', session.access_token);

    const res = json({ redirectTo: '/staff/register' }, 200);
    const persist = await persistSessionAndCookies(res, session as never, user as never);
    if (!persist?.ok) return await failed('session_persist_failed', session.access_token);

    await logAudit({ action: AUDIT_ACTION, outcome: 'success', detail: 'window_opened', actor_id: userId });
    return res;
  } catch {
    console.error('staff invite start handler error');
    return await deny('unexpected_error', { error: 'invite_start_failed' }, 500);
  }
}
