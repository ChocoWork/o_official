/**
 * お客様の注文の窓口（GET /api/orders/[id]）の答えのうち、グループ E-1 で足した所（進み具合・発送ごとの配送情報・商品ごとの数）。
 * 古い注文詳細の写しに足して使う。形は共通の約束（実装計画 C-2、Task 8）に合わせる。
 */
import type { OrderProgressKey, OrderProgressStep, OrderProgressStepKey } from '@/lib/orders/order-progress';

export type DetailProgress = {
  key: OrderProgressKey;
  label: string;
  partiallyShipped: boolean;
  steps: OrderProgressStep[] | null;
};

export type DetailShipment = {
  id: string;
  number: number;
  shippedAt: string;
  carrier: string | null;
  carrierLabel: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: Array<{ orderItemId: string; name: string; color: string | null; size: string | null; quantity: number }>;
};

const STEP_LABELS: Record<OrderProgressStepKey, string> = {
  payment: 'お支払い',
  in_production: '受注生産中',
  ready: '発送準備中',
  in_transit: '配送中',
  delivered: '配達済み',
};

/** 進み具合。withProduction は受注生産の品を含む注文（5段）。current が今の段で、それより前は済み、後はこれから */
export function progressOf(input: {
  key: OrderProgressKey;
  label: string;
  current: OrderProgressStepKey;
  withProduction?: boolean;
  partiallyShipped?: boolean;
}): DetailProgress {
  const order: OrderProgressStepKey[] = input.withProduction
    ? ['payment', 'in_production', 'ready', 'in_transit', 'delivered']
    : ['payment', 'ready', 'in_transit', 'delivered'];
  const at = order.indexOf(input.current);
  return {
    key: input.key,
    label: input.label,
    partiallyShipped: input.partiallyShipped ?? false,
    steps: order.map(
      (stepKey, index): OrderProgressStep => ({
        key: stepKey,
        label: STEP_LABELS[stepKey],
        state: index < at ? 'done' : index === at ? 'current' : 'todo',
      }),
    ),
  };
}

/** 発送ごとの配送情報（既定は、ヤマト運輸で送ったシルクブラウス1つ） */
export function shipmentOf(overrides: Partial<DetailShipment> & { number: number }): DetailShipment {
  return {
    id: `f4b2c3d4-0000-4000-8000-00000000000${overrides.number}`,
    shippedAt: '2026-10-05T00:00:00.000Z',
    carrier: 'yamato',
    carrierLabel: 'ヤマト運輸',
    trackingNumber: '1234-5678-9012',
    trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012',
    items: [{ orderItemId: 'item-1', name: 'シルクブラウス', color: 'ホワイト', size: 'M', quantity: 1 }],
    ...overrides,
  };
}

/** 在庫の品だけの入金済みの注文（発送準備中）の進み具合 */
export const STOCK_READY_PROGRESS = progressOf({ key: 'ready', label: '発送準備中', current: 'ready' });

/** 在庫の品だけで、全部を送った注文（配送中）の進み具合 */
export const STOCK_IN_TRANSIT_PROGRESS = progressOf({ key: 'in_transit', label: '配送中', current: 'in_transit' });

/** 古い注文詳細の写し（在庫の品だけの入金済み）に、E-1 で足した所を足す。商品は全部、発送準備中の数に入る */
export function withReadyProgress<T extends { items: Array<{ quantity: number }> }>(detail: T) {
  return {
    ...detail,
    items: detail.items.map((item) => ({
      ...item,
      shippedQuantity: 0,
      readyQuantity: item.quantity,
      inProductionQuantity: 0,
    })),
    progress: STOCK_READY_PROGRESS,
    shipments: [] as DetailShipment[],
  };
}
