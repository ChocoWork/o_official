import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { createDefaultRefundServiceDeps } from '@/lib/orders/refund/refund-service';
import {
  MAX_AMOUNT,
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  optionalAmount,
  optionalText,
  respondToReturnError,
  toRefundReturnReply,
} from '@/lib/orders/returns/return-route-support';
import { refundReturnAndRequestStripe } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.refund';

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  // 0以上の整数か、省く／null。null は計算どおり、0は返金しないで終える（計画の冒頭 P20）。0は null に直さず0のまま渡す。
  // 店長は返せる額まで直せる（DB が確かめ、計算との差を adjustment_amount に残す）
  amount: optionalAmount,
  shippingAmount: z.number().int().min(0).max(MAX_AMOUNT).default(0),
  // 店だけのメモ。空は持たない（null）
  note: optionalText(ADMIN_NOTE_MAX_LENGTH),
  notifyCustomer: z.boolean(),
});

/**
 * 額を決めて返金する（グループ E-3 設計書 6-3）。相談の受け取りで返金待ちになった品の返金を、店長が額を決めて行う。
 * 額を0にすると、返金の記録を作らず Stripe にも頼まずに終える（waived）。
 * 権限 admin.orders.return と admin.orders.refund → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 返金の流れの順に確かめる。
 * 答えが分からない時（502）も返金の番号を返し、画面は同じ requestKey で送り直して確かめる。
 * 監査にメモ・宛先・連絡先は入れない。同じ requestKey の送り直しは前の結果を返す（replayed）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const guard = await guardReturnWrite(request, { rateLimit: RETURN_RATE_LIMITS.refund, requireRefundPermission: true });
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
    // 入力値や検証の詳細はメモなどを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await refundReturnAndRequestStripe(deps, {
      returnId: parsedId.data,
      actorId: guard.userId,
      ...parsedBody.data,
    });
    const reply = toRefundReturnReply(result);
    await audit(reply.audit.outcome, reply.audit.detail, { ...reply.audit.metadata, source: 'return' });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return refund refused',
      failureDetail: 'Failed to refund return',
      failureKind: 'refund',
    });
  }
}
