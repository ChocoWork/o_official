import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const createTemplateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.enum(['product', 'order', 'other', 'general']).nullable().optional(),
  body: z.string().trim().min(1).max(5000),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.contact.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const service = await createServiceRoleClient();

    const { data, error } = await service
      .from('contact_reply_templates')
      .select('id, title, category, body, sort_order, created_at, updated_at')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Failed to fetch reply templates:', error);
      return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 });
    }

    return NextResponse.json({ data: data ?? [] }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/contact/templates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.contact.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const parsed = createTemplateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const service = await createServiceRoleClient();

    const { data, error } = await service
      .from('contact_reply_templates')
      .insert([
        {
          title: parsed.data.title,
          category: parsed.data.category ?? null,
          body: parsed.data.body,
          sort_order: parsed.data.sortOrder ?? 0,
        },
      ])
      .select('id')
      .single();

    if (error || !data) {
      console.error('Failed to create reply template:', error);
      return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.contact.template.create',
      actor_id: authz.userId,
      resource: 'contact_reply_template',
      resource_id: data.id,
      outcome: 'success',
      detail: 'created',
      user_agent: request.headers.get('user-agent'),
    });

    return NextResponse.json({ success: true, id: data.id }, { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/contact/templates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
