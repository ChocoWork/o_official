import 'server-only';

import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { getClientIp } from '@/lib/request-ip';

export type StaffInviteHttpReason =
  | 'forbidden'
  | 'not_found'
  | 'last_admin'
  | 'self'
  | 'already_staff'
  | 'not_staff'
  | 'config'
  | 'revoke_failed'
  | 'mail_failed'
  | 'failed';

const REFUSALS: Readonly<Record<StaffInviteHttpReason, { status: number; error: string }>> = {
  forbidden: { status: 403, error: 'Forbidden' },
  not_found: { status: 404, error: 'User not found' },
  last_admin: { status: 409, error: '店長を1人以上残してください。' },
  self: { status: 403, error: '自分自身の役割は変更できません。' },
  already_staff: {
    status: 409,
    error: 'すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください。',
  },
  not_staff: { status: 409, error: '店員ではありません。' },
  config: { status: 503, error: 'メールを送る設定が整っていません。しばらくしてからお試しください。' },
  revoke_failed: { status: 500, error: '処理を完了できませんでした。もう一度、招待を出してください。' },
  mail_failed: { status: 502, error: 'メールを送れませんでした。もう一度、招待を出してください。' },
  failed: { status: 500, error: 'Internal server error' },
};

/**
 * 招待まわりの失敗の理由を、窓口の応答（`no-store`）にする。理由は `staff-invite-store` の理由と、送りの失敗の写し。
 *
 * @impl IMPL-AUTH-359
 * @design DD-AUTH-076
 */
export function staffInviteReasonResponse(reason: StaffInviteHttpReason): Response {
  const { status, error } = REFUSALS[reason];
  return withNoStore(NextResponse.json({ error, code: reason }, { status }));
}

function withNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * 店長の窓口の入口の確かめ。権限 `admin.users.manage` → CSRF → IP と店長ごとの回数の順。通れば操作者を返す。
 *
 * @impl IMPL-AUTH-360
 * @design DD-AUTH-076
 * @remarks どの拒否も `no-store` にして返す。回数の枠の名前は窓口ごとに呼び手が決める。
 */
export async function guardStaffAdminRequest(
  request: Request,
  rateLimit: { endpoint: string; limit: number; windowSeconds: number },
): Promise<{ ok: true; actorId: string; actorEmail: string | null } | { ok: false; response: Response }> {
  const authz = await authorizeAdminPermission('admin.users.manage', request);
  if (!authz.ok) return { ok: false, response: withNoStore(authz.response) };
  const csrf = await requireCsrfOrDeny();
  if (csrf instanceof Response) return { ok: false, response: withNoStore(csrf) };
  const ipLimited = await enforceRateLimit({ request, ...rateLimit });
  if (ipLimited) return { ok: false, response: withNoStore(ipLimited) };
  const actorLimited = await enforceRateLimit({ request, ...rateLimit, subject: authz.userId });
  if (actorLimited) return { ok: false, response: withNoStore(actorLimited) };
  return { ok: true, actorId: authz.userId, actorEmail: authz.actorEmail };
}

/**
 * 店長の窓口の監査を1行書く。書けなくても操作は止めない。詳細は固定の短い文と理由の長さだけで、理由の本文・メール・合言葉は載せない。
 *
 * @impl IMPL-AUTH-361
 * @design DD-AUTH-076
 */
export async function auditStaffAction(
  request: Request,
  actor: { actorId: string; actorEmail: string | null },
  event: { action: string; resourceId: string | null; outcome: 'success' | 'failure' | 'error' | 'conflict'; detail: string; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    await logAudit({
      action: event.action,
      actor_id: actor.actorId,
      actor_email: actor.actorEmail,
      resource: 'users',
      resource_id: event.resourceId,
      outcome: event.outcome,
      detail: event.detail,
      ip: getClientIp(request),
      user_agent: request.headers.get('user-agent') ?? null,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
  } catch {
    console.error('[admin.staff] audit failed');
  }
}
