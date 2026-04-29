import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import {
  applyRotatedCsrfCookie,
  enforceAdminStockistMutationRateLimit,
  enforceAdminStockistReadRateLimit,
  requireAdminStockistCsrf,
  toCsrfDenyResponse,
} from '@/features/stockist/services/admin-security';

const stockistStatusSchema = z.enum(['private', 'published']);

const updateStockistSchema = z.object({
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

    const rateLimitResponse = await enforceAdminStockistReadRateLimit(request, authz.userId);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const supabase = await createClient(request);

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

    const rateLimitResponse = await enforceAdminStockistMutationRateLimit(request, authz.userId);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const csrfResult = await requireAdminStockistCsrf();
    const csrfDenyResponse = toCsrfDenyResponse(csrfResult);
    if (csrfDenyResponse) {
      return csrfDenyResponse;
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const body = await request.json();
    const parsed = updateStockistSchema.safeParse(body);

    if (!parsed.success) {
      await logAudit({
        action: 'admin.stockists.update',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'failure',
        detail: 'Validation failed',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const supabase = await createClient(request);

    const { error } = await supabase
      .from('stockists')
      .update({
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
      await logAudit({
        action: 'admin.stockists.update',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'error',
        detail: 'DB update failed',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Failed to update stockist' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.stockists.update',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'stockists',
      resource_id: String(stockistId),
      outcome: 'success',
      detail: `Updated stockist: ${parsed.data.name}`,
      ip: clientIp,
      user_agent: userAgent,
    });

    const response = NextResponse.json({ success: true }, { status: 200 });
    applyRotatedCsrfCookie(response, csrfResult);
    return response;
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

    const rateLimitResponse = await enforceAdminStockistMutationRateLimit(request, authz.userId);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const csrfResult = await requireAdminStockistCsrf();
    const csrfDenyResponse = toCsrfDenyResponse(csrfResult);
    if (csrfDenyResponse) {
      return csrfDenyResponse;
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const body = await request.json();
    const parsed = patchStatusSchema.safeParse(body);

    if (!parsed.success) {
      await logAudit({
        action: 'admin.stockists.patch',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'failure',
        detail: 'Validation failed',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const supabase = await createClient(request);

    const { error } = await supabase
      .from('stockists')
      .update({ status: parsed.data.status })
      .eq('id', stockistId);

    if (error) {
      console.error('Failed to update stockist status:', error);
      await logAudit({
        action: 'admin.stockists.patch',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'error',
        detail: 'DB update failed',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.stockists.patch',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'stockists',
      resource_id: String(stockistId),
      outcome: 'success',
      detail: `Status changed to: ${parsed.data.status}`,
      ip: clientIp,
      user_agent: userAgent,
    });

    const response = NextResponse.json({ success: true }, { status: 200 });
    applyRotatedCsrfCookie(response, csrfResult);
    return response;
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

    const rateLimitResponse = await enforceAdminStockistMutationRateLimit(request, authz.userId);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const csrfResult = await requireAdminStockistCsrf();
    const csrfDenyResponse = toCsrfDenyResponse(csrfResult);
    if (csrfDenyResponse) {
      return csrfDenyResponse;
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const supabase = await createClient(request);

    const { error } = await supabase
      .from('stockists')
      .delete()
      .eq('id', stockistId);

    if (error) {
      console.error('Failed to delete stockist:', error);
      await logAudit({
        action: 'admin.stockists.delete',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'error',
        detail: 'DB delete failed',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Failed to delete stockist' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.stockists.delete',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'stockists',
      resource_id: String(stockistId),
      outcome: 'success',
      detail: `Deleted stockist id: ${stockistId}`,
      ip: clientIp,
      user_agent: userAgent,
    });

    const response = NextResponse.json({ success: true }, { status: 200 });
    applyRotatedCsrfCookie(response, csrfResult);
    return response;
  } catch (error) {
    console.error('DELETE /api/admin/stockists/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
