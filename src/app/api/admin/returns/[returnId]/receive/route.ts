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
  optionalCarrier,
  optionalText,
  optionalTrackingNumber,
  resolveCanRefund,
  respondToReturnError,
  toReceiveReply,
  toRefusalReply,
} from '@/lib/orders/returns/return-route-support';
import { receiveReturnAndRefund } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.receive';

const unitSchema = z.object({
  returnLineId: z.string().uuid(),
  disposition: z.enum(['restocked', 'not_restocked', 'pending_inspection', 'sent_back']),
  quantity: z.number().int().min(1).max(999),
});

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  // 同じ品でも状態が違えば別の行（DB の主キーも「受け取り・返品の行・状態」で1行）。同じ品の同じ状態は数を足して1行で送る
  units: z
    .array(unitSchema)
    .min(1)
    .max(100) // DB の admin_receive_return が受ける行の数の上限と同じ
    .refine((units) => new Set(units.map((unit) => `${unit.returnLineId}:${unit.disposition}`)).size === units.length),
  // 在庫が足りない交換の行に、店長が「作って送る」か「返金に変える」を選ぶ。無ければ空
  exchangeOverrides: z
    .array(z.object({ returnLineId: z.string().uuid(), action: z.enum(['make', 'refund']) }))
    .max(100)
    .refine((overrides) => new Set(overrides.map((override) => override.returnLineId)).size === overrides.length)
    .default([]),
  refundChoice: z.enum(['now', 'consult', 'none']),
  // 省く／null は「計算どおり」。0は返金しないで終える意味で、0のまま渡す。額を直せるのは店長だけ（DB が返せる額までを確かめる）
  refundAmount: optionalAmount,
  refundShippingAmount: z.number().int().min(0).max(MAX_AMOUNT).default(0),
  note: optionalText(ADMIN_NOTE_MAX_LENGTH),
  notifyCustomer: z.boolean(),
  sentBackMessage: optionalText(1000),
  sentBackCarrier: optionalCarrier,
  sentBackTrackingNumber: optionalTrackingNumber,
});

/**
 * 受け取る（グループ E-3 設計書 6-1・6-3）。品を1点ずつ確かめた結果（在庫に戻す・戻さない・検品待ち・お返し）を記録し、
 * 選んだ返金（今・相談・なし）を行う。今返金は Stripe に頼む（返金の流れが行う）。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 返金の権限 → 受け取りの流れの順に確かめる。
 * 返金の権限（admin.orders.refund）が要るのは、今返金・額の指定・送料の指定・交換の選び直しだけ。
 * 持たない人（サポート）は相談・なしの受け取りができる。答えが分からない時（502）も返金の番号と受け取りの番号を返し、
 * 画面は同じ requestKey で送り直して確かめる。監査にメモ・お返しのメッセージ・伝票番号は入れない。
 */
export async function POST(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const guard = await guardReturnWrite(request, { rateLimit: RETURN_RATE_LIMITS.receive, requireRefundPermission: false });
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
    // 入力値や検証の詳細はメモ・メッセージなどを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const input = parsedBody.data;

  const refundSide = await resolveCanRefund(request);
  if (!refundSide.ok) {
    return refundSide.response;
  }
  // 今返金・額の指定（0を含む）・送料の指定・交換の選び直しは店長だけ。DB も _actor_can_refund で断る（二重の守り）
  const needsRefundPermission =
    input.refundChoice === 'now'
    || input.refundAmount !== null
    || input.refundShippingAmount > 0
    || input.exchangeOverrides.length > 0;
  if (needsRefundPermission && !refundSide.canRefund) {
    const reply = toRefusalReply('RETURN_FORBIDDEN', 'Refund permission is missing');
    await audit(reply.audit.outcome, reply.audit.detail, reply.audit.metadata);
    return NextResponse.json(reply.body, { status: reply.status });
  }

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await receiveReturnAndRefund(deps, {
      returnId: parsedId.data,
      actorId: guard.userId,
      actorCanRefund: refundSide.canRefund,
      ...input,
    });
    const reply = toReceiveReply(result);
    await audit(reply.audit.outcome, reply.audit.detail, {
      ...reply.audit.metadata,
      refund_choice: input.refundChoice,
      unit_count: input.units.reduce((total, unit) => total + unit.quantity, 0),
    });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return receive refused',
      failureDetail: 'Failed to receive return',
      failureKind: 'receive',
    });
  }
}
