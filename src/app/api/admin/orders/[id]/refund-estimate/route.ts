/**
 * 管理画面の返金の見込み（POST /api/admin/orders/[id]/refund-estimate）。
 *
 * @packageDocumentation
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-023
 * @remarks 読むだけ（何も書かない）。選んだ品と送料から、確定と同じ値段の計画で「標準の額」を出す。
 *   額は本文から受け取らない（店長が決める額は返金の窓口の今の欄）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  INVALID_REQUEST_BODY,
  REFUND_ERROR_MESSAGES,
  refundErrorBody,
  refundFailureBody,
} from '@/lib/orders/refund/refund-messages';
import { refundErrorLogFields } from '@/lib/orders/refund/refund-route-support';
import { RefundOperationError } from '@/lib/orders/refund/refund-store';
import { planOrderRefund } from '@/lib/orders/unit-pricing/unit-pricing-service';

// Postgres の integer の上限（返金の窓口と同じ）
const MAX_AMOUNT = 2147483647;

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999),
        beforeShipment: z.boolean(),
      }),
    )
    .max(100)
    .refine((lines) => new Set(lines.map((line) => `${line.orderItemId}:${line.beforeShipment}`)).size === lines.length),
  shippingAmount: z.number().int().min(0).max(MAX_AMOUNT).default(0),
});

/**
 * 返金の画面で品と数を選ぶたびに、標準の額と上限を出す。返金の操作と同じ権限の人だけが読める。
 * 読むだけなので CSRF と回数の制限は通さない（今の返金の材料を読む窓口と同じ）。POST なのは、選びを本文で渡すため。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.refund', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const client = await createServiceRoleClient();
    const { estimate } = await planOrderRefund(client, parsedId.data, parsedBody.data);
    return NextResponse.json({ data: estimate }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RefundOperationError) {
      return NextResponse.json(refundErrorBody(error.code), { status: REFUND_ERROR_MESSAGES[error.code].status });
    }
    console.error('[admin.orders.refund.estimate] Failed to estimate', ...refundErrorLogFields(error));
    return NextResponse.json(refundFailureBody('materials'), { status: 500 });
  }
}
