// 注文ステータスの表示ユーティリティ（購入履歴の一覧で使う）。
// 注文の言葉と進み具合の段は order-progress.ts が出す

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'お支払い待ち',
  paid: '支払い完了',
  processing: '処理中',
  preparing: '発送準備中',
  shipped: '発送済み',
  delivered: '配達完了',
  completed: '完了',
  cancelled: 'キャンセル',
  canceled: 'キャンセル',
  refunded: '返金済み',
};

export function formatOrderStatus(status: string): string {
  return ORDER_STATUS_LABELS[status?.toLowerCase?.() ?? ''] ?? status;
}
