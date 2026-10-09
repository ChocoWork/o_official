/**
 * 注文のメールの明細の書き方（金額・明細の行・お届けの目安）。
 * メールの組み立てと送信は src/lib/orders/email/ が行う（グループ D。送る予定の表と worker）。
 */
import { FINAL_FULFILLMENT_LABELS, FULFILLMENT_HEADINGS } from '@/features/checkout/utils/fulfillment-labels';

export type ConfirmationItem = {
  item_name: string;
  color?: string | null;
  size?: string | null;
  quantity: number;
  line_total: number;
  /** 受け付けで在庫を確保した明細は stock、受注生産は backorder（グループ F 設計書 5-3）。DB の列は NOT NULL。目安を出すかは formatItemLines の withFulfillment で決める */
  fulfillment_type?: string | null;
};

export type OrderConfirmationShipping = {
  fullName: string | null;
  postalCode: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
  building: string | null;
  phone: string | null;
};

export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `¥${amount.toLocaleString('ja-JP')}`;
  }
}

/** 明細の行。確定メールでは、受け付けで決まったお届けの目安を次の行に添える（グループ F 設計書 5-3） */
export function formatItemLines(
  items: ConfirmationItem[],
  currency: string,
  options: { withFulfillment?: boolean } = {},
): string[] {
  return items.map((item) => {
    const variant = [item.color, item.size].filter(Boolean).join(' / ');
    const label = variant ? `${item.item_name}（${variant}）` : item.item_name;
    const line = `・${label} x${item.quantity}　${formatCurrency(item.line_total, currency)}`;
    const fulfillment =
      item.fulfillment_type === 'stock' || item.fulfillment_type === 'backorder' ? item.fulfillment_type : null;
    if (!options.withFulfillment || !fulfillment) {
      return line;
    }
    return `${line}\n　${FULFILLMENT_HEADINGS[fulfillment]}・${FINAL_FULFILLMENT_LABELS[fulfillment]}`;
  });
}

export type OrderEmailRow = {
  id: string;
  shipping_email: string | null;
  shipping_full_name: string | null;
  subtotal_amount: number;
  shipping_amount: number;
  discount_amount: number;
  total_amount: number;
  currency: string;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_building: string | null;
  shipping_phone: string | null;
  review_reason: string | null;
};
