import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { draftLinesSchema, handleShipmentSlipWrite, requestKeySchema } from '@/lib/orders/shipment-slips/shipment-slip-route';
import { listAdminShipmentSlips, saveShipmentSlipDraft, ShipmentSlipError } from '@/lib/orders/shipment-slips/shipment-slip-store';
import {
  isShipmentSlipStage,
  readShipmentSlipQueryInteger,
  SHIPMENT_SLIP_LIMITS,
  SHIPMENT_SLIP_TEXT,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** ログに出す誤りの項目は名前と、あれば code だけ（message・details は DB の文を持ちうる）。 */
function describeErrorForLog(error: unknown): [name: string, code: unknown] {
  const { code = null } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown };
  return [error instanceof Error ? error.name : 'UnknownError', code];
}

/**
 * 発送票の一覧（G-3 / FREQ-531）。新しく更新した順に返す（読むだけ）。stage（下書き・発送済み・取消済み・破棄済み）で絞れる。
 * 窓口でも DB の関数でも admin.shipping.read + admin.orders.read を確かめる（実行者は認可結果の userId だけから渡す）。
 * DB の生の誤りは本文にもログにも出さない。
 */
export async function GET(request: Request): Promise<Response> {
  const authz = await authorizeAdminPermissions(['admin.shipping.read', 'admin.orders.read'], request);
  if (!authz.ok) return noStore(authz.response);

  const params = new URL(request.url).searchParams;
  const limit = readShipmentSlipQueryInteger(params.get('limit'), SHIPMENT_SLIP_LIMITS.slipPage.limit);
  const page = readShipmentSlipQueryInteger(params.get('page'), SHIPMENT_SLIP_LIMITS.slipPage.page);
  const stage = params.get('stage');
  if (limit === null || page === null || (stage !== null && !isShipmentSlipStage(stage))) {
    return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
  }

  try {
    const client = await createServiceRoleClient();
    const { rows, total } = await listAdminShipmentSlips(client, authz.userId, { stage, limit, page });
    return noStore(NextResponse.json({ rows, total, page, limit }));
  } catch (error) {
    if (error instanceof ShipmentSlipError && error.code) {
      return noStore(NextResponse.json({ code: error.code, error: error.message }, { status: error.status }));
    }
    console.error('GET /api/admin/shipment-slips error:', ...describeErrorForLog(error));
    return noStore(NextResponse.json({ error: SHIPMENT_SLIP_TEXT.failed }, { status: 500 }));
  }
}

const createSchema = z.object({ lines: draftLinesSchema, requestKey: requestKeySchema });

/**
 * 発送票の下書きの作成（G-3 / FREQ-531-AC-03）。荷作り表で選んだ行（注文の明細と送る数）から新しい下書きを作る。
 * 権限は窓口と DB の関数の両方で下書き・破棄の組（admin.shipping.manage + admin.shipping.read + admin.orders.manage + admin.orders.read）を確かめ、
 * 実行者は認可結果の userId だけから渡す。同梱できるか・数量が準備中の数以下かは DB が確かめる。同じ requestKey と同じ内容の再送は同じ票を返す。
 * 成功は 201 { id, number, version, replayed }。DB の生の誤りは本文にも監査にもログにも出さない。
 */
export async function POST(request: Request): Promise<Response> {
  return handleShipmentSlipWrite({
    request,
    label: 'POST /api/admin/shipment-slips',
    rateEndpoint: 'admin.shipment_slips.draft',
    rateLimit: 120,
    auditAction: 'admin.shipment_slips.draft.save',
    errorCode: 'SHIPMENT_SLIP_DRAFT_SAVE_FAILED',
    schema: createSchema,
    status: 201,
    run: (client, actorId, _slipId, body) => saveShipmentSlipDraft(client, actorId, {
      slipId: null, expectedVersion: null, lines: body.lines, requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ line_count: body.lines.length, replayed: result.replayed }),
    auditFailure: (body) => ({ line_count: body.lines.length }),
  });
}
