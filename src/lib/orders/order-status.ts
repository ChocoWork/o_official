// 注文ステータスの表示ユーティリティ（account / 注文詳細で共用）

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

export const ORDER_PROGRESS_STEPS = ['支払い完了', '受注', '発送', '配達'] as const;

/** ステータスを進捗ステップの index（0=支払い完了, 1=受注, 2=発送, 3=配達）に変換。-1 は未決済・キャンセル等で進捗外 */
export function resolveOrderProgressIndex(status: string): number {
  switch (status?.toLowerCase?.()) {
    case 'paid':
    case 'processing':
    case 'preparing':
      return 1;
    case 'shipped':
      return 2;
    case 'delivered':
    case 'completed':
      return 3;
    default:
      return -1;
  }
}
