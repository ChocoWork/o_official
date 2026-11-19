/**
 * 店長が店員を招待する窓口（`POST /api/admin/staff/invites`）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-362
 * @design DD-AUTH-076
 * @remarks アカウントがお客さんとして既にあっても無くても応答を同じ `{ success: true }` にし、あるかどうかを返さない。今の有効な店員は 409 `already_staff` で断り（確認の語と理由が要るやり直しの守りを迂回させない）、鍵は何も消さない。既に鍵を持つ人への招待は、削除の知らせの代わりにメールの冒頭で知らせる。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findAuthUserIdByEmail } from '@/features/auth/services/auth-admin-user';
import { isStaffInviteMailReady, issueAndSendStaffInvite } from '@/features/auth/staff/staff-invite-send';
import {
  auditStaffAction,
  guardStaffAdminRequest,
  staffInviteReasonResponse,
} from '@/features/auth/staff/staff-invite-http';
import { createServiceRoleClient } from '@/lib/supabase/server';

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['admin', 'supporter']),
});

const RATE_LIMIT = { endpoint: 'admin:staff:invite', limit: 20, windowSeconds: 600 } as const;

function withNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const guard = await guardStaffAdminRequest(request, RATE_LIMIT);
    if (!guard.ok) return guard.response;
    const audit = (
      outcome: 'success' | 'failure' | 'error' | 'conflict',
      detail: string,
      resourceId: string | null,
      metadata?: Record<string, unknown>,
    ) => auditStaffAction(request, guard, { action: 'admin.staff.invite', resourceId, outcome, detail, metadata });

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      await audit('failure', 'Invalid request body', null);
      return withNoStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
    }
    const { email, role } = parsed.data;

    // 送れない設定のままアカウントだけを作らないよう、createUser より前に確かめる。
    if (!isStaffInviteMailReady()) {
      await audit('failure', 'mail_config_invalid', null);
      return staffInviteReasonResponse('config');
    }

    const service = await createServiceRoleClient();
    let userId: string;
    let hadPasskeys = false;
    const lookup = await findAuthUserIdByEmail(service, email);
    if (lookup.status === 'error') {
      await audit('error', 'user_lookup_failed', null);
      return staffInviteReasonResponse('failed');
    }
    if (lookup.status === 'found') {
      userId = lookup.userId;
      // 既存の鍵を消すことをメールで知らせるため、発行の前に有無を読む。読めない時は知らせる側に倒す。
      const listed = await service.auth.admin.passkey.listPasskeys({ userId }).catch(() => null);
      hadPasskeys = !listed || listed.error !== null || !Array.isArray(listed.data) || listed.data.length > 0;
    } else {
      const created = await service.auth.admin.createUser({ email, email_confirm: true });
      if (created.error || !created.data?.user?.id) {
        console.error('POST /api/admin/staff/invites create user failed');
        await audit('error', 'create_user_failed', null);
        return staffInviteReasonResponse('failed');
      }
      userId = created.data.user.id;
    }

    const result = await issueAndSendStaffInvite(service, {
      userId, email, role, kind: 'invite', issuedBy: guard.actorId, reason: null, hadPasskeys,
    });
    if (!result.ok) {
      await audit(result.reason === 'already_staff' ? 'conflict' : 'failure', 'Staff invite refused', userId, {
        requested_role: role, result_code: result.reason,
      });
      return staffInviteReasonResponse(result.reason);
    }
    await audit('success', 'Staff invite sent', userId, { requested_role: role });
    return withNoStore(NextResponse.json({ success: true }, { status: 200 }));
  } catch {
    console.error('[admin.staff] invite failed');
    return staffInviteReasonResponse('failed');
  }
}
