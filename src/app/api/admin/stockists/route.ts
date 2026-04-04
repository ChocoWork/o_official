import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';

const stockistTypeSchema = z.enum(['FLAGSHIP STORE', 'STORE', 'SELECT SHOP']);
const stockistStatusSchema = z.enum(['private', 'published']);

const createStockistSchema = z.object({
  type: stockistTypeSchema,
  name: z.string().trim().min(1).max(255),
  address: z.string().trim().min(1).max(500),
  phone: z.string().trim().min(1).max(50),
  time: z.string().trim().min(1).max(120),
  holiday: z.string().trim().min(1).max(120),
  status: stockistStatusSchema,
});

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.stockists.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('stockists')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      console.error('Failed to fetch stockists:', error);
      return NextResponse.json({ error: 'Failed to fetch stockists' }, { status: 500 });
    }

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/stockists error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.stockists.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const body = await request.json();
    const parsed = createStockistSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('stockists')
      .insert([
        {
          type: parsed.data.type,
          name: parsed.data.name,
          address: parsed.data.address,
          phone: parsed.data.phone,
          time: parsed.data.time,
          holiday: parsed.data.holiday,
          status: parsed.data.status,
        },
      ])
      .select('id')
      .single();

    if (error) {
      console.error('Failed to create stockist:', error);
      return NextResponse.json({ error: 'Failed to save stockist' }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: data.id }, { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/stockists error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
