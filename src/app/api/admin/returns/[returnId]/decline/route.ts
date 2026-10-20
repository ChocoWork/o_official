import { NextResponse } from 'next/server';
import { z } from 'zod';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import {
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  respondToReturnError,
} from '@/lib/orders/returns/return-route-support';
import { declineReturn } from '@/lib/orders/returns/return-store';
import { RETURN_DECLINE_REASONS } from '@/lib/orders/returns/return-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTION = 'admin.orders.return.decline';

const bodySchema = z.object({
  // 理由（店の中だけ。お客様には見えない）。メッセージはお客様のメールに届く。前後の空白を除いて1〜1000字
  declineReason: z.enum(RETURN_DECLINE_REASONS),
  declineMessage: z.string().trim().min(1).max(1000),
});

/**
 * お客様の返品・交換の申し込みをお断りする（グループ E-3 段2、設計書 5-2）。申し込み中（requested）の返品を declined にする。
 * お金も在庫も動かさない。品はまた申し込める。権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → お断りの順に確かめる。
 * 二重防止の番号は持たず、状態で守る。お断りのお知らせの予定は DB がいつも書くので、成功の後に送る処理を動かす。
 * 監査にはお断りの理由の記号だけを残し、お客様へのメッセージは入れない。
 */
export async function POST(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const guard = await guardReturnWrite(request, { rateLimit: RETURN_RATE_LIMITS.review, requireRefundPermission: false });
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
    // メッセージを含みうるので、検証の詳細は残さず固定の文だけにする
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { declineReason, declineMessage } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await declineReturn(store, {
      returnId: parsedId.data,
      actorId: guard.userId,
      declineReason,
      declineMessage,
    });
    await audit('success', 'Return declined', { return_status: result.returnStatus, decline_reason: declineReason });
    scheduleOrderEmailDelivery();
    return NextResponse.json({ data: { returnStatus: result.returnStatus } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return decline refused',
      failureDetail: 'Failed to decline return',
      failureKind: 'decline',
    });
  }
}
