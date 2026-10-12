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
import { submitCancelReturn } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.cancel';

/**
 * 返品を取り消す（グループ E-3 設計書 7-3）。何も受け取る前の受付中の返品だけ。品はまた返品できる。お客様にメールは送らない。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 取消の順に確かめる。本文は読まない（番号も中身も無い）。
 * 取消できるか（何も受け取っていないか）は DB が決める。
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

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await submitCancelReturn(deps, { returnId: parsedId.data, actorId: guard.userId });
    if (result.kind === 'refused') {
      return respondToRefusal(result.code, { audit, refusedDetail: 'Return cancel refused' });
    }
    // 取消の答えだけは、項目の名前が status（ほかは returnStatus）。窓口の答えは returnStatus にそろえる（C-3）
    await audit('success', 'Return cancelled', { return_status: result.status });
    return NextResponse.json({ data: { returnStatus: result.status } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return cancel refused',
      failureDetail: 'Failed to cancel return',
      failureKind: 'update',
    });
  }
}
