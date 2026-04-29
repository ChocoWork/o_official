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

const createStockistSchema = z.object({
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

    const rateLimitResponse = await enforceAdminStockistReadRateLimit(request, authz.userId);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const supabase = await createClient(request);

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
    const parsed = createStockistSchema.safeParse(body);

    if (!parsed.success) {
      await logAudit({
        action: 'admin.stockists.create',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
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

    const { data, error } = await supabase
      .from('stockists')
      .insert([
        {
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
      await logAudit({
        action: 'admin.stockists.create',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        outcome: 'error',
        detail: 'DB insert failed',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Failed to save stockist' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.stockists.create',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'stockists',
      resource_id: String(data.id),
      outcome: 'success',
      detail: `Created stockist: ${parsed.data.name}`,
      ip: clientIp,
      user_agent: userAgent,
    });

    const response = NextResponse.json({ success: true, id: data.id }, { status: 201 });
    applyRotatedCsrfCookie(response, csrfResult);
    return response;
  } catch (error) {
    console.error('POST /api/admin/stockists error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
