import { logAudit } from '@/lib/audit';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { applyRefundSideEffects, type RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import {
  getOrderRefund,
  recordExternalOrderRefund,
  recordOrderRefundResult,
  type RefundResultRow,
} from '@/lib/orders/refund/refund-store';
import {
  listPaymentIntentRefunds,
  readPaymentMethodType,
  type StripeRefundSnapshot,
} from '@/lib/orders/refund/refund-stripe';

/**
 * 支払いの番号から、その支払いの Stripe の返金を全部読み直し、1件ずつ返金の記録に合わせる（グループ E-2 設計書 6-1）。
 * Stripe の知らせ・毎時の見回り・毎晩の照合・決済の照合が、同じものを呼ぶ。何度呼んでも同じ結果に収まる。
 * 知らせは順番どおりに届かず重なるので、知らせの中身は使わず、読み直した現在値だけで合わせる。
 */

/**
 * 支払いの番号を持つ注文が無い（注文を作れなかった支払いなど）。再試行しても直らないので、呼ぶ側が見分けて飛ばす。
 * Error のままで、文は変えない。
 */
export class OrderNotFoundForPaymentIntentError extends Error {
  constructor() {
    super('Order not found for Stripe PaymentIntent');
    this.name = 'OrderNotFoundForPaymentIntentError';
  }
}

/** 3回続けて、書いている間に Stripe の返金が変わった。読み直せば収まるので、呼ぶ側は一時的な失敗として扱える */
export class RefundSyncNotConvergedError extends Error {
  constructor() {
    super('Stripe refunds kept changing while they were synced to the order');
    this.name = 'RefundSyncNotConvergedError';
  }
}

export type RefundSyncResult =
  | { kind: 'synced'; orderId: string; orderStatus: OrderStatus; results: RefundResultRow[] }
  | { kind: 'skipped_unpaid'; orderId: string; orderStatus: OrderStatus };

/** 書いた後に Stripe を読み直して、返金が変わっていた時にやり直す回数の上限 */
const MAX_SYNC_ATTEMPTS = 3;

/** 入金が決まる前の注文。返金は記録せず、入金が決まった後の決済の照合と毎晩の照合が合わせる（R-06） */
const UNPAID_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'payment_in_progress',
  'pending',
  'failed',
  'abandoned',
]);

/** 印 refund_id は uuid の列に渡すので、形を確かめてから使う（形が違うと DB が 22P02 で止まり、その返金の同期が永遠に失敗する） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SyncOrderRow = { id: string; status: OrderStatus };

async function readOrder(deps: RefundServiceDeps, paymentIntentId: string): Promise<SyncOrderRow> {
  const { data, error } = await deps.store
    .from('orders')
    .select('id, status')
    .eq('payment_intent_id', paymentIntentId)
    .maybeSingle<SyncOrderRow>();

  if (error) {
    // DB の誤りを cause に残し、呼ぶ側が一時的な失敗（接続・直列化）かを見分けられるようにする
    throw new Error(`Failed to read order refund state: ${error.message ?? 'database error'}`, { cause: error });
  }
  if (!data) {
    throw new OrderNotFoundForPaymentIntentError();
  }
  return data;
}

/** 作った時刻の古い順（同じ時刻は番号順）。全額に届く返金が、未発送の商品を引き受ける順を、実際の順にそろえる */
function oldestFirst(refunds: readonly StripeRefundSnapshot[]): StripeRefundSnapshot[] {
  return [...refunds].sort(
    (a, b) => Date.parse(a.created) - Date.parse(b.created) || a.stripeRefundId.localeCompare(b.stripeRefundId),
  );
}

/** 返金の番号と状態の組。書いている間に変わったかを見る */
function refundKey(refunds: readonly StripeRefundSnapshot[]): string {
  return refunds
    .map((refund) => `${refund.stripeRefundId}:${refund.stripeStatus}`)
    .sort()
    .join(',');
}

/** 印はあるが、この注文の記録に当たらない返金。Stripe の返金の番号と印だけを監査に残す（個人情報は入れない） */
async function auditUnmatchedMarker(orderId: string, refund: StripeRefundSnapshot): Promise<void> {
  await logAudit({
    action: 'stripe.refund.marker_unmatched',
    resource: 'orders',
    resource_id: orderId,
    outcome: 'conflict',
    detail: 'Refund carries a refund_id marker that does not match a refund record of the order',
    metadata: { stripe_refund_id: refund.stripeRefundId, marker_refund_id: refund.metadataRefundId },
  });
}

