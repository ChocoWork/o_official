import { z } from 'zod';

function normalizeNfkcText(value: string): string {
  return value.normalize('NFKC').trim();
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = normalizeNfkcText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalEmail(value: unknown): string | undefined {
  const normalized = normalizeOptionalText(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function normalizeOptionalPostalCode(value: unknown): string | undefined {
  const normalized = normalizeOptionalText(value);
  return normalized ? normalized.replace(/[^0-9]/g, '') : undefined;
}

function normalizeOptionalPhone(value: unknown): string | undefined {
  const normalized = normalizeOptionalText(value);
  return normalized ? normalized.replace(/[\s()-]/g, '') : undefined;
}

const normalizedEmailSchema = z.preprocess(
  normalizeOptionalEmail,
  z.string().email().max(254).optional()
);

const normalizedFullNameSchema = z.preprocess(
  normalizeOptionalText,
  z
    .string()
    .max(100)
    .regex(/^[\p{L}\p{M}\p{N}\s'’\-・.]+$/u, 'Invalid fullName format')
    .optional()
);

const normalizedPostalCodeSchema = z.preprocess(
  normalizeOptionalPostalCode,
  z.string().regex(/^\d{7}$/, 'Invalid postalCode format').optional()
);

const normalizedAddressComponentSchema = z.preprocess(
  normalizeOptionalText,
  z
    .string()
    .max(150)
    .regex(/^[\p{L}\p{M}\p{N}\s\-ー−‐/／.,、。()（）#＃丁目番地号]+$/u, 'Invalid address format')
    .optional()
);

const normalizedPrefectureSchema = z.preprocess(
  normalizeOptionalText,
  z
    .string()
    .max(50)
    .regex(/^[\p{L}\p{M}\p{N}\s\-ー−‐()（）]+$/u, 'Invalid prefecture format')
    .optional()
);

const normalizedCitySchema = z.preprocess(
  normalizeOptionalText,
  z
    .string()
    .max(100)
    .regex(/^[\p{L}\p{M}\p{N}\s\-ー−‐/／.,、。()（）丁目番地号]+$/u, 'Invalid city format')
    .optional()
);

const normalizedPhoneSchema = z.preprocess(
  normalizeOptionalPhone,
  z.string().regex(/^\+?\d{10,15}$/, 'Invalid phone format').optional()
);

export const STRIPE_CHECKOUT_PAYMENT_METHODS = [
  'stripe_card',
  'stripe_paypay',
  'stripe_konbini',
] as const;

export type StripeCheckoutPaymentMethod =
  (typeof STRIPE_CHECKOUT_PAYMENT_METHODS)[number];

export const checkoutShippingSchema = z
  .object({
    email: normalizedEmailSchema,
    fullName: normalizedFullNameSchema,
    // フリガナは注文に残す（FREQ-384）。氏名と同じ正規化・同じ文字種でよい
    kanaName: normalizedFullNameSchema,
    postalCode: normalizedPostalCodeSchema,
    prefecture: normalizedPrefectureSchema,
    city: normalizedCitySchema,
    address: normalizedAddressComponentSchema,
    building: normalizedAddressComponentSchema,
    phone: normalizedPhoneSchema,
  })
  .optional();

export type CheckoutCartSnapshotRow = {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
};

export type CheckoutItemSnapshotRow = {
  id: number;
  name: string;
  price: number;
  image_url: string | null;
  status: string;
};

export type CheckoutDraftItemSnapshot = {
  source_cart_id: string;
  item_id: number;
  item_name: string;
  item_price: number;
  item_image_url: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  line_total: number;
};

export type CheckoutDraftItemsSnapshot = CheckoutDraftItemSnapshot[];

export type CheckoutShippingSnapshot = {
  email: string | null;
  fullName: string | null;
  kanaName: string | null;
  postalCode: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
  building: string | null;
  phone: string | null;
};

/**
 * 合計が 0 の Checkout セッションは注文にできない（FREQ-389）。
 *
 * 注文の重複判定は `orders.checkout_session_id` を使うため、PaymentIntent が無くても同じ Session から
 * 注文を特定できる。
 *
 * 0円 Checkout は complete API が `ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL` で監査して拒否する。Webhook は
 * 照合関数を通り、注文なしを `ok:record_only:zero_amount` として記録する（FREQ-397）。
 */
export const ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL = 'Zero-amount checkout session is not supported';

export function isZeroAmountCheckoutSession(session: { amount_total?: number | null }): boolean {
  return session.amount_total === 0;
}

/**
 * 受け取った配送先を、draft に残す形に揃える。
 *
 * 下書きに配送先の写しを書くのは「確認へ進む」（create-session）だけ。写しの形をここに1つだけ置く。
 */
export function buildShippingSnapshot(
  shipping: NonNullable<z.infer<typeof checkoutShippingSchema>> | undefined
): CheckoutShippingSnapshot {
  return {
    email: shipping?.email ?? null,
    fullName: shipping?.fullName ?? null,
    kanaName: shipping?.kanaName ?? null,
    postalCode: shipping?.postalCode ?? null,
    prefecture: shipping?.prefecture ?? null,
    city: shipping?.city ?? null,
    address: shipping?.address ?? null,
    building: shipping?.building ?? null,
    phone: shipping?.phone ?? null,
  };
}

/**
 * 配送先として意味のある住所が入っているか（郵便番号・都道府県・市区町村・番地のどれか）。
 *
 * create-session の再利用経路は、これが true の draft を上書きしない。別タブが入力済みの
 * 住所を、プロフィール既定値や空欄で潰さないため（FREQ-365）。
 */
const SHIPPING_ADDRESS_FIELDS = ['postalCode', 'prefecture', 'city', 'address'] as const;

export function hasShippingAddress(
  snapshot: CheckoutShippingSnapshot | null | undefined
): boolean {
  if (!snapshot) return false;
  return SHIPPING_ADDRESS_FIELDS.some((field) => {
    const value = snapshot[field];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * 注文に必要な配送先の項目のうち、欠けているものを返す（建物名は任意）。
 *
 * 注文確定時に検証し、欠けていても支払い済みの注文は作るが、監査ログに残して
 * 出荷前に気づけるようにする（FREQ-365、OWASP ASVS V11.1.5 / V11.1.7）。
 */
const REQUIRED_SHIPPING_FIELDS = [
  'email',
  'fullName',
  'postalCode',
  'prefecture',
  'city',
  'address',
  'phone',
] as const;

export function findMissingShippingFields(
  snapshot: CheckoutShippingSnapshot | null | undefined
): string[] {
  if (!snapshot) return [...REQUIRED_SHIPPING_FIELDS];
  return REQUIRED_SHIPPING_FIELDS.filter((field) => {
    const value = snapshot[field];
    return typeof value !== 'string' || value.trim() === '';
  });
}

export type CheckoutDraftRow = {
  id: string;
  session_id: string;
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  payment_method: string;
  total_amount: number;
  /** Stripe のプロモーションコードで引かれた額。total_amount は割引前のまま残り、受付 RPC が discount_amount だけを書き戻す。 */
  discount_amount: number;
  currency: string;
  shipping_snapshot: CheckoutShippingSnapshot | null;
  items_snapshot: CheckoutDraftItemsSnapshot | null;
  status: string;
};

export function isStripeCheckoutPaymentMethod(
  value: unknown
): value is StripeCheckoutPaymentMethod {
  return (
    typeof value === 'string' &&
    STRIPE_CHECKOUT_PAYMENT_METHODS.includes(
      value as StripeCheckoutPaymentMethod
    )
  );
}

export function mapStripePaymentMethodType(
  value: string | undefined
): StripeCheckoutPaymentMethod | string {
  if (value === 'card') {
    return 'stripe_card';
  }

  if (value === 'paypay') {
    return 'stripe_paypay';
  }

  if (value === 'konbini') {
    return 'stripe_konbini';
  }

  // 上記3つ以外（link / customer_balance / alipay 等）は丸めず、
  // Stripe の種別文字列をそのまま記録専用の値として通す（design §A-6）。
  // payment_method が確定していない場合のみ既定値 stripe_card へ落ちる。
  return value || 'stripe_card';
}

export function calculateCheckoutAmounts(
  cartRows: CheckoutCartSnapshotRow[],
  itemMap: Map<number, CheckoutItemSnapshotRow>
): {
  subtotalAmount: number;
  shippingAmount: number;
  totalAmount: number;
} {
  const subtotalAmount = cartRows.reduce((sum, cartItem) => {
    const price = itemMap.get(cartItem.item_id)?.price ?? 0;
    return sum + price * cartItem.quantity;
  }, 0);

  const shippingAmount = subtotalAmount === 0 ? 0 : 500;
  const totalAmount = subtotalAmount + shippingAmount;

  return {
    subtotalAmount,
    shippingAmount,
    totalAmount,
  };
}

export function getDraftIdFromStripeMetadata(
  metadata: Record<string, string> | null | undefined
): string | null {
  const draftId = metadata?.draft_id;
  return typeof draftId === 'string' && draftId.trim().length > 0
    ? draftId
    : null;
}
