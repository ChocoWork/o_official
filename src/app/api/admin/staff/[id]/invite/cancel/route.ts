/**
 * 店長が出した招待を取り消す窓口（`POST /api/admin/staff/[id]/invite/cancel`）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-365
 * @design DD-AUTH-077
 * @remarks 取り消すと同じ合言葉は使えなくなり、開いていた窓も閉じる。招待のセッションが残らないよう、その人のログインも全部終わらせる。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cancelStaffInvite } from '@/features/auth/staff/staff-invite-store';
import {
  auditStaffAction,
  guardStaffAdminRequest,
  staffInviteReasonResponse,
} from '@/features/auth/staff/staff-invite-http';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { createServiceRoleClient } from '@/lib/supabase/server';

const idSchema = z.string().uuid().transform((value) => value.toLowerCase());
const RATE_LIMIT = { endpoint: 'admin:staff:invite-cancel', limit: 20, windowSeconds: 600 } as const;

function withNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const guard = await guardStaffAdminRequest(request, RATE_LIMIT);
    if (!guard.ok) return guard.response;
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) {
      await auditStaffAction(request, guard, { action: 'admin.staff.invite_cancel', resourceId: null, outcome: 'failure', detail: 'Invalid request' });
      return withNoStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
    }
    const userId = id.data;

    const service = await createServiceRoleClient();
    const cancelled = await cancelStaffInvite(service, guard.actorId, userId);
    if (!cancelled.ok) {
      await auditStaffAction(request, guard, {
        action: 'admin.staff.invite_cancel', resourceId: userId, outcome: 'failure',
        detail: 'Staff invite cancel refused', metadata: { result_code: cancelled.reason },
      });
      return staffInviteReasonResponse(cancelled.reason);
    }
    try {
      await revokeAllSessionsForUser(userId);
    } catch {
      console.error('[admin.staff] cancel session revocation failed');
      await auditStaffAction(request, guard, { action: 'admin.staff.invite_cancel', resourceId: userId, outcome: 'error', detail: 'session_revocation_failed' });
      return staffInviteReasonResponse('revoke_failed');
    }
    await auditStaffAction(request, guard, { action: 'admin.staff.invite_cancel', resourceId: userId, outcome: 'success', detail: 'Staff invite cancelled' });
    return withNoStore(NextResponse.json({ success: true }, { status: 200 }));
  } catch {
    console.error('[admin.staff] invite cancel failed');
    return staffInviteReasonResponse('failed');
  }
}
