/** 管理用の品物状態。お客様向けの注文・配送の辞書とは独立した定義。 */
export const ADMIN_ITEM_STATUS_LABELS: Record<AdminItemStatus, string> = {
  unpaid: '未払い',
  payment_expired: '支払い期限切れ',
  in_production: '受注生産中',
  ready: '発送準備中',
  shipped: '発送済み',
  delivered: '配達済み',
  cancel_requested: 'キャンセル申請中',
  cancelled: 'キャンセル済み',
  return_requested: '返品申請中',
  return_in_progress: '返品受付中',
  refund_waiting: '返金待ち',
  returned: '返品済み',
};

export type AdminItemStatus = 'unpaid' | 'payment_expired' | 'in_production' | 'ready' | 'shipped' | 'delivered'
  | 'cancel_requested' | 'cancelled' | 'return_requested' | 'return_in_progress' | 'refund_waiting' | 'returned';

export type ItemBlockedReason = 'variant_missing' | 'payment_review' | 'exchange_fee_waiting'
  | 'cancel_requested' | 'refund_processing' | 'stock_shortage';

export type AdminItemState = {
  orderId: string;
  orderItemId: string;
  status: AdminItemStatus;
  quantity: number;
  blockedReasons: ItemBlockedReason[];
};
