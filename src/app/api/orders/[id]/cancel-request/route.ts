import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { CUSTOMER_CANCEL_REQUESTS_CLOSED_MESSAGE } from '@/lib/orders/returns/customer-return-messages';
import {
  CUSTOMER_RETURN_RATE_LIMITS,
  createCustomerAudit,
  customerJson,
  customerNoteSchema,
  guardCustomerWrite,
  invalidArgumentResponse,
  orderNotFoundResponse,
  parseOrderId,
  respondToCustomerReturnError,
} from '@/lib/orders/returns/customer-return-route-support';
import { requestCustomerCancel } from '@/lib/orders/returns/customer-return-store';

const ACTION = 'account.orders.cancel_request.create';

// 品がこの注文の品か・数が未発送の数までか・同じ品を2回入れていないかは DB が確かめる（ここでは形だけ）
const bodySchema = z.object({
  requestKey: z.string().uuid(),
  lines: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100),
  customerNote: customerNoteSchema,
});

/**
 * キャンセルを申し込む（グループ E-3 段2 設計書 9 章）。まだ発送していない品を、数つきで申し込む。
 * ログイン → CSRF → 回数の制限（送信元ごととお客様ごと）→ 注文の番号 → 中身 → DB の関数の順に確かめる。
 * お客様の番号はトークンの claims.sub だけから決める。同じ requestKey の送り直しは前の申し込みを返す（replayed）。
 * 申し込みを新しく書いた時だけ、返事の後にメールの送る処理を動かす。監査にご連絡事項は入れない。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardCustomerWrite(request, CUSTOMER_RETURN_RATE_LIMITS.cancelRequest);
  if (!guard.ok) {
    return guard.response;
  }
  const orderId = parseOrderId((await params).id);
  if (!orderId) {
    return orderNotFoundResponse();
  }
  const audit = createCustomerAudit(request, guard.customerId, { action: ACTION, orderId });

  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細はご連絡事項を含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return invalidArgumentResponse();
  }
  const { requestKey, lines, customerNote } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await requestCustomerCancel(store, {
      orderId,
      customerId: guard.customerId,
      requestKey,
      lines,
      customerNote,
    });
    await audit('success', 'Cancel request created', {
      cancel_request_id: result.cancelRequestId,
      line_count: lines.length,
      replayed: result.replayed,
    });
    // 受付と店への知らせのメールの行は DB の関数が同じ取引で書いた。新しく書いた時だけ、返事の後に送る
    if (!result.replayed) {
      scheduleOrderEmailDelivery();
    }
    return customerJson({ data: { cancelRequestId: result.cancelRequestId, replayed: result.replayed } });
  } catch (error) {
    return respondToCustomerReturnError(error, {
      audit,
      tag: ACTION,
      refusedDetail: 'Cancel request refused',
      failureDetail: 'Failed to create cancel request',
      requestsClosedMessage: CUSTOMER_CANCEL_REQUESTS_CLOSED_MESSAGE,
    });
  }
}
