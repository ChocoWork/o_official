import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { loadFulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-materials';
import {
  FULFILLMENT_ERROR_MESSAGES,
  INVALID_REQUEST_BODY,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import {
  FulfillmentOperationError,
  FulfillmentStoreError,
  createFulfillment,
} from '@/lib/orders/fulfillment/fulfillment-store';

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  carrier: z.enum(SHIPPING_CARRIER_IDS),
  trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
  // 発送の画面の「お客様に発送のメールを送る」（既定は送る。Shopify の「発送の詳細を今すぐ送る」）
  notifyCustomer: z.boolean().default(true),
  lines: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((line) => line.orderItemId)).size === lines.length),
});

const RATE_LIMIT = { endpoint: 'admin:orders:fulfillment-create', limit: 60, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 発送の画面を開いた時に読む材料（グループ E-1 設計書 6-2）。注文・商品ごとの数・発送の一覧・発送できない理由。
 * 発送の操作と同じ人だけが読める。読むだけなので CSRF と回数の制限は通さない。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const client = await createServiceRoleClient();
    const materials = await loadFulfillmentMaterials(client, parsedId.data);
    if (!materials) {
      return NextResponse.json(fulfillmentErrorBody('order_not_found'), { status: FULFILLMENT_ERROR_MESSAGES.order_not_found.status });
    }
    return NextResponse.json(materials, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.orders.fulfillment.materials] Failed to load materials', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    return NextResponse.json(fulfillmentFailureBody('materials'), { status: 500 });
  }
}

/**
 * 発送する（グループ E-1 設計書 6-2）。1回の発送を、商品と数つきで記録する。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 注文の番号 → 中身 → DB の関数の順に確かめる。
 * 監査に伝票番号・宛先・氏名・住所は入れない。同じ requestKey の送り直しは前の結果を返す（replayed）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const ipLimited = await enforceRateLimit({ request, ...RATE_LIMIT });
  if (ipLimited) {
    return ipLimited;
  }
  const actorLimited = await enforceRateLimit({ request, ...RATE_LIMIT, subject: authz.userId });
  if (actorLimited) {
    return actorLimited;
  }

  const { id } = await params;
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.fulfillment.create',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    await audit('failure', 'Invalid order id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細は伝票番号などを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { requestKey, carrier, trackingNumber, notifyCustomer, lines } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await createFulfillment(store, {
      orderId: parsedId.data,
      actorId: authz.userId,
      requestKey,
      carrier,
      trackingNumber,
      notifyCustomer,
      lines,
    });
    // 何回目かの鍵に number を含めない（maskAuditEvent が number を含む鍵を伏せるため）。伝票番号は入れない
    await audit('success', 'Fulfillment recorded', {
      fulfillment_id: result.fulfillmentId,
      sequence: result.number,
      carrier,
      notify_customer: notifyCustomer,
      completes_order: result.completesOrder,
      line_count: lines.length,
      replayed: result.replayed,
    });
    // 発送のメール（知らせる時だけ）の行は DB の関数が同じ取引で書いた。返事の後に送る。
    // 送り直し（replayed）でも動かす: 前の呼び出しが worker を動かす前に止まっていても、メールが送られるように
    scheduleOrderEmailDelivery();
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Fulfillment refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.fulfillment.create] Failed to create fulfillment', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to create fulfillment');
    return NextResponse.json(fulfillmentFailureBody('create'), { status: 500 });
  }
}
