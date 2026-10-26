/**
 * 管理の取扱店1件の読み・更新・公開の切り替え・削除の窓口（src/app/api/admin/stockists/[id]/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-STOCKIST-142
 * @design DD-STOCKIST-035
 * @remarks 道の id は認可より前に正の整数かを確かめ、形の悪い値を DB へ渡さない。
 * 読みと変更で権限を分け、変更は認可・回数の制限・CSRF の token の順に確かめる。書き込みは認可の後に service role で行う。RLS の書き込み方針は権限を外した後も二重の守りとして残る（ADR-0267）。回数の制限を認可の後に呼ぶので、認可で断った要求は数えない。これは SEC-STOCKIST-020 を満たさない（推定）。権限は読みと変更で分ける（SEC-STOCKIST-006）。
 * 1 件の読みは内部の列を除いた 8 列だけ返す（SEC-STOCKIST-009）。壊れた JSON は 500 でなく 400、検証の誤りは項目の名前だけの固定の本文にする（SEC-STOCKIST-013・014）。
 * 更新・切り替え・削除は結果が 0 行なら 404 にして成功の監査を書かない。削除の監査には消した店の id・名前・住所・状態だけを残す（SEC-STOCKIST-013）。DB の誤りは符号だけを記録する。
 * 認可の拒否・回数の制限・CSRF の拒否を含む全部の応答を、export で withNoStore に通して `Cache-Control: private, no-store` にし（SEC-STOCKIST-010）、外側の catch の記録は名前と符号だけにする（SEC-STOCKIST-014）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { withNoStore } from '@/lib/http/no-store';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import {
  applyRotatedCsrfCookie,
  enforceAdminStockistMutationRateLimit,
  enforceAdminStockistReadRateLimit,
  requireAdminStockistCsrf,
  toCsrfDenyResponse,
} from '@/features/stockist/services/admin-security';
import {
  ADMIN_STOCKIST_COLUMNS,
  stockistStatusSchema,
  stockistWriteSchema,
  toInvalidStockistResponse,
} from '@/features/stockist/schemas';

const patchStatusSchema = z.object({
  status: stockistStatusSchema,
});

function parseStockistId(id: string): number | null {
  const parsedId = Number(id);
  if (!Number.isSafeInteger(parsedId) || parsedId <= 0) {
    return null;
  }

  return parsedId;
}

async function getStockist(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
      .select(ADMIN_STOCKIST_COLUMNS)
      .eq('id', stockistId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Stockist not found' }, { status: 404 });
    }

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/stockists/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function putStockist(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const body = await request.json().catch(() => null);
    if (body === null) {
      await logAudit({
        action: 'admin.stockists.update',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
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
      return toInvalidStockistResponse(parsed.error);
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('stockists')
      .update({
        name: parsed.data.name,
        address: parsed.data.address,
        phone: parsed.data.phone,
        time: parsed.data.time,
        holiday: parsed.data.holiday,
        status: parsed.data.status,
      })
      .eq('id', stockistId)
      .select('id');

    if (error) {
      console.error('Failed to update stockist:', { code: error.code });
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

    if (!data || data.length === 0) {
      await logAudit({
        action: 'admin.stockists.update',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'failure',
        detail: 'Stockist not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Stockist not found' }, { status: 404 });
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
    console.error('PUT /api/admin/stockists/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function patchStockist(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const body = await request.json().catch(() => null);
    if (body === null) {
      await logAudit({
        action: 'admin.stockists.patch',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'failure',
        detail: 'Invalid JSON',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

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
      return toInvalidStockistResponse(parsed.error);
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('stockists')
      .update({ status: parsed.data.status })
      .eq('id', stockistId)
      .select('id');

    if (error) {
      console.error('Failed to update stockist status:', { code: error.code });
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

    if (!data || data.length === 0) {
      await logAudit({
        action: 'admin.stockists.patch',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'failure',
        detail: 'Stockist not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Stockist not found' }, { status: 404 });
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
    console.error('PATCH /api/admin/stockists/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function deleteStockist(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('stockists')
      .delete()
      .eq('id', stockistId)
      .select('id, name, address, status');

    if (error) {
      console.error('Failed to delete stockist:', { code: error.code });
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

    if (!data || data.length === 0) {
      await logAudit({
        action: 'admin.stockists.delete',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'stockists',
        resource_id: String(stockistId),
        outcome: 'failure',
        detail: 'Stockist not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Stockist not found' }, { status: 404 });
    }

    const deleted = data[0];
    await logAudit({
      action: 'admin.stockists.delete',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'stockists',
      resource_id: String(stockistId),
      outcome: 'success',
      detail: `Deleted stockist id: ${stockistId}`,
      metadata: {
        deleted: {
          id: deleted.id,
          name: deleted.name,
          address: deleted.address,
          status: deleted.status,
        },
      },
      ip: clientIp,
      user_agent: userAgent,
    });

    const response = NextResponse.json({ success: true }, { status: 200 });
    applyRotatedCsrfCookie(response, csrfResult);
    return response;
  } catch (error) {
    console.error('DELETE /api/admin/stockists/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withNoStore(await getStockist(request, context));
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return withNoStore(await putStockist(request, context));
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return withNoStore(await patchStockist(request, context));
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return withNoStore(await deleteStockist(request, context));
}
