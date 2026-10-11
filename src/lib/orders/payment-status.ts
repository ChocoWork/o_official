import type { OrderStatus } from '@/lib/orders/order-payment-types';

/**
 * 管理画面の注文の一覧の「支払い」の列の言葉（グループ E-2 設計書 9-1）。一覧の窓口・CSV・画面が同じ言葉を出すので、
 * 画面からも読む。サーバーだけの物を import しない。
 * 「進み具合」（order-progress.ts）は発送の進み具合、こちらはお金の状態。
 */
export const PAYMENT_STATUS_KEYS = ['unpaid', 'failed', 'none', 'paid', 'partially_refunded', 'refunded'] as const;
export type PaymentStatusKey = (typeof PAYMENT_STATUS_KEYS)[number];

export const PAYMENT_STATUS_LABELS = {
  unpaid: '未入金',
  failed: '支払いの失敗',
  none: '支払いなし',
  paid: '支払い済み',
  partially_refunded: '一部返金',
  refunded: '返金済み',
} as const satisfies Record<PaymentStatusKey, string>;

/** 返事待ち・保留の返金がある注文に付ける小さな印 */
export const REFUND_PENDING_BADGE = '返金の手続き中';
/** 開いている「返金の失敗」の要対応がある注文に付ける小さな印 */
export const REFUND_FAILED_BADGE = '返金の失敗';

/**
 * 上から順に当てはめて、最初に当たった1つを返す。
 * 1. payment_in_progress・pending → unpaid
 * 2. failed → failed
 * 3. abandoned → none
 * 4. paidAmount が空か0 → none（未入金のまま取り消した注文を含む）
 * 5. refundedAmount が0 → paid
 * 6. refundedAmount < paidAmount → partially_refunded
 * 7. それ以外 → refunded
 * refundedAmount は成功した返金の合計（orders.refunded_amount）。
 */
export function derivePaymentStatus(input: {
  status: OrderStatus;
  paidAmount: number | null;
  refundedAmount: number;
}): PaymentStatusKey {
  if (input.status === 'payment_in_progress' || input.status === 'pending') {
    return 'unpaid';
  }
  if (input.status === 'failed') {
    return 'failed';
  }
  if (input.status === 'abandoned') {
    return 'none';
  }
  if (!input.paidAmount) {
    return 'none';
  }
  if (input.refundedAmount === 0) {
    return 'paid';
  }
  return input.refundedAmount < input.paidAmount ? 'partially_refunded' : 'refunded';
}
