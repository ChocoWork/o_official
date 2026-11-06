/**
 * 返品の受け取りの窓口（POST /api/admin/returns/[returnId]/receive）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-204
 * @design DD-ADMIN-018
 * @remarks 品ごとの返金の選びの食い違い・上限・P9 は DB が決める。窓口は形と権限だけを確かめ、額や返品の条件を推し量らない。
 */
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
  // 返金の品の選び。省くと旧い本文（DB が親の now・consult で補う）。品に mixed・none は無い
  refundChoice: z.enum(['now', 'consult']).optional(),
});

type UnitBody = z.infer<typeof unitSchema>;

/** 重複を見る鍵の選び。省いた品は、親が now・consult ならその値で補った選びで比べる（DB の補い方と同じ） */
function resolvedUnitChoice(unit: UnitBody, parent: string): string {
  return unit.refundChoice ?? (parent === 'now' || parent === 'consult' ? parent : '');
}

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  // 同じ品でも状態か返金の選びが違えば別の行。同じ品の同じ状態・同じ選びは数を足して1行で送る（重複は下の superRefine で断る）
  units: z
    .array(unitSchema)
    .min(1)
    .max(100), // DB の admin_receive_return が受ける行の数の上限と同じ
  // 在庫が足りない交換の行に、店長が「作って送る」か「返金に変える」を選ぶ。無ければ空
  exchangeOverrides: z
    .array(z.object({ returnLineId: z.string().uuid(), action: z.enum(['make', 'refund']) }))
    .max(100)
    .refine((overrides) => new Set(overrides.map((override) => override.returnLineId)).size === overrides.length)
    .default([]),
  // 品の選びのまとめ。mixed は今すぐと相談の品が両方ある時。まとめと品の選びの食い違いは DB が断る
  refundChoice: z.enum(['now', 'consult', 'mixed', 'none']),
  // 省く／null は「計算どおり」。0は返金しないで終える意味で、0のまま渡す。額を直せるのは店長だけ（DB が返せる額までを確かめる）
  refundAmount: optionalAmount,
  refundShippingAmount: z.number().int().min(0).max(MAX_AMOUNT).default(0),
  note: optionalText(ADMIN_NOTE_MAX_LENGTH),
  notifyCustomer: z.boolean(),
  sentBackMessage: optionalText(1000),
  sentBackCarrier: optionalCarrier,
  sentBackTrackingNumber: optionalTrackingNumber,
}).superRefine((body, context) => {
  const keys = body.units.map((unit) => `${unit.returnLineId}:${unit.disposition}:${resolvedUnitChoice(unit, body.refundChoice)}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['units'], message: 'duplicate unit' });
  }
  // mixed は品の選びで今すぐと相談の両方を送る（省いた品を mixed で補わない）。どの品が返金の品かは DB が決める
  if (
    body.refundChoice === 'mixed'
    && !(body.units.some((unit) => unit.refundChoice === 'now') && body.units.some((unit) => unit.refundChoice === 'consult'))
  ) {
    context.addIssue({ code: 'custom', path: ['refundChoice'], message: 'mixed needs now and consult units' });
  }
});

/**
 * 受け取る（グループ E-3 設計書 6-1・6-3）。品を1点ずつ確かめた結果（在庫に戻す・戻さない・検品待ち・お返し）を記録し、
 * 選んだ返金（今・相談・なし。品ごとに今と相談を選んだ時のまとめは mixed）を行う。今返金は Stripe に頼む（返金の流れが行う）。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 返金の権限 → 受け取りの流れの順に確かめる。
 * 返金の権限（admin.orders.refund）が要るのは、額の指定・送料の指定・交換の選び直しだけ。
 * 持たない人（サポート）は相談・なしの受け取りができ、お客様の申し込みの返品（返送不要でない）なら今返金も送れる
 * （額は DB が計算する。窓口は断らず DB に渡し、DB が許さない返品は RETURN_FORBIDDEN で断る。グループ E-3 段2 の P9）。
 * 答えが分からない時（502）も返金の番号と受け取りの番号を返し、
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
  // 額の指定（0を含む）・送料の指定・交換の選び直しは店長だけ。DB も _actor_can_refund で断る（二重の守り）。
  // 今返金は、サポートも「お客様の申し込みの返品（返送不要でない）」なら DB が許す（P9）ので、ここでは断らず DB に任せる
  const needsRefundPermission =
    input.refundAmount !== null
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
