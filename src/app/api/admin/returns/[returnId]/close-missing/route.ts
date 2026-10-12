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
import { submitCloseReturnMissing } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.close_missing';

const bodySchema = z.object({ requestKey: z.string().uuid() });

/**
 * 残りは届かないものとして返品を終える（グループ E-3 設計書 6-1）。まだ処理していない数を「届かない」で入れる。
 * その品は返金も交換もしない。お客様にメールは送らない。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 終える操作の順に確かめる。
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

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await submitCloseReturnMissing(deps, {
      returnId: parsedId.data,
      actorId: guard.userId,
      requestKey: parsedBody.data.requestKey,
    });
    if (result.kind === 'refused') {
      return respondToRefusal(result.code, { audit, refusedDetail: 'Return close-missing refused' });
    }
    await audit('success', 'Return closed as missing', {
      receipt_id: result.receiptId,
      return_status: result.returnStatus,
      replayed: result.replayed,
    });
    return NextResponse.json({
      data: { returnStatus: result.returnStatus, receiptId: result.receiptId, replayed: result.replayed },
    });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return close-missing refused',
      failureDetail: 'Failed to close return as missing',
      failureKind: 'update',
    });
  }
}
