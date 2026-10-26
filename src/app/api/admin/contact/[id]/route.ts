/**
 * 問い合わせ1件とやり取りの取得、および状態の変更を管理者に提供する窓口（src/app/api/admin/contact/[id]/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-122
 * @design DD-ADMIN-007
 * @remarks 問い合わせの表は直接の読み書きを断っているので、権限を確かめた後に service role で扱う。読む権限と変える権限を分け、状態の変更と、1件を開いたことを監査に残す。読んだ記録には名前・メール・本文・件名を入れず、記録に失敗しても読み出しは止めない。詳細に返さない送信元の IP とブラウザ（submitted_ip・user_agent）は列ごと選ばない。状態は表の CHECK と同じ4つの値だけを入口で受ける。変更は管理者単位で、テンプレートの書き込みと合わせて10分に60回までに絞る。id が UUID でない・変えた行が0行の時は、成功と返さず404にして、失敗を監査に残す。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit, type AuditEvent } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

const updateStatusSchema = z.object({
  status: z.enum(['open', 'pending', 'answered', 'closed']),
});

const CONTACT_WRITE_RATE_LIMIT = { endpoint: 'admin:contact:write', limit: 60, windowSeconds: 600 } as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 読み出しの記録に失敗しても読み出しは止めない。誤りの文は残さず固定の文だけを出す。 */
async function auditReadSafely(event: AuditEvent): Promise<void> {
  try {
    await logAudit(event);
  } catch {
    console.error('Failed to write contact read audit');
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.contact.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const service = await createServiceRoleClient();

    const { data: inquiry, error: inquiryError } = await service
      .from('contact_inquiries')
      .select(
        'id, created_at, updated_at, last_message_at, name, email, inquiry_type, subject, message, status, order_id, user_id'
      )
      .eq('id', id)
      .single();

    if (inquiryError || !inquiry) {
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
    }

    const { data: messages, error: messagesError } = await service
      .from('contact_messages')
      .select('id, sender_role, author_id, body, channel, created_at')
      .eq('inquiry_id', id)
      .order('created_at', { ascending: true });

    if (messagesError) {
      console.error('Failed to fetch contact messages:', messagesError);
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
    }

    const orderNumber = inquiry.order_id ? toOrderNumber(inquiry.order_id) : null;

    await auditReadSafely({
      action: 'admin.contact.read',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'contact',
      resource_id: id,
      outcome: 'success',
    });

    return NextResponse.json(
      { data: { ...inquiry, orderNumber, messages: messages ?? [] } },
      { status: 200 }
    );
  } catch (error) {
    console.error('GET /api/admin/contact/[id] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.contact.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const limited = await enforceRateLimit({ request, ...CONTACT_WRITE_RATE_LIMIT, subject: authz.userId });
    if (limited) {
      return limited;
    }

    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
    }

    const parsed = updateStatusSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const service = await createServiceRoleClient();

    const { data: updated, error } = await service
      .from('contact_inquiries')
      .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');

    if (error) {
      console.error('Failed to update inquiry status:', error);
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    if (!updated || updated.length === 0) {
      await logAudit({
        action: 'admin.contact.status_update',
        actor_id: authz.userId,
        resource: 'contact',
        resource_id: id,
        outcome: 'failure',
        detail: 'inquiry_not_found',
        user_agent: request.headers.get('user-agent'),
      });
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
    }

    await logAudit({
      action: 'admin.contact.status_update',
      actor_id: authz.userId,
      resource: 'contact',
      resource_id: id,
      outcome: 'success',
      detail: `status=${parsed.data.status}`,
      user_agent: request.headers.get('user-agent'),
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/contact/[id] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
