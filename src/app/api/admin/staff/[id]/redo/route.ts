/**
 * 店長が店員のパスキーを全部消して登録をやり直させる窓口（`POST /api/admin/staff/[id]/redo`）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-363
 * @design DD-AUTH-076
 * @remarks 取り返しがつかないので、確認の語と理由（10〜500字）を求める（ADR-0471）。監査には理由の文を残さず、長さ（`reason_length`）だけを残す（SEC-ADMIN-008）。自分自身・最後の店長は DB が断る。今の役割は発行の前に読んで控え、役割が無い人（店員でない人）は DB の発行を呼ばずに 409 `not_staff` で断る。監査には理由の長さだけを残す。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { issueAndSendStaffInvite } from '@/features/auth/staff/staff-invite-send';
import {
  auditStaffAction,
  guardStaffAdminRequest,
  staffInviteReasonResponse,
} from '@/features/auth/staff/staff-invite-http';
import { createServiceRoleClient } from '@/lib/supabase/server';

const bodySchema = z.object({
  confirm: z.literal('やり直し'),
  reason: z.string().trim().min(10).max(500),
});
const idSchema = z.string().uuid().transform((value) => value.toLowerCase());

const RATE_LIMIT = { endpoint: 'admin:staff:redo', limit: 10, windowSeconds: 600 } as const;

function withNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function readRoleCode(row: unknown): string | null {
  const roles = (row as { roles?: unknown } | null)?.roles;
  const role = Array.isArray(roles) ? roles[0] : roles;
  const code = (role as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const guard = await guardStaffAdminRequest(request, RATE_LIMIT);
    if (!guard.ok) return guard.response;
    const audit = (
      outcome: 'success' | 'failure' | 'error' | 'conflict',
      detail: string,
      resourceId: string | null,
      metadata?: Record<string, unknown>,
    ) => auditStaffAction(request, guard, { action: 'admin.staff.redo', resourceId, outcome, detail, metadata });

    const id = idSchema.safeParse((await context.params).id);
    const body = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!id.success || !body.success) {
      await audit('failure', 'Invalid request', null);
      return withNoStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
    }
    const userId = id.data;
    const reasonLength = { reason_length: body.data.reason.length };
    if (userId === guard.actorId) {
      await audit('failure', 'Self redo refused', userId, reasonLength);
      return staffInviteReasonResponse('self');
    }

    const service = await createServiceRoleClient();
    const { data: target, error: targetError } = await service.auth.admin.getUserById(userId);
    if (targetError || !target?.user) {
      await audit('failure', 'Target user not found', userId, reasonLength);
      return staffInviteReasonResponse('not_found');
    }
    const { data: roleRows, error: roleError } = await service
      .from('user_roles')
      .select('roles!inner(code)')
      .eq('user_id', userId)
      .eq('active', true)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    if (roleError) {
      await audit('error', 'role_lookup_failed', userId, reasonLength);
      return staffInviteReasonResponse('failed');
    }
    const codes = (Array.isArray(roleRows) ? roleRows : []).map(readRoleCode);
    const role = codes.includes('admin') ? 'admin' : codes.includes('supporter') ? 'supporter' : null;
    const email = target.user.email;
    if (!role || !email) {
      await audit('conflict', 'Target is not staff', userId, reasonLength);
      return staffInviteReasonResponse('not_staff');
    }

    const result = await issueAndSendStaffInvite(service, {
      userId, email, role, kind: 'redo', issuedBy: guard.actorId, reason: body.data.reason, hadPasskeys: true,
    });
    if (!result.ok) {
      await audit(result.reason === 'last_admin' ? 'conflict' : 'failure', 'Staff redo refused', userId, {
        ...reasonLength, result_code: result.reason,
      });
      return staffInviteReasonResponse(result.reason);
    }
    await audit('success', 'Staff redo invite sent', userId, reasonLength);
    return withNoStore(NextResponse.json({ success: true }, { status: 200 }));
  } catch {
    console.error('[admin.staff] redo failed');
    return staffInviteReasonResponse('failed');
  }
}
