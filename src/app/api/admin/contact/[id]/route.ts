import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';

const updateStatusSchema = z.object({
  status: z.enum(['open', 'pending', 'answered', 'closed']),
});

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
        'id, created_at, updated_at, last_message_at, name, email, inquiry_type, subject, message, status, order_id, user_id, submitted_ip, user_agent'
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

    const parsed = updateStatusSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const service = await createServiceRoleClient();

    const { error } = await service
      .from('contact_inquiries')
      .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      console.error('Failed to update inquiry status:', error);
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
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
