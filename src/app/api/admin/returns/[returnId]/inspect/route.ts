import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { createDefaultRefundServiceDeps } from '@/lib/orders/refund/refund-service';
import {
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  respondToRefusal,
  respondToReturnError,
} from '@/lib/orders/returns/return-route-support';
import { submitInspectReturn } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.inspect';

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  // 検品待ちの品を、返品の行ごとに「在庫に戻す数」と「戻さない数」に決める。数の合計が検品待ちの数を超えないかは DB が確かめる
  lines: z
    .array(
      z
        .object({
          returnLineId: z.string().uuid(),
          restocked: z.number().int().min(0).max(999),
          notRestocked: z.number().int().min(0).max(999),
        })
        .refine((line) => line.restocked + line.notRestocked >= 1),
    )
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((line) => line.returnLineId)).size === lines.length),
});

/**
 * 検品を終える（グループ E-3 設計書 6-1）。検品待ちの品を、在庫に戻す・戻さないに決める。返金は受け取りの時に決めた選び方のまま。
 * お客様にメールは送らない。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 検品の順に確かめる。
 * 同じ requestKey の送り直しは前の結果を返す（replayed）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const guard = await guardReturnWrite(request, { rateLimit: RETURN_RATE_LIMITS.update, requireRefundPermission: false });
  if (!guard.ok) {
    return guard.response;
  }

  const { returnId } = await params;
  const audit = createReturnAudit(request, guard.userId, { action: ACTION, resource: 'order_returns', resourceId: returnId });

  const parsedId = z.string().uuid().safeParse(returnId);
  if (!parsedId.success) {
    await audit('failure', 'Invalid return id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { requestKey, lines } = parsedBody.data;

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await submitInspectReturn(deps, { returnId: parsedId.data, actorId: guard.userId, requestKey, lines });
    if (result.kind === 'refused') {
      return respondToRefusal(result.code, { audit, refusedDetail: 'Return inspect refused' });
    }
    await audit('success', 'Return inspected', {
      receipt_id: result.receiptId,
      return_status: result.returnStatus,
      replayed: result.replayed,
      line_count: lines.length,
    });
    return NextResponse.json({
      data: { returnStatus: result.returnStatus, receiptId: result.receiptId, replayed: result.replayed },
    });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return inspect refused',
      failureDetail: 'Failed to inspect return',
      failureKind: 'update',
    });
  }
}
