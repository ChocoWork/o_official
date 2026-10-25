import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermissions, type PermissionCode } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ShipmentSlipError } from './shipment-slip-store';
import { SHIPMENT_SLIP_ERRORS, SHIPMENT_SLIP_LIMITS, SHIPMENT_SLIP_TEXT } from './shipment-slip-types';

/**
 * 発送票に対する書込みの窓口（G-3 Task 4: 下書きの作成・入替・破棄。後の Task の確定・伝票・配達済み・取消・出荷日の訂正）が共通で使う流れ。
 * 認可（admin.shipping.manage + admin.shipping.read + admin.orders.manage + admin.orders.read。出荷日の訂正は別の組を渡す）
 * → CSRF → IP の回数制限 → actor の回数制限 → 検証（パスの id・本文）→ store → 監査。
 * 実行者は認可結果の userId だけから渡す。DB の生の誤りは本文にも監査にもログにも出さない。
 * 監査の metadata は対象 ID・件数・結果コードだけ。パスの id が uuid でなければ resource_id は null（受け取った文字列は残さない）。
 */

/** 発送票の操作（下書き・破棄・確定・伝票番号・配達済み・取消）に要る権限（すべて） */
export const SHIPMENT_SLIP_MANAGE_PERMISSIONS: readonly PermissionCode[] = [
  'admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read',
];

export const SHIPMENT_SLIP_DATE_PERMISSIONS: readonly PermissionCode[] = [
  'admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read',
];

/** 回数制限の窓（秒） */
const RATE_WINDOW_SECONDS = 600;

const { lines, quantity } = SHIPMENT_SLIP_LIMITS;

/** 下書きの行: 1〜100件、orderItemId は uuid・重複なし、送る数は 1〜99999 の整数 */
export const draftLinesSchema = z.array(z.object({
  orderItemId: z.string().uuid(),
  quantity: z.number().int().min(quantity.min).max(quantity.max),
}).strict()).min(lines.min).max(lines.max).refine(
  (items) => new Set(items.map((item) => item.orderItemId.toLowerCase())).size === items.length,
  { message: 'orderItemId は重複できません' },
);

export const requestKeySchema = z.string().uuid();
export const expectedVersionSchema = z.number().int().min(1).max(2147483647);

type WriteSpec<Body, Result extends { id: string }> = {
  request: Request;
  /** パスに [id] がある窓口だけ渡す。無ければ（作成）票の id は null */
  context?: { params: Promise<{ id: string }> };
  /** ログの見出し（例: `POST /api/admin/shipment-slips`） */
  label: string;
  /** 回数制限の endpoint 名（例: admin.shipment_slips.draft） */
  rateEndpoint: string;
  rateLimit: number;
  /** 監査の action（例: admin.shipment_slips.draft.save） */
  auditAction: string;
  /** 監査の結果コード（DB の誤りが表に無い時） */
  errorCode: string;
  /** 必要な権限（すべて）。省くと SHIPMENT_SLIP_MANAGE_PERMISSIONS */
  permissions?: readonly PermissionCode[];
  /** 操作固有の権限拒否文。認証/MFA/CSRFの失敗文は保持する。 */
  forbiddenMessage?: string;
  /** 空の理由だけが検証違反なら、DBと同じ理由必須の固定エラーを返す。 */
  requiredReason?: boolean;
  schema: z.ZodType<Body>;
  status: 200 | 201;
  run: (client: SupabaseClient, actorId: string, slipId: string | null, body: Body) => Promise<Result>;
  auditSuccess: (body: Body, result: Result) => Record<string, unknown>;
  auditFailure: (body: Body) => Record<string, unknown>;
};

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** ログに出す誤りの項目は名前と、あれば code だけ（message・details は DB の文を持ちうる）。 */
function describeErrorForLog(error: unknown): [name: string, code: unknown] {
  const { code = null } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown };
  return [error instanceof Error ? error.name : 'UnknownError', code];
}

export async function handleShipmentSlipWrite<Body, Result extends { id: string }>(spec: WriteSpec<Body, Result>): Promise<Response> {
  try {
    const authz = await authorizeAdminPermissions(spec.permissions ?? SHIPMENT_SLIP_MANAGE_PERMISSIONS, spec.request);
    if (!authz.ok) {
      if (spec.forbiddenMessage && authz.response.status === 403) {
        const body: unknown = await authz.response.clone().json().catch(() => null);
        if (body !== null && typeof body === 'object' && 'permission' in body && !('reason' in body)) {
          return noStore(NextResponse.json({ ...body, error: spec.forbiddenMessage }, { status: 403 }));
        }
      }
      return noStore(authz.response);
    }

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrfResult = await requireCsrfOrDeny();
    if (csrfResult instanceof Response) return noStore(csrfResult);
    const rate = { endpoint: spec.rateEndpoint, limit: spec.rateLimit, windowSeconds: RATE_WINDOW_SECONDS };
    const ipLimited = await enforceRateLimit({ request: spec.request, ...rate });
    if (ipLimited) return noStore(ipLimited);
    const actorLimited = await enforceRateLimit({ request: spec.request, ...rate, subject: authz.userId });
    if (actorLimited) return noStore(actorLimited);

    const audit = (outcome: 'success' | 'failure' | 'error', resourceId: string | null, metadata: Record<string, unknown>) => logAudit({
      action: spec.auditAction, actor_id: authz.userId, resource: 'shipment_slips', resource_id: resourceId, outcome, metadata,
    });

    let slipId: string | null = null;
    if (spec.context) {
      const params = await spec.context.params;
      const parsedId = z.string().uuid().safeParse(params.id);
      if (!parsedId.success) {
        await audit('failure', null, { code: 'INVALID_REQUEST' });
        return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
      }
      slipId = parsedId.data;
    }
    const parsedBody = spec.schema.safeParse(await spec.request.json().catch(() => ({})));
    if (!parsedBody.success) {
      if (spec.requiredReason && parsedBody.error.issues.every((issue) => issue.path.length === 1 && issue.path[0] === 'reason' && issue.code === 'too_small' && issue.minimum === 1)) {
        const code = 'GROUP_G_SLIP_REASON_REQUIRED';
        await audit('failure', slipId, { code });
        return noStore(NextResponse.json({ code, error: SHIPMENT_SLIP_ERRORS[code][2] }, { status: 400 }));
      }
      await audit('failure', slipId, { code: 'INVALID_REQUEST' });
      return noStore(NextResponse.json({ error: 'Invalid request', details: parsedBody.error.flatten() }, { status: 400 }));
    }
    const body = parsedBody.data;

    const client = await createServiceRoleClient();
    try {
      const result = await spec.run(client, authz.userId, slipId, body);
      await audit('success', result.id, spec.auditSuccess(body, result));
      return noStore(NextResponse.json(result, { status: spec.status }));
    } catch (error) {
      const failure = error instanceof ShipmentSlipError ? error : new ShipmentSlipError();
      await audit(failure.code ? 'failure' : 'error', slipId, { ...spec.auditFailure(body), code: failure.code ?? spec.errorCode });
      return noStore(NextResponse.json({
        ...(failure.code ? { code: failure.code } : {}),
        error: failure.code === 'GROUP_G_FORBIDDEN' && spec.forbiddenMessage ? spec.forbiddenMessage : failure.message,
      }, { status: failure.status }));
    }
  } catch (error) {
    console.error(`${spec.label} error:`, ...describeErrorForLog(error));
    return noStore(NextResponse.json({ error: SHIPMENT_SLIP_TEXT.failed }, { status: 500 }));
  }
}
