import {
  isStripeCheckoutPaymentMethod,
  mapStripePaymentMethodType,
  type StripeCheckoutPaymentMethod,
} from '@/features/checkout/services/checkout-draft.service';

/**
 * `resolvePaymentMethodFromSession` が実際に読む部分だけを表す構造的な型。
 *
 * 本物の `Stripe.Checkout.Session`（`stripe.checkout.sessions.retrieve` の戻り値）は
 * これを満たすスーパーセットなのでそのまま渡せる。テストでも巨大な Stripe 型を
 * 満たす必要がなく、必要なフィールドだけのフィクスチャで済む。
 */
type PaymentMethodForResolution = {
  type?: string | null;
};

type ChargeForResolution = {
  payment_method_details?: PaymentMethodForResolution | null;
};

type PaymentIntentForResolution = {
  payment_method_types?: string[] | null;
  payment_method?: string | PaymentMethodForResolution | null;
  latest_charge?: string | ChargeForResolution | null;
};

export type SessionForPaymentMethodResolution = {
  payment_intent?: string | PaymentIntentForResolution | null;
  metadata?: Record<string, string> | null;
};

/** `resolvePaymentMethodFromPaymentIntent` が実際に読む部分だけを表す構造的な型。 */
export type PaymentIntentForPaymentMethodResolution = PaymentIntentForResolution;

// Apple Pay / Google Pay はカードで決済され、PaymentMethod の type は card になる
// （ウォレットの種別は card.wallet に入る）。注文にもカードとして記録される。
const CARD_WALLET_TYPES = ['apple_pay', 'google_pay'];

/**
 * 注文に記録された支払方法を表示名にする。
 * 注文詳細（/api/orders/[id]）と checkout の確認画面で共用し、同じ支払いを同じ名前で出す。
 */
export function mapPaymentMethodLabel(paymentMethod: string | null | undefined) {
  if (paymentMethod === 'stripe_card') {
    return 'クレジットカード';
  }

  if (paymentMethod === 'stripe_konbini') {
    return 'コンビニ払い';
  }

  if (paymentMethod === 'stripe_paypay') {
    return 'PayPay';
  }

  if (paymentMethod === 'link') {
    return 'Link';
  }

  if (paymentMethod === 'customer_balance') {
    return '銀行振込';
  }

  // 上記以外の値（新しく有効化された Stripe の決済手段等）は丸めず、
  // 記録されている値をそのまま表示する（レビュー指摘 C1）。
  return paymentMethod && paymentMethod.length > 0 ? paymentMethod : '-';
}

/**
 * 決済フォーム（PaymentElement）の change イベントの `value.type` を、
 * サーバが注文に記録する値（`resolvePaymentMethodFromSession` と同じ変換）にそろえる。
 * change イベントの前（未選択）は、サーバの既定値と同じ stripe_card になる。
 */
export function toRecordedPaymentMethod(
  selectedType: string | null | undefined
): StripeCheckoutPaymentMethod | string {
  if (selectedType && CARD_WALLET_TYPES.includes(selectedType)) {
    return 'stripe_card';
  }

  return mapStripePaymentMethodType(selectedType ?? undefined);
}

/**
 * create-session / complete に送る支払方法。API は3手段しか受け付けない（それ以外は 400）ので、
 * Link・銀行振込などは送らない。サーバは申告を採用せず Stripe から決めるため、送らなくても困らない。
 */
export function toCheckoutRequestPaymentMethod(
  selectedType: string | null | undefined
): StripeCheckoutPaymentMethod | undefined {
  const recorded = toRecordedPaymentMethod(selectedType);
  return isStripeCheckoutPaymentMethod(recorded) ? recorded : undefined;
}

/**
 * charge → payment_method → payment_method_types の順で、確定した Stripe 決済手段の
 * 型文字列（`card` / `konbini` 等、マッピング前）を PaymentIntent から解決する。
 * どの段でも情報が無ければ `undefined`（呼び出し側でさらにフォールバックする）。
 *
 * expand されなかった場合（`payment_method` / `latest_charge` が文字列 ID のまま）は、
 * そのフィールドを無いものとして扱い次の優先順位へ進む。
 */
function resolvePaymentMethodTypeFromPaymentIntent(
  paymentIntent: PaymentIntentForResolution | null
): string | undefined {
  const latestCharge =
    paymentIntent && typeof paymentIntent.latest_charge !== 'string'
      ? paymentIntent.latest_charge ?? null
      : null;

  const chargeType = latestCharge?.payment_method_details?.type;
  if (chargeType) {
    return chargeType;
  }

  const paymentMethod =
    paymentIntent && typeof paymentIntent.payment_method !== 'string'
      ? paymentIntent.payment_method ?? null
      : null;
  const paymentMethodType = paymentMethod?.type;
  if (paymentMethodType) {
    return paymentMethodType;
  }

  return paymentIntent?.payment_method_types?.[0] ?? undefined;
}

/**
 * 注文に記録する支払方法を決める。
 *
 * クライアント申告は採用しない（リダイレクト型の決済ではそもそも届かず、
 * 届いた場合も実際に使われた手段と一致する保証がないため）。
 *
 * 動的決済手段が有効な場合、PaymentIntent の payment_method_types は
 * 「利用可能な全手段の配列」であり客が選んだ手段ではない（通常 card が先頭に来る）。
 * そのため types[0] より先に、実際に確定した PaymentMethod（payment_intent.payment_method）
 * を優先する。
 *
 * 優先順位:
 * 1. 実際の charge の payment_method_details.type（最も確か）
 * 2. PaymentIntent.payment_method.type（charge 前でも確定済みの手段）
 * 3. PaymentIntent.payment_method_types[0]（手段すら確定していない最終手段）
 * 4. セッション metadata の selected_payment_method（生成時のクライアント初期値。最後の砦）
 * 5. 'stripe_card'（既定値）
 *
 * expand されなかった場合（`payment_intent` / `payment_method` / `latest_charge` が
 * 文字列 ID のまま）は、そのフィールドを無いものとして扱い次の優先順位へ進む。
 */
export function resolvePaymentMethodFromSession(
  session: SessionForPaymentMethodResolution
): StripeCheckoutPaymentMethod | string {
  const paymentIntent =
    typeof session.payment_intent === 'string' ? null : session.payment_intent ?? null;

  const intentType = resolvePaymentMethodTypeFromPaymentIntent(paymentIntent);
  if (intentType) {
    return mapStripePaymentMethodType(intentType);
  }

  const selectedPaymentMethod = session.metadata?.selected_payment_method;
  if (isStripeCheckoutPaymentMethod(selectedPaymentMethod)) {
    return selectedPaymentMethod;
  }

  return 'stripe_card';
}

/**
 * `payment_intent.succeeded` 経路向け。Checkout Session が存在しない（session metadata の
 * selected_payment_method を参照できない）ため、`resolvePaymentMethodFromSession` から
 * セッション由来の tier4 を除いた同じロジックで決める。
 *
 * 優先順位:
 * 1. 実際の charge の payment_method_details.type
 * 2. PaymentIntent.payment_method.type
 * 3. PaymentIntent.payment_method_types[0]
 * 4. 'stripe_card'（既定値）
 */
export function resolvePaymentMethodFromPaymentIntent(
  paymentIntent: PaymentIntentForPaymentMethodResolution
): StripeCheckoutPaymentMethod | string {
  const intentType = resolvePaymentMethodTypeFromPaymentIntent(paymentIntent);
  if (intentType) {
    return mapStripePaymentMethodType(intentType);
  }

  return 'stripe_card';
}
