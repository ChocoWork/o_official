import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { closeCancelRequest } from '@/lib/orders/returns/cancel-request-store';
import {
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  respondToReturnError,
} from '@/lib/orders/returns/return-route-support';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTION = 'admin.orders.cancel_request.close';

/**
 * キャンセルの申し込みを解決済みにする（グループ E-3 段2、設計書 5-4）。注文を変えず、お客様にメールも送らずに閉じる。
 * 品を外した返金・キャンセルを別の画面で済ませた後に、申し込みだけ閉じ残した時の逃げ道でもある。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 申し込みの番号 → 解決済みの順に確かめる。本文は読まない（番号も中身も無い）。
 * 状態で守る（開いていなければ DB が断る）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ cancelRequestId: string }> }) {
  const guard = await guardReturnWrite(request, { rateLimit: RETURN_RATE_LIMITS.cancelRequestUpdate, requireRefundPermission: false });
  if (!guard.ok) {
    return guard.response;
  }

  const { cancelRequestId } = await params;
  const audit = createReturnAudit(request, guard.userId, {
    action: ACTION,
    resource: 'order_cancel_requests',
    resourceId: cancelRequestId,
  });

  const parsedId = z.string().uuid().safeParse(cancelRequestId);
  if (!parsedId.success) {
    await audit('failure', 'Invalid cancel request id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const store = await createServiceRoleClient();
    const result = await closeCancelRequest(store, { cancelRequestId: parsedId.data, actorId: guard.userId });
    await audit('success', 'Cancel request closed', { status: result.status });
    return NextResponse.json({ data: { status: result.status } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Cancel request close refused',
      failureDetail: 'Failed to close cancel request',
      failureKind: 'cancelRequestUpdate',
    });
  }
}
