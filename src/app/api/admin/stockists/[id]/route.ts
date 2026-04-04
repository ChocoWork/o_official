import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';

const stockistTypeSchema = z.enum(['FLAGSHIP STORE', 'STORE', 'SELECT SHOP']);
const stockistStatusSchema = z.enum(['private', 'published']);

const updateStockistSchema = z.object({
  type: stockistTypeSchema,
  name: z.string().trim().min(1).max(255),
  address: z.string().trim().min(1).max(500),
  phone: z.string().trim().min(1).max(50),
  time: z.string().trim().min(1).max(120),
  holiday: z.string().trim().min(1).max(120),
  status: stockistStatusSchema,
});

const patchStatusSchema = z.object({
  status: stockistStatusSchema,
});

function parseStockistId(id: string): number | null {
  const parsedId = Number(id);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    return null;
  }

  return parsedId;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const stockistId = parseStockistId(id);
    if (!stockistId) {
      return NextResponse.json({ error: 'Invalid stockist id' }, { status: 400 });
    }

    const authz = await authorizeAdminPermission('admin.stockists.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('stockists')
      .select('*')
      .eq('id', stockistId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Stockist not found' }, { status: 404 });
    }

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/stockists/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const stockistId = parseStockistId(id);
    if (!stockistId) {
      return NextResponse.json({ error: 'Invalid stockist id' }, { status: 400 });
    }

    const authz = await authorizeAdminPermission('admin.stockists.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const body = await request.json();
    const parsed = updateStockistSchema.safeParse(body);

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

    const { error } = await supabase
      .from('stockists')
      .update({
        type: parsed.data.type,
        name: parsed.data.name,
        address: parsed.data.address,
        phone: parsed.data.phone,
        time: parsed.data.time,
        holiday: parsed.data.holiday,
        status: parsed.data.status,
      })
      .eq('id', stockistId);

    if (error) {
      console.error('Failed to update stockist:', error);
      return NextResponse.json({ error: 'Failed to update stockist' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PUT /api/admin/stockists/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const stockistId = parseStockistId(id);
    if (!stockistId) {
      return NextResponse.json({ error: 'Invalid stockist id' }, { status: 400 });
    }

    const authz = await authorizeAdminPermission('admin.stockists.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const body = await request.json();
    const parsed = patchStatusSchema.safeParse(body);

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

    const { error } = await supabase
      .from('stockists')
      .update({ status: parsed.data.status })
      .eq('id', stockistId);

    if (error) {
      console.error('Failed to update stockist status:', error);
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/stockists/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const stockistId = parseStockistId(id);
    if (!stockistId) {
      return NextResponse.json({ error: 'Invalid stockist id' }, { status: 400 });
    }

    const authz = await authorizeAdminPermission('admin.stockists.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { error } = await supabase
      .from('stockists')
      .delete()
      .eq('id', stockistId);

    if (error) {
      console.error('Failed to delete stockist:', error);
      return NextResponse.json({ error: 'Failed to delete stockist' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/stockists/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
