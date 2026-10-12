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
import { submitReleaseReturnExchange } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.release_exchange';

/**
 * 支払いを待たずに送る（グループ E-3 設計書 6-4）。手数料のお支払いを待っている交換の品を、発送の画面で送れるようにする。
 * 手数料はお支払い待ちのまま残る（返品は完了にならない）。お客様にメールは送らない。
 * お金に関わるので、権限 admin.orders.return と admin.orders.refund → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 操作の順に確かめる。
 * 本文は読まない（番号も中身も無い）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const guard = await guardReturnWrite(request, { rateLimit: RETURN_RATE_LIMITS.update, requireRefundPermission: true });
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
    const result = await submitReleaseReturnExchange(deps, { returnId: parsedId.data, actorId: guard.userId });
    if (result.kind === 'refused') {
      return respondToRefusal(result.code, { audit, refusedDetail: 'Return exchange release refused' });
    }
    await audit('success', 'Return exchange released', { return_status: result.returnStatus });
    return NextResponse.json({ data: { returnStatus: result.returnStatus } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return exchange release refused',
      failureDetail: 'Failed to release return exchange',
      failureKind: 'update',
    });
  }
}
