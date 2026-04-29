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
    postalCode: normalizedPostalCodeSchema,
    prefecture: normalizedPrefectureSchema,
    city: normalizedCitySchema,
    address: normalizedAddressComponentSchema,
    building: normalizedAddressComponentSchema,
    phone: normalizedPhoneSchema,
  })
  .optional();

export type CheckoutShippingSnapshot = z.infer<typeof checkoutShippingSchema>;

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
  stock_quantity: number | null;
  status: string;
};

export type CheckoutDraftRow = {
  id: string;
  session_id: string;
  total_amount: number;
  currency: string;
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
): StripeCheckoutPaymentMethod {
  if (value === 'paypay') {
    return 'stripe_paypay';
  }

  if (value === 'konbini') {
    return 'stripe_konbini';
  }

  return 'stripe_card';
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