import { NextResponse } from 'next/server';
import { z } from 'zod';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import {
  MAX_FEE_YEN,
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  optionalCarrier,
  optionalText,
  optionalTrackingNumber,
  respondToReturnError,
} from '@/lib/orders/returns/return-route-support';
import { approveReturn } from '@/lib/orders/returns/return-store';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTION = 'admin.orders.return.approve';

const lineSchema = z
  .object({
    returnLineId: z.string().uuid(),
    resolution: z.enum(['refund', 'exchange']),
    exchangeVariantId: z.number().int().positive().nullish().transform((value) => value ?? null),
    exchangeMethod: z.enum(['stock', 'make']).nullish().transform((value) => value ?? null),
  })
  // 段1の作るの窓口・DB の CHECK と同じ。交換なら色・サイズと送り方が両方要り、返金なら両方とも無い
  .refine((line) =>
    line.resolution === 'exchange'
      ? line.exchangeVariantId !== null && line.exchangeMethod !== null
      : line.exchangeVariantId === null && line.exchangeMethod === null,
  );

const bodySchema = z.object({
  // 返品の全部の行の解決を一度に決める（行を足す・外す・数を変えることはできない）。
  // 窓口は形と重なりだけを見る。返品の行をちょうど1回ずつ含むかは DB が決める（RETURN_ARGUMENT_INVALID）
  lines: z
    .array(lineSchema)
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((line) => line.returnLineId)).size === lines.length),
  returnMethod: z.enum(['customer_ships', 'shop_label', 'not_required']),
  returnShippingPayer: z.enum(['shop', 'customer']),
  returnCarrier: optionalCarrier,
  returnTrackingNumber: optionalTrackingNumber,
  // 手数料の4つは必須の整数。画面は返品の今の値（申し込みの時の仮の値）を最初の値にして送る（Task 11）。円の3つは 1,000,000 円まで
  returnShippingFee: z.number().int().min(0).max(MAX_FEE_YEN),
  restockingFeePercent: z.number().int().min(0).max(100),
  exchangeFee: z.number().int().min(0).max(MAX_FEE_YEN),
  exchangeShippingFee: z.number().int().min(0).max(MAX_FEE_YEN),
  shopNote: optionalText(ADMIN_NOTE_MAX_LENGTH),
  notifyCustomer: z.boolean(),
});

/**
 * お客様の返品・交換の申し込みを承認する（グループ E-3 段2、設計書 5-2）。解決の方法（返金／交換の色・サイズと送り方）・返送の方法と負担・
 * 手数料・メモ・お知らせを決めて、申し込み中（requested）の返品を受付中（open）にする。お金も在庫も動かさない。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 承認の順に確かめる。
 * 二重防止の番号は持たず、状態で守る（2回目は DB が RETURN_STATE_CONFLICT で断る）。
 * 受付のお知らせの予定は DB が同じ取引で書く（知らせる時だけ）ので、成功の後に送る処理を動かす。監査にメモ・伝票番号は入れない。
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
    // 入力値や検証の詳細はメモなどを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const input = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await approveReturn(store, { returnId: parsedId.data, actorId: guard.userId, ...input });
    await audit('success', 'Return approved', {
      return_status: result.returnStatus,
      line_count: input.lines.length,
      return_method: input.returnMethod,
      notify_customer: input.notifyCustomer,
    });
    if (input.notifyCustomer) {
      scheduleOrderEmailDelivery();
    }
    return NextResponse.json({ data: { returnStatus: result.returnStatus } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return approve refused',
      failureDetail: 'Failed to approve return',
      failureKind: 'approve',
    });
  }
}
