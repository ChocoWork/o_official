import type { OrderStatus } from '@/lib/orders/order-payment-types';

/**
 * 注文の言葉と進み具合の段（グループ E-1 設計書 4 章）。管理画面・お客様の画面・窓口が同じ言葉を出すので、
 * 画面からも読む。サーバーだけの物を import しない。
 * DB の注文の状態（order_status）は変えず、商品ごとの数から言葉を出す。
 */
export const ORDER_PROGRESS_KEYS = [
  'payment_in_progress',
  'unpaid',
  'in_production',
  'ready',
  'in_transit',
  'delivered',
  'failed',
  'abandoned',
  'cancelled',
] as const;
export type OrderProgressKey = (typeof ORDER_PROGRESS_KEYS)[number];

export const ORDER_PROGRESS_LABELS = {
  payment_in_progress: '支払い手続き中',
  unpaid: '未決済',
  in_production: '受注生産中',
  ready: '発送準備中',
  in_transit: '配送中',
  delivered: '配達済み',
  failed: '決済失敗',
  abandoned: '放棄',
  cancelled: 'キャンセル',
} as const satisfies Record<OrderProgressKey, string>;
export type OrderProgressLabel = (typeof ORDER_PROGRESS_LABELS)[OrderProgressKey];

/** 発送した数が1以上で、未発送の数も1以上の注文に付ける印 */
export const PARTIALLY_SHIPPED_LABEL = '一部発送済み';

/** 商品の行ごとの数（DB の private.order_line_fulfillment の列）。fulfillmentType は stock か backorder */
export type OrderLineProgressCounts = {
  fulfillmentType: string;
  quantity: number;
  shipped: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

export type OrderProgress = { key: OrderProgressKey; label: OrderProgressLabel; partiallyShipped: boolean };

/** 商品の数を見ずに決まる言葉。paid・shipped は商品の数で決めるので入れない */
const FIXED_PROGRESS_KEYS: Record<Exclude<OrderStatus, 'paid' | 'shipped'>, OrderProgressKey> = {
  payment_in_progress: 'payment_in_progress',
  pending: 'unpaid',
  failed: 'failed',
  abandoned: 'abandoned',
  cancelled: 'cancelled',
};

function sumOf(lines: readonly OrderLineProgressCounts[], pick: (line: OrderLineProgressCounts) => number): number {
  return lines.reduce((total, line) => total + pick(line), 0);
}

/**
 * 注文の言葉。paid・shipped は、商品の段階のうちいちばん手前（受注生産中 → 発送準備中 → 配送中）にそろえる。
 * 配達済みは配送の状況を持つ E-4 から。E-1 では、発送した品は全部「配送中」になる。
 */
export function deriveOrderProgress(status: OrderStatus, lines: readonly OrderLineProgressCounts[]): OrderProgress {
  if (status !== 'paid' && status !== 'shipped') {
    const key = FIXED_PROGRESS_KEYS[status];
    return { key, label: ORDER_PROGRESS_LABELS[key], partiallyShipped: false };
  }

  const shipped = sumOf(lines, (line) => line.shipped);
  let key: OrderProgressKey = 'ready';
  if (sumOf(lines, (line) => line.inProduction) > 0) {
    key = 'in_production';
  } else if (sumOf(lines, (line) => line.readyUnshipped) > 0) {
    key = 'ready';
  } else if (shipped > 0) {
    key = 'in_transit';
  }
  return {
    key,
    label: ORDER_PROGRESS_LABELS[key],
    partiallyShipped: shipped > 0 && sumOf(lines, (line) => line.unshipped) > 0,
  };
}

export type OrderProgressStepKey = 'payment' | 'in_production' | 'ready' | 'in_transit' | 'delivered';

export const ORDER_PROGRESS_STEP_LABELS = {
  payment: 'お支払い',
  in_production: '受注生産中',
  ready: '発送準備中',
  in_transit: '配送中',
  delivered: '配達済み',
} as const satisfies Record<OrderProgressStepKey, string>;

export type OrderProgressStep = { key: OrderProgressStepKey; label: string; state: 'done' | 'current' | 'todo' };

/** 言葉の記号 → 今いる段。段を出さない言葉（支払い手続き中・決済失敗・放棄・キャンセル）は入れない */
const CURRENT_STEP_KEYS: Partial<Record<OrderProgressKey, OrderProgressStepKey>> = {
  unpaid: 'payment',
  in_production: 'in_production',
  ready: 'ready',
  in_transit: 'in_transit',
  delivered: 'delivered',
};

/**
 * お客様の注文の画面の進み具合の段。受注生産の品を含む注文だけ「受注生産中」の段が入る（5段）。
 * 支払い手続き中・決済失敗・放棄・キャンセルは null（段を出さない）。
 */
export function buildOrderProgressSteps(
  progress: OrderProgress,
  lines: readonly OrderLineProgressCounts[],
): OrderProgressStep[] | null {
  const current = CURRENT_STEP_KEYS[progress.key];
  if (!current) {
    return null;
  }

  const keys: OrderProgressStepKey[] = ['payment'];
  if (lines.some((line) => line.fulfillmentType === 'backorder')) {
    keys.push('in_production');
  }
  keys.push('ready', 'in_transit', 'delivered');

  const currentIndex = keys.indexOf(current);
  return keys.map((key, index): OrderProgressStep => ({
    key,
    label: ORDER_PROGRESS_STEP_LABELS[key],
    // 配達済みは最後の段。届いたら、全部の段が済んだことにする
    state: current === 'delivered' || index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo',
  }));
}
