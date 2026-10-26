/**
 * 管理の取扱店の一覧と作成の窓口（src/app/api/admin/stockists/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-STOCKIST-141
 * @design DD-STOCKIST-034
 * @remarks 一覧の読みと作成の変更で必要な権限を分け、読みの権限だけでは書けないようにする（SEC-STOCKIST-006）。
 * 変更は認可の次に回数の制限、その次に CSRF の token を確かめる。回数の制限を認可の後に呼ぶので、認可で断った要求は数えない。これは SEC-STOCKIST-020 を満たさない（推定）。
 * 一覧は内部の列を除いた 8 列だけ返し（SEC-STOCKIST-009）、壊れた JSON は 500 でなく 400 にする（SEC-STOCKIST-013）。検証の誤りは項目の名前だけの固定の本文にし（SEC-STOCKIST-014）、DB の誤りは符号だけを記録する。
 */
import { NextResponse } from 'next/server';
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
import {
  ADMIN_STOCKIST_COLUMNS,
  stockistWriteSchema,
  toInvalidStockistResponse,
} from '@/features/stockist/schemas';

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
      .select(ADMIN_STOCKIST_COLUMNS)
      .order('id', { ascending: true });

    if (error) {
      console.error('Failed to fetch stockists:', { code: error.code });
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

    const body = await request.json().catch(() => null);
    if (body === null) {
      await logAudit({
        action: 'admin.stockists.create',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        outcome: 'failure',
        detail: 'Invalid JSON',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const parsed = stockistWriteSchema.safeParse(body);

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
      return toInvalidStockistResponse(parsed.error);
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
      console.error('Failed to create stockist:', { code: error.code });
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
