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
import { submitReopenReturn } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.reopen';

const bodySchema = z.object({ requestKey: z.string().uuid() });

/**
 * 返品を開き直す（グループ E-3 設計書 7-4）。「届かない」で終えた品がある完了した返品だけ。受付中に戻り、その品をまた受け取れる。
 * 受け取り済みの品は変わらず、お客様にメールは送らない。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 開き直しの順に確かめる。
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
    const result = await submitReopenReturn(deps, {
      returnId: parsedId.data,
      actorId: guard.userId,
      requestKey: parsedBody.data.requestKey,
    });
    if (result.kind === 'refused') {
      return respondToRefusal(result.code, { audit, refusedDetail: 'Return reopen refused' });
    }
    await audit('success', 'Return reopened', {
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
      refusedDetail: 'Return reopen refused',
      failureDetail: 'Failed to reopen return',
      failureKind: 'update',
    });
  }
}
