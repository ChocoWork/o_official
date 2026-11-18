/**
 * 店長が店員をお客さんに戻す窓口（`POST /api/admin/staff/[id]/demote`）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-364
 * @design DD-AUTH-077
 * @remarks 降格は `staff_demote`（開いている招待も取り消す）で行い、`admin_set_user_role` の `user` への変更は使わない（そちらは招待を取り消さない）。降格の後は、その人のログインを全部終わらせる。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { demoteStaff } from '@/features/auth/staff/staff-invite-store';
import {
  auditStaffAction,
  guardStaffAdminRequest,
  staffInviteReasonResponse,
} from '@/features/auth/staff/staff-invite-http';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { createServiceRoleClient } from '@/lib/supabase/server';

const idSchema = z.string().uuid().transform((value) => value.toLowerCase());
const RATE_LIMIT = { endpoint: 'admin:staff:demote', limit: 20, windowSeconds: 600 } as const;

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
      await auditStaffAction(request, guard, { action: 'admin.staff.demote', resourceId: null, outcome: 'failure', detail: 'Invalid request' });
      return withNoStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
    }
    const userId = id.data;

    const service = await createServiceRoleClient();
    const demoted = await demoteStaff(service, guard.actorId, userId);
    if (!demoted.ok) {
      await auditStaffAction(request, guard, {
        action: 'admin.staff.demote', resourceId: userId, outcome: demoted.reason === 'last_admin' ? 'conflict' : 'failure',
        detail: 'Staff demote refused', metadata: { result_code: demoted.reason },
      });
      return staffInviteReasonResponse(demoted.reason);
    }
    try {
      await revokeAllSessionsForUser(userId);
    } catch {
      console.error('[admin.staff] demote session revocation failed');
      await auditStaffAction(request, guard, { action: 'admin.staff.demote', resourceId: userId, outcome: 'error', detail: 'session_revocation_failed' });
      return staffInviteReasonResponse('revoke_failed');
    }
    await auditStaffAction(request, guard, { action: 'admin.staff.demote', resourceId: userId, outcome: 'success', detail: 'Staff demoted' });
    return withNoStore(NextResponse.json({ success: true }, { status: 200 }));
  } catch {
    console.error('[admin.staff] demote failed');
    return staffInviteReasonResponse('failed');
  }
}
