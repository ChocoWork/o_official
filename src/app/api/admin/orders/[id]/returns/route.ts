import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { loadRefundMaterials } from '@/lib/orders/refund/refund-materials';
import { INVALID_REQUEST_BODY, REFUND_ERROR_MESSAGES, refundErrorBody } from '@/lib/orders/refund/refund-messages';
import { createDefaultRefundServiceDeps } from '@/lib/orders/refund/refund-service';
import { loadReturnableUnits } from '@/lib/orders/returns/return-counts';
import {
  MAX_FEE_YEN,
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  optionalCarrier,
  optionalText,
  optionalTrackingNumber,
  resolveCanRefund,
  respondToRefusal,
  respondToReturnError,
  respondToReturnReadError,
} from '@/lib/orders/returns/return-route-support';
import { submitCreateReturn } from '@/lib/orders/returns/return-service';
import { getShopReturnSettings, listOrderReturns } from '@/lib/orders/returns/return-store';
import { RETURN_REASONS } from '@/lib/orders/returns/return-types';

const ACTION = 'admin.orders.return.create';

const lineSchema = z
  .object({
    fulfillmentId: z.string().uuid(),
    orderItemId: z.string().uuid(),
    quantity: z.number().int().min(1).max(999),
    reason: z.enum(RETURN_REASONS),
    reasonNote: optionalText(255),
    resolution: z.enum(['refund', 'exchange']),
    exchangeVariantId: z.number().int().positive().nullish().transform((value) => value ?? null),
    exchangeMethod: z.enum(['stock', 'make']).nullish().transform((value) => value ?? null),
  })
  // DB の CHECK と同じ。交換なら色・サイズと送り方が両方要り、返金なら両方とも無い
  .refine((line) =>
    line.resolution === 'exchange'
      ? line.exchangeVariantId !== null && line.exchangeMethod !== null
      : line.exchangeVariantId === null && line.exchangeMethod === null,
  );

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  // 同じ発送の同じ品でも、理由が違えば別の行にできる（2点は不良、1点は不要）ので、重なりは禁じない。数の上限は DB が確かめる
  lines: z.array(lineSchema).min(1).max(100),
  returnMethod: z.enum(['customer_ships', 'shop_label', 'not_required']),
  returnShippingPayer: z.enum(['shop', 'customer']),
  returnCarrier: optionalCarrier,
  returnTrackingNumber: optionalTrackingNumber,
  // 手数料の4つは必須の0以上の整数。画面は設定から入れた値（使わない手数料は 0）を送る（Task 10）。
  // 円の3つは Global Constraints の金額の上限（1,000,000 円。DB の RETURN_FEE_INVALID と同じ範囲）まで
  returnShippingFee: z.number().int().min(0).max(MAX_FEE_YEN),
  restockingFeePercent: z.number().int().min(0).max(100),
  exchangeFee: z.number().int().min(0).max(MAX_FEE_YEN),
  exchangeShippingFee: z.number().int().min(0).max(MAX_FEE_YEN),
  shopNote: optionalText(ADMIN_NOTE_MAX_LENGTH),
  notifyCustomer: z.boolean(),
});

/**
 * 注文の返品の一覧（グループ E-3 設計書 8-1）。返品ごとの中身・返金できるか・返品できる数・返せる額と送料・要検品の設定。
 * 返品の画面（注文ごと）を開いた時に読む。返品の権限の人だけが読める。読むだけなので CSRF と回数の制限は通さない。
 * 返金の権限（canRefund）は答えに入れるだけで、持たなくても読める（サポートの人は、額を決めて返金のボタンが出ない）。
 * 要検品（inspectionEnabled）は、受け取りの画面が「検品待ち」を選ばせるかに使う。設定の窓口は店長だけが読めるので、
 * サポートも読めるこの窓口に入れる（T7-15）。設定が読めなかった時は偽にせず、一覧全体を失敗にする。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.return', request);
  if (!authz.ok) {
    return authz.response;
  }
  const refundSide = await resolveCanRefund(request);
  if (!refundSide.ok) {
    return refundSide.response;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const client = await createServiceRoleClient();
    const [returns, returnableUnits, materials, settings] = await Promise.all([
      listOrderReturns(client, parsedId.data),
      loadReturnableUnits(client, parsedId.data),
      loadRefundMaterials(client, parsedId.data),
      getShopReturnSettings(client),
    ]);
    if (!materials) {
      return NextResponse.json(refundErrorBody('order_not_found'), { status: REFUND_ERROR_MESSAGES.order_not_found.status });
    }
    return NextResponse.json(
      {
        data: {
          returns,
          canRefund: refundSide.canRefund,
          returnableUnits,
          refundableAmount: materials.order.refundableAmount,
          refundableShipping: materials.order.refundableShipping,
          inspectionEnabled: settings.inspectionEnabled,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return respondToReturnReadError(error, { tag: '[admin.orders.return.list] Failed to load returns', failureKind: 'list' });
  }
}

/**
 * 返品を作る（グループ E-3 設計書 5-3）。お店が発送の行・数・理由・解決の方法（返金／交換）・返送・手数料を決めて、すぐ受付中の返品にする。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 注文の番号 → 中身 → 返品を作る入口の順に確かめる。
 * 受付のお知らせの送る処理は入口が動かす（新しく作って知らせる時だけ）。監査にメモ・伝票番号・連絡先は入れない。
 * 同じ requestKey の送り直しは前の結果を返す（replayed）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardReturnWrite(request, { rateLimit: RETURN_RATE_LIMITS.create, requireRefundPermission: false });
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const audit = createReturnAudit(request, guard.userId, { action: ACTION, resource: 'orders', resourceId: id });

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    await audit('failure', 'Invalid order id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細はメモなどを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const returnRequest = parsedBody.data;

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await submitCreateReturn(deps, { orderId: parsedId.data, actorId: guard.userId, ...returnRequest });
    if (result.kind === 'refused') {
      return respondToRefusal(result.code, { audit, refusedDetail: 'Return create refused' });
    }
    // 返品の番号の鍵に number を含めない（maskAuditEvent が number を含む鍵を伏せるため）。メモ・伝票番号は入れない
    await audit('success', 'Return created', {
      return_id: result.returnId,
      sequence: result.number,
      status: result.status,
      replayed: result.replayed,
      line_count: returnRequest.lines.length,
      notify_customer: returnRequest.notifyCustomer,
    });
    return NextResponse.json({
      data: { returnId: result.returnId, number: result.number, status: result.status, replayed: result.replayed },
    });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return create refused',
      failureDetail: 'Failed to create return',
      failureKind: 'create',
    });
  }
}
