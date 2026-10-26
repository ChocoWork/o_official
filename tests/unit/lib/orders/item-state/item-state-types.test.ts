import { ADMIN_ITEM_STATUS_LABELS, ITEM_BLOCKED_REASON_LABELS } from '@/lib/orders/item-state/item-state-types';
import { ORDER_ITEM_STATUS_ORDER } from '@/lib/orders/admin-orders/admin-order-types';
test('FREQ-536-AC-01: 12状態の順と阻害理由6つの言葉', () => {
  expect(ORDER_ITEM_STATUS_ORDER).toEqual(Object.keys(ADMIN_ITEM_STATUS_LABELS));
  expect(ITEM_BLOCKED_REASON_LABELS).toEqual({ variant_missing: '色・サイズが確定していません', payment_review: '支払額の確認待ちです', exchange_fee_waiting: '交換手数料のお支払い待ちです', cancel_requested: 'キャンセルの申し込みを確認中です', refund_processing: '返金を処理中です', stock_shortage: '在庫の入荷待ちです' });
});
