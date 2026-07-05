import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const updateTemplateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.enum(['product', 'order', 'other', 'general']).nullable().optional(),
  body: z.string().trim().min(1).max(5000),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.contact.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const parsed = updateTemplateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const service = await createServiceRoleClient();

    const { error } = await service
      .from('contact_reply_templates')
      .update({
        title: parsed.data.title,
        category: parsed.data.category ?? null,
        body: parsed.data.body,
        ...(parsed.data.sortOrder !== undefined ? { sort_order: parsed.data.sortOrder } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      console.error('Failed to update reply template:', error);
      return NextResponse.json({ error: 'Failed to update template' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.contact.template.update',
      actor_id: authz.userId,
      resource: 'contact_reply_template',
      resource_id: id,
      outcome: 'success',
      detail: 'updated',
      user_agent: request.headers.get('user-agent'),
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PUT /api/admin/contact/templates/[id] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.contact.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const service = await createServiceRoleClient();

    const { error } = await service.from('contact_reply_templates').delete().eq('id', id);

    if (error) {
      console.error('Failed to delete reply template:', error);
      return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.contact.template.delete',
      actor_id: authz.userId,
      resource: 'contact_reply_template',
      resource_id: id,
      outcome: 'success',
      detail: 'deleted',
      user_agent: request.headers.get('user-agent'),
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/contact/templates/[id] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
