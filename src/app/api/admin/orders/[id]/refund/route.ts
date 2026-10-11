import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { loadRefundMaterials } from '@/lib/orders/refund/refund-materials';
import {
  INVALID_REQUEST_BODY,
  REFUND_ERROR_MESSAGES,
  refundErrorBody,
  refundFailureBody,
} from '@/lib/orders/refund/refund-messages';
import { refundErrorLogFields, toRefundReply } from '@/lib/orders/refund/refund-route-support';
import { createDefaultRefundServiceDeps, submitAdminRefund } from '@/lib/orders/refund/refund-service';
import { STRIPE_REFUND_REASONS } from '@/lib/orders/refund/refund-types';

// Postgres の integer の上限。これを超える額は DB が型の誤りで断って 500 になり、画面が同じ番号で確かめ直しを繰り返してしまうので、窓口で 400 にする
const MAX_AMOUNT = 2147483647;

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  lines: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999),
        beforeShipment: z.boolean(),
      }),
    )
    .max(100)
    // 同じ商品でも、発送前と発送後は別の行（DB の一意の決まりも「返金・商品・発送前か」で1行）
    .refine((lines) => new Set(lines.map((line) => `${line.orderItemId}:${line.beforeShipment}`)).size === lines.length),
  restock: z.boolean(),
  shippingAmount: z.number().int().min(0).max(MAX_AMOUNT),
  amount: z.number().int().min(1).max(MAX_AMOUNT),
  // 店だけのメモ。空は持たない（null）
  note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).nullish().transform((value) => value || null),
  stripeReason: z.enum(STRIPE_REFUND_REASONS),
  notifyCustomer: z.boolean(),
});

const RATE_LIMIT = { endpoint: 'admin:orders:refund-create', limit: 30, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 返金の画面を開いた時に読む材料（グループ E-2 設計書 5-2）。注文の額・商品ごとの数と割り振った割引・返せる額・返事待ちの返金。
 * 返金の操作と同じ権限の人だけが読める。読むだけなので CSRF と回数の制限は通さない。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.refund', request);
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
    const materials = await loadRefundMaterials(client, parsedId.data);
    if (!materials) {
      return NextResponse.json(refundErrorBody('order_not_found'), { status: REFUND_ERROR_MESSAGES.order_not_found.status });
    }
    return NextResponse.json(materials, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.orders.refund.materials] Failed to load materials', ...refundErrorLogFields(error));
    return NextResponse.json(refundFailureBody('materials'), { status: 500 });
  }
}

/**
 * 返金する（グループ E-2 設計書 5-2）。商品ごとの数・送料・額を指定して、返金を1件ずつ記録して Stripe に頼む。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 注文の番号 → 中身 → 返金の流れの順に確かめる。
 * 答えが分からない時（502）も返金の記録の番号を返し、画面は開き直した後もその番号で確かめ直せる。
 * 監査にメモ・宛先・連絡先は入れない。同じ requestKey の送り直しは前の結果を返す（replayed）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.refund', request);
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
      action: 'admin.orders.refund.create',
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
    // 入力値や検証の詳細はメモなどを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const refundRequest = parsedBody.data;

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await submitAdminRefund(deps, { orderId: parsedId.data, actorId: authz.userId, request: refundRequest });
    const reply = toRefundReply(result);
    await audit(reply.audit.outcome, reply.audit.detail, {
      ...reply.audit.metadata,
      source: 'admin',
      line_count: refundRequest.lines.length,
    });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    console.error('[admin.orders.refund.create] Failed to create refund', ...refundErrorLogFields(error));
    await audit('error', 'Failed to create refund');
    return NextResponse.json(refundFailureBody('create'), { status: 500 });
  }
}
