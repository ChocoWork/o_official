import { NextResponse } from 'next/server';
import { z } from 'zod';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { declineCancelRequest } from '@/lib/orders/returns/cancel-request-store';
import {
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  respondToReturnError,
} from '@/lib/orders/returns/return-route-support';
import { RETURN_DECLINE_REASONS } from '@/lib/orders/returns/return-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTION = 'admin.orders.cancel_request.decline';

const bodySchema = z.object({
  // 返品のお断りと同じ。理由は店の中だけ、メッセージはお客様のメールに届く（前後の空白を除いて1〜1000字）
  declineReason: z.enum(RETURN_DECLINE_REASONS),
  declineMessage: z.string().trim().min(1).max(1000),
});

/**
 * キャンセルの申し込みをお断りする（グループ E-3 段2、設計書 5-4）。申し込み中（requested）の申し込みを declined にする。注文は変えない。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 申し込みの番号 → 本文 → お断りの順に確かめる。状態で守る（2回目は DB が断る）。
 * お断りのお知らせの予定は DB がいつも書くので、成功の後に送る処理を動かす。監査にはお断りの理由の記号だけを残し、メッセージは入れない。
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
    // メッセージを含みうるので、検証の詳細は残さず固定の文だけにする
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { declineReason, declineMessage } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await declineCancelRequest(store, {
      cancelRequestId: parsedId.data,
      actorId: guard.userId,
      declineReason,
      declineMessage,
    });
    await audit('success', 'Cancel request declined', { status: result.status, decline_reason: declineReason });
    scheduleOrderEmailDelivery();
    return NextResponse.json({ data: { status: result.status } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Cancel request decline refused',
      failureDetail: 'Failed to decline cancel request',
      failureKind: 'cancelRequestUpdate',
    });
  }
}