/** 一覧の写しの支払いの種類は null（Task 5 の一覧は支払いを読まない）。要る時に、Stripe から読んで添える（写しが持っていれば、そのまま使う） */
async function withPaymentMethod(
  refund: StripeRefundSnapshot,
  readPaymentMethod: () => Promise<string | null>,
): Promise<StripeRefundSnapshot> {
  return refund.paymentMethodType === null ? { ...refund, paymentMethodType: await readPaymentMethod() } : refund;
}

async function writeRefund(
  deps: RefundServiceDeps,
  order: SyncOrderRow,
  refund: StripeRefundSnapshot,
  readPaymentMethod: () => Promise<string | null>,
): Promise<RefundResultRow> {
  const marker = refund.metadataRefundId;
  if (marker && UUID_PATTERN.test(marker)) {
    const own = await getOrderRefund(deps.store, marker);
    if (own && own.orderId === order.id) {
      // 返事待ち・エラーの記録は、頼んだ時の返事を書けなかった物なので、支払いの種類がまだ無い。写しに無ければ Stripe から読んで渡す
      // （コンビニ払いの返金のメールの文と画面の期限が、これで決まる）。返事を書けた記録には、書いた種類が入っている
      const lacksPaymentMethod = own.status === 'awaiting_response' || own.status === 'error';
      return recordOrderRefundResult(
        deps.store,
        own.refundId,
        lacksPaymentMethod ? await withPaymentMethod(refund, readPaymentMethod) : refund,
      );
    }
  }

  // 外からの返金。切り替えより前の物を写しにするかは、DB の関数が作った時刻で決める
  const external = await withPaymentMethod(refund, readPaymentMethod);
  const result = await recordExternalOrderRefund(deps.store, {
    orderId: order.id,
    amount: external.amount,
    stripeReason: external.reason,
    stripeCreatedAt: external.created,
    stripeRefundId: external.stripeRefundId,
    stripeStatus: external.stripeStatus,
    pendingReason: external.pendingReason,
    failureReason: external.failureReason,
    customerActionExpiresAt: external.customerActionExpiresAt,
    paymentMethodType: external.paymentMethodType,
    referenceNumber: external.referenceNumber,
    referenceType: external.referenceType,
  });
  // 印はあるのにこの注文の記録に当たらない返金の監査は、記録を作った時の1回だけ残す（同じ支払いの同期は何度も走る）
  if (marker && result.created) {
    await auditUnmatchedMarker(order.id, refund);
  }
  return result;
}

export async function syncPaymentIntentRefunds(deps: RefundServiceDeps, paymentIntentId: string): Promise<RefundSyncResult> {
  const order = await readOrder(deps, paymentIntentId);
  if (UNPAID_STATUSES.has(order.status)) {
    return { kind: 'skipped_unpaid', orderId: order.id, orderStatus: order.status };
  }

  // 支払いの種類が要る時だけ、Stripe の支払いから読む。1回の同期で1回
  let paymentMethodType: Promise<string | null> | null = null;
  const readPaymentMethod = () => (paymentMethodType ??= readPaymentMethodType(deps.stripe, paymentIntentId));

  let refunds = await listPaymentIntentRefunds(deps.stripe, paymentIntentId);
  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const results: RefundResultRow[] = [];
    for (const refund of oldestFirst(refunds)) {
      const result = await writeRefund(deps, order, refund, readPaymentMethod);
      results.push(result);
      // 後の始末は例外を投げない（記録はもう書けているので、落ちても結果を変えない。Task 5 の決め事）
      await applyRefundSideEffects(deps, result);
    }

    // 書いている間に、後から届いた知らせの分だけ Stripe が変わることがある。読み直して、古い一覧が最後に勝たないようにする
    const confirmed = await listPaymentIntentRefunds(deps.stripe, paymentIntentId);
    if (refundKey(confirmed) === refundKey(refunds)) {
      return {
        kind: 'synced',
        orderId: order.id,
        orderStatus: results.length > 0 ? results[results.length - 1].orderStatus : order.status,
        results,
      };
    }
    refunds = confirmed;
  }

  throw new RefundSyncNotConvergedError();
}
