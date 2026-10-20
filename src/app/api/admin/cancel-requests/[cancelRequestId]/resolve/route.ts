import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { resolveCancelRequest } from '@/lib/orders/returns/cancel-request-store';
import {
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  respondToReturnError,
} from '@/lib/orders/returns/return-route-support';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTION = 'admin.orders.cancel_request.resolve';

const bodySchema = z
  .object({
    // 品を外した返金の番号。未入金の取消・支払い済みのキャンセル（返金の記録を作らない道）で解決する時は null（省いてもよい）
    refundId: z.string().uuid().nullish().transform((value) => value ?? null),
    // 品を外した注文の取消を確かめて解決する時だけ真
    orderCancelled: z.boolean(),
  })
  // 返金の番号か取消の確かめの、どちらか1つ（DB の関数も同じ決まりで CANCEL_REQUEST_RESOLUTION_INVALID にする）
  .refine((body) => (body.refundId !== null) !== body.orderCancelled);

/**
 * キャンセルの申し込みを解決する（グループ E-3 段2、設計書 5-4）。品を外した返金・取消の記録ができた後に、画面が呼ぶ。
 * 返金が同じ注文で申し込みの後にできたか、注文が取消になっているかは DB が確かめる。失敗しても申し込みは開いたまま残り、
 * 「解決済みにする」で閉じられる。権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 申し込みの番号 → 本文 → 解決の順に確かめる。
 * メールは送らない。返金・キャンセルの記録は画面が別の窓口で済ませているので、返金の権限は求めない。
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
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { refundId, orderCancelled } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await resolveCancelRequest(store, {
      cancelRequestId: parsedId.data,
      actorId: guard.userId,
      refundId,
      orderCancelled,
    });
    await audit('success', 'Cancel request resolved', {
      status: result.status,
      refund_id: refundId,
      order_cancelled: orderCancelled,
    });
    return NextResponse.json({ data: { status: result.status } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Cancel request resolve refused',
      failureDetail: 'Failed to resolve cancel request',
      failureKind: 'cancelRequestUpdate',
    });
  }
}
