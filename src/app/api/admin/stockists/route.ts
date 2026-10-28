/**
 * 管理の取扱店の一覧と作成の窓口（src/app/api/admin/stockists/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-STOCKIST-141
 * @design DD-STOCKIST-034
 * @remarks 一覧の読みと作成の変更で必要な権限を分け、読みの権限だけでは書けないようにする（SEC-STOCKIST-006）。
 * 全部の窓口は「送り元の枠 → 認可 → 操作者の枠 → （変更だけ）CSRF の token」の順に確かめる。送り元の枠を認可の前に置くので、未ログインの 401・権限の無い 403 の連打も送り元ごとに止まる（SEC-STOCKIST-020）。操作者の枠は認可の後に操作者の id で数える。書き込みは認可の後に service role で行う。RLS の書き込み方針は権限を外した後も二重の守りとして残る（ADR-0267）。
 * 認可で断った要求のうち操作者が分かる物（403・失効した session の 401）は auditAuthzDenial で監査に残す。token 無しの 401 は残さない（SEC-STOCKIST-021、ADR-0268）。
 * 一覧は内部の列を除いた 8 列だけ返し（SEC-STOCKIST-009）、壊れた JSON は 500 でなく 400 にする（SEC-STOCKIST-013）。検証の誤りは項目の名前だけの固定の本文にし（SEC-STOCKIST-014）、DB の誤りは符号だけを記録する。
 * 認可の拒否・回数の制限・CSRF の拒否を含む全部の応答を、export で withNoStore に通して `Cache-Control: private, no-store` にし（SEC-STOCKIST-010）、外側の catch の記録は名前と符号だけにする（SEC-STOCKIST-014）。
 */
import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { auditAuthzDenial } from '@/lib/auth/audit-authz-denial';
import { logAudit } from '@/lib/audit';
import { withNoStore } from '@/lib/http/no-store';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { getClientIp } from '@/lib/request-ip';
import {
  applyRotatedCsrfCookie,
  enforceAdminStockistActorRateLimit,
  enforceAdminStockistIpRateLimit,
  requireAdminStockistCsrf,
  toCsrfDenyResponse,
} from '@/features/stockist/services/admin-security';
import {
  ADMIN_STOCKIST_COLUMNS,
  stockistWriteSchema,
  toInvalidStockistResponse,
} from '@/features/stockist/schemas';

async function listStockists(request: Request) {
  try {
    const ipRateLimitResponse = await enforceAdminStockistIpRateLimit(request, 'read');
    if (ipRateLimitResponse) {
      return ipRateLimitResponse;
    }

    const authz = await authorizeAdminPermission('admin.stockists.read', request);
    if (!authz.ok) {
      await auditAuthzDenial(authz, { request, action: 'admin.stockists.list', resource: 'stockists' });
      return authz.response;
    }

    const rateLimitResponse = await enforceAdminStockistActorRateLimit(request, authz.userId, 'read');
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
    console.error('GET /api/admin/stockists error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function createStockist(request: Request) {
  try {
    const ipRateLimitResponse = await enforceAdminStockistIpRateLimit(request, 'mutation');
    if (ipRateLimitResponse) {
      return ipRateLimitResponse;
    }

    const authz = await authorizeAdminPermission('admin.stockists.manage', request);
    if (!authz.ok) {
      await auditAuthzDenial(authz, { request, action: 'admin.stockists.create', resource: 'stockists' });
      return authz.response;
    }

    const rateLimitResponse = await enforceAdminStockistActorRateLimit(request, authz.userId, 'mutation');
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const csrfResult = await requireAdminStockistCsrf();
    const csrfDenyResponse = toCsrfDenyResponse(csrfResult);
    if (csrfDenyResponse) {
      return csrfDenyResponse;
    }

    const clientIp = getClientIp(request);
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

    const supabase = await createServiceRoleClient();

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
    console.error('POST /api/admin/stockists error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return withNoStore(await listStockists(request));
}

export async function POST(request: Request) {
  return withNoStore(await createStockist(request));
}
