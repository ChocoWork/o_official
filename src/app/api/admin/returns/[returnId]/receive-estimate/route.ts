/**
 * 返品の受け取りの返金の見込み（POST /api/admin/returns/[returnId]/receive-estimate）。
 *
 * @packageDocumentation
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-022
 * @remarks 読むだけ（何も書かない）。本文は受け取りの窓口と同じ選び（品・状態・今すぐ/相談・交換の選び直し・割引の扱い）で、
 *   確定と同じ値段の計画から額を出す。額は本文から受け取らない（店長が直す額は受け取りの窓口の今の欄）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { MAX_AMOUNT, resolveCanRefund, respondToReturnReadError } from '@/lib/orders/returns/return-route-support';
import { estimateReturnReceive } from '@/lib/orders/unit-pricing/unit-pricing-service';

const bodySchema = z.object({
  units: z
    .array(
      z.object({
        returnLineId: z.string().uuid(),
        disposition: z.enum(['restocked', 'not_restocked', 'pending_inspection', 'sent_back']),
        quantity: z.number().int().min(1).max(999),
        refundChoice: z.enum(['now', 'consult']).optional(),
      }),
    )
    .max(100),
  exchangeOverrides: z
    .array(z.object({ returnLineId: z.string().uuid(), action: z.enum(['make', 'refund']) }))
    .max(100)
    .default([]),
  refundChoice: z.enum(['now', 'consult', 'mixed', 'none']),
  refundShippingAmount: z.number().int().min(0).max(MAX_AMOUNT).default(0),
  treatments: z
    .array(z.object({ returnLineId: z.string().uuid(), treatment: z.enum(['shop', 'customer']) }))
    .max(100)
    .optional(),
});

/**
 * 受け取りを選ぶたびに、確定と同じ計算で返金の見込みを出す。返品を読む権限の人だけが読める。
 * 読むだけなので CSRF と回数の制限は通さない（今の返品を読む窓口と同じ）。POST なのは、選びを本文で渡すため。
 * 割引の扱いを理由からの初めの値から変えられるのは、返金の権限を持つ人だけ（持たない人が変えると 403）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.return', request);
  if (!authz.ok) {
    return authz.response;
  }
  const refundSide = await resolveCanRefund(request);
  if (!refundSide.ok) {
    return refundSide.response;
  }

  const { returnId } = await params;
  const parsedId = z.string().uuid().safeParse(returnId);
  if (!parsedId.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const client = await createServiceRoleClient();
    const estimate = await estimateReturnReceive(client, parsedId.data, parsedBody.data, { canRefund: refundSide.canRefund });
    return NextResponse.json({ data: estimate }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return respondToReturnReadError(error, {
      tag: '[admin.orders.return.receive-estimate] Failed to estimate',
      failureKind: 'materials',
    });
  }
}
