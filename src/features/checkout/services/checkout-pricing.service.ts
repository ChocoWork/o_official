import { z } from 'zod';
import type {
  CheckoutCartSnapshotRow,
  CheckoutItemSnapshotRow,
} from '@/features/checkout/services/checkout-draft.service';

export const CHECKOUT_TAX_RATE = 0.1;

export const checkoutDisplayedAmountsSchema = z
  .object({
    subtotalAmount: z.number().int().min(0),
    taxAmount: z.number().int().min(0),
    shippingAmount: z.number().int().min(0),
    totalAmount: z.number().int().min(0),
  })
  .strict();

export type CheckoutDisplayedAmounts = z.infer<typeof checkoutDisplayedAmountsSchema>;

export function calculateCheckoutAmountsFromSubtotal(
  subtotalAmount: number
): CheckoutDisplayedAmounts {
  const taxAmount = Math.floor(subtotalAmount * CHECKOUT_TAX_RATE);
  const shippingAmount = 0;
  const totalAmount = subtotalAmount + taxAmount + shippingAmount;

  return {
    subtotalAmount,
    taxAmount,
    shippingAmount,
    totalAmount,
  };
}

export function calculateCheckoutAmountsFromCartRows(
  cartRows: CheckoutCartSnapshotRow[],
  itemMap: Map<number, CheckoutItemSnapshotRow>
): CheckoutDisplayedAmounts {
  const subtotalAmount = cartRows.reduce((sum, cartItem) => {
    const price = itemMap.get(cartItem.item_id)?.price ?? 0;
    return sum + price * cartItem.quantity;
  }, 0);

  return calculateCheckoutAmountsFromSubtotal(subtotalAmount);
}

export function isCheckoutDisplayedAmountsMatched(
  serverAmounts: CheckoutDisplayedAmounts,
  displayedAmounts: CheckoutDisplayedAmounts
): boolean {
  return (
    serverAmounts.subtotalAmount === displayedAmounts.subtotalAmount &&
    serverAmounts.taxAmount === displayedAmounts.taxAmount &&
    serverAmounts.shippingAmount === displayedAmounts.shippingAmount &&
    serverAmounts.totalAmount === displayedAmounts.totalAmount
  );
}
