import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { createDefaultRefundServiceDeps } from '@/lib/orders/refund/refund-service';
import {
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  optionalText,
  respondToRefusal,
  respondToReturnError,
} from '@/lib/orders/returns/return-route-support';
import { submitRecordReturnFeePayment } from '@/lib/orders/returns/return-service';

const ACTION = 'admin.orders.return.fee_payment';

const bodySchema = z.object({
  // 受け取りの方法のメモ（お客様には見えない）。空は持たない（null）
  note: optionalText(ADMIN_NOTE_MAX_LENGTH),
  // 計画の冒頭 P27: 真は「いただかないで終える」（額を0に直す）。画面は「受け取りを記録する」で false、「いただかないで終える」で true を送る。
  // 省略を許すと、「いただかないで終える」の操作が黙って受け取りの記録になりうるので、必須の真偽にする（Task 4 の入力も同じ）
  waive: z.boolean(),
});

/**
 * 手数料の受け取りを記録する（グループ E-3 設計書 6-4）。引けなかった手数料を、お客様から別に受け取った印を付ける。
 * waive が真なら、受け取りの代わりに「いただかないで終える」（額を0に直す。計画の冒頭 P27）。同じ窓口・同じ権限・同じ監査の action で行う。
 * 受け取りを記録する（またはいただかないで終える）まで、手数料待ちの交換の品は送れず、返品は完了にならない。帳簿には自動で入らない。
 * お金に関わるので、権限 admin.orders.return と admin.orders.refund → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 返品の番号 → 本文 → 記録の順に確かめる。
 * 監査に受け取りの方法のメモを入れない（入れるのは番号・状態と waive の真偽だけ）。
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
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細はメモを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await submitRecordReturnFeePayment(deps, {
      returnId: parsedId.data,
      actorId: guard.userId,
      note: parsedBody.data.note,
      waive: parsedBody.data.waive,
    });
    if (result.kind === 'refused') {
      return respondToRefusal(result.code, { audit, refusedDetail: 'Return fee payment refused' });
    }
    // 新しい action は作らず、同じ action に waive の真偽を残す（メモは入れない）
    await audit('success', 'Return fee payment recorded', { return_status: result.returnStatus, waive: parsedBody.data.waive });
    return NextResponse.json({ data: { returnStatus: result.returnStatus } });
  } catch (error) {
    return respondToReturnError(error, {
      audit,
      action: ACTION,
      refusedDetail: 'Return fee payment refused',
      failureDetail: 'Failed to record return fee payment',
      failureKind: 'update',
    });
  }
}
