import type Stripe from 'stripe';
import type { StripeRefundFields } from '@/lib/orders/refund/refund-store';
import type { StripeRefundReason } from '@/lib/orders/refund/refund-types';

/**
 * Stripe の返金を頼む・読む（グループ E-2 設計書 3-2・6-1）。Stripe の型はこのファイルで止め、
 * 返金の記録に書く形（StripeRefundFields）に直して返す。
 * Stripe の印（metadata）には、注文・返金の記録・実行した人の番号だけを入れる。お客様の名前・メール・住所は入れない。
 */

/** Stripe の返金の写し。記録に書く StripeRefundFields に、突き合わせに要る項目を足した物 */
export type StripeRefundSnapshot = StripeRefundFields & {
  amount: number;
  reason: string | null;
  /** Stripe が返金を作った時刻（ISO） */
  created: string;
  paymentIntentId: string | null;
  /** こちらが頼んだ時に付けた印。印の無い返金（Stripe の画面からの返金）は null */
  metadataRefundId: string | null;
  metadataOrderId: string | null;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function metadataValue(metadata: Stripe.Metadata | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Stripe の返金を、記録に書く形に写す。支払いの種類は返金からは読めないので、呼ぶ側が Stripe の支払いから読んで渡す
 * （readPaymentMethodType）。Stripe の状態は読み替えない（保留・成功・失敗への読み替えは DB の関数が行う）。
 */
export function toStripeRefundSnapshot(refund: Stripe.Refund, paymentMethodType: string | null): StripeRefundSnapshot {
  const expiresAt = refund.next_action?.display_details?.expires_at;
  const destination = refund.destination_details;
  const card = destination?.card;

  return {
    stripeRefundId: refund.id,
    // 状態の無い返金は、お金が戻ったとは言えない。保留として書き、次の読み直しで本当の状態に進める
    stripeStatus: refund.status ?? 'pending',
    pendingReason: refund.pending_reason ?? null,
    failureReason: refund.failure_reason ?? null,
    customerActionExpiresAt: typeof expiresAt === 'number' ? isoFromSeconds(expiresAt) : null,
    paymentMethodType,
    // 照会番号（ARN など）はカードの返金だけに付く。届くまでは null。その種類は、card.reference_type が無ければ返金先の種類。
    // 空の文字は null にする（記録の列は1文字以上で、空の文字が届くと結果を書く関数が止まる）
    referenceNumber: card?.reference || null,
    referenceType: card?.reference_type || destination?.type || null,
    amount: refund.amount,
    reason: refund.reason ?? null,
    created: isoFromSeconds(refund.created),
    paymentIntentId:
      typeof refund.payment_intent === 'string' ? refund.payment_intent : (refund.payment_intent?.id ?? null),
    metadataRefundId: metadataValue(refund.metadata, 'refund_id'),
    metadataOrderId: metadataValue(refund.metadata, 'order_id'),
  };
}

/** Stripe への重複防止キー。同じ記録の確かめ直しだけが同じキーになり、別の返金は別のキーになる（R-03） */
export function refundIdempotencyKey(refundId: string): string {
  return `order-refund-${refundId}`;
}

export type CreateStripeRefundInput = {
  refundId: string;
  orderId: string;
  actorId: string | null;
  paymentIntentId: string;
  amount: number;
  stripeReason: StripeRefundReason | null;
  instructionsEmail: string | null;
};

export type CreateStripeRefundOutcome =
  | { kind: 'created'; refund: StripeRefundSnapshot }
  | { kind: 'rejected'; code: string | null }
  | { kind: 'unknown' };

// Stripe が受け付けなかったと言える HTTP の状態（頼みの内容が悪い・カードが使えない・対象が無い・重なった）
const REJECTED_STATUS_CODES: ReadonlySet<number> = new Set([400, 402, 404, 409]);

/**
 * Stripe の誤りを、断られた（返金は作られていない）か、分からない（作られたかもしれない）かに分ける。
 * 分からないのは、通信の誤り・API の誤り・500 番台・回数の制限・時間切れ・重複防止キーの誤り・こちらの想定外。
 */
function classifyCreateError(error: unknown): CreateStripeRefundOutcome {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    type?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
  const code = typeof failure.code === 'string' ? failure.code : null;

  // 同じキーの頼みが処理の途中（idempotency_key_in_use）と、同じキーで中身の違う頼み（StripeIdempotencyError）。
  // どちらも、前の頼みが通っているかもしれず、Stripe はその結果を教えない。断られたとは言えない
  // （エラーにして返せる額を戻すと、通っていた時に二重の返金を許す）。記録は返事待ちのまま、毎時の見回りが印で確かめる
  if (code === 'idempotency_key_in_use' || failure.type === 'StripeIdempotencyError') {
    return { kind: 'unknown' };
  }
  if (failure.type === 'StripeCardError') {
    return { kind: 'rejected', code };
  }
  if (
    failure.type === 'StripeInvalidRequestError'
    && typeof failure.statusCode === 'number'
    && REJECTED_STATUS_CODES.has(failure.statusCode)
  ) {
    return { kind: 'rejected', code };
  }
  return { kind: 'unknown' };
}

/**
 * Stripe に返金を頼む。重複防止キーは order-refund-{記録の番号}。例外は投げず、結果を3つに分けて返す。
 * 返す写しの paymentMethodType は null。頼む前に読んだ支払いの種類は、呼ぶ側が記録に書く。
 */
export async function createStripeRefund(stripe: Stripe, input: CreateStripeRefundInput): Promise<CreateStripeRefundOutcome> {
  const metadata: Record<string, string> = { order_id: input.orderId, refund_id: input.refundId };
  if (input.actorId) {
    metadata.actor_id = input.actorId;
  }

  const params: Stripe.RefundCreateParams = {
    payment_intent: input.paymentIntentId,
    amount: input.amount,
    metadata,
  };
  // 理由を付けない返金（自動の返金①）は、reason ごと送らない
  if (input.stripeReason) {
    params.reason = input.stripeReason;
  }
  // コンビニ払いは Stripe に返金の仕組みが無く、お客様が口座を入れるお願いのメールを Stripe が送る。その宛先
  if (input.instructionsEmail) {
    params.instructions_email = input.instructionsEmail;
  }

  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(params, { idempotencyKey: refundIdempotencyKey(input.refundId) });
  } catch (error) {
    return classifyCreateError(error);
  }
  return { kind: 'created', refund: toStripeRefundSnapshot(refund, null) };
}

/** latest_charge.payment_method_details.type（card・konbini・paypay など）。読めなければ null */
export async function readPaymentMethodType(stripe: Stripe, paymentIntentId: string): Promise<string | null> {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = paymentIntent.latest_charge;
    return typeof charge === 'object' && charge !== null ? (charge.payment_method_details?.type ?? null) : null;
  } catch (error) {
    // 種類は、戻る時期の文とコンビニ払いの宛先を決めるためだけに読む。読めなくても返金は止めない
    console.warn('[refund] payment method type was not read', errorName(error));
    return null;
  }
}

/**
 * その支払いの返金を全部読む（ページを全部たどる）。写しの支払いの種類は null（createStripeRefund と同じ）。
 * 一覧は毎時の見回りと取り込みが何度も読むので、支払いは読まない。種類が要る時は、呼ぶ側が readPaymentMethodType で1回読む
 */
export async function listPaymentIntentRefunds(stripe: Stripe, paymentIntentId: string): Promise<StripeRefundSnapshot[]> {
  const snapshots: StripeRefundSnapshot[] = [];
  // 自動のページ送りは、1回の取得が100件まででも、全部のページを順にたどる
  for await (const refund of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
    snapshots.push(toStripeRefundSnapshot(refund, null));
  }
  return snapshots;
}
