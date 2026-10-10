import fs from 'node:fs';
import path from 'node:path';
import {
  buildOrderProgressSteps,
  deriveOrderProgress,
  ORDER_PROGRESS_KEYS,
  ORDER_PROGRESS_LABELS,
  ORDER_PROGRESS_STEP_LABELS,
  PARTIALLY_SHIPPED_LABEL,
  type OrderLineProgressCounts,
  type OrderProgress,
} from '@/lib/orders/order-progress';
import { ORDER_STATUSES } from '@/lib/orders/order-payment-types';

function line(overrides: Partial<OrderLineProgressCounts> = {}): OrderLineProgressCounts {
  return { fulfillmentType: 'stock', quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2, ...overrides };
}

/** 在庫の品。2つとも発送準備中 */
const STOCK_READY = line();
/** 在庫の品。2つとも送った */
const STOCK_SHIPPED = line({ shipped: 2, readyUnshipped: 0, unshipped: 0 });
/** 受注生産の品。2つとも作っている途中 */
const BACKORDER_IN_PRODUCTION = line({ fulfillmentType: 'backorder', inProduction: 2, readyUnshipped: 0 });
/** 受注生産の品。仕上がって、まだ送っていない */
const BACKORDER_READY = line({ fulfillmentType: 'backorder' });
/** 受注生産の品。仕上がって、送った */
const BACKORDER_SHIPPED = line({ fulfillmentType: 'backorder', shipped: 2, readyUnshipped: 0, unshipped: 0 });

describe('注文の言葉と印', () => {
  it('9つの言葉・一部発送済みの印・進み具合の段の名前は設計書のとおり', () => {
    expect(ORDER_PROGRESS_LABELS).toEqual({
      payment_in_progress: '支払い手続き中',
      unpaid: '未決済',
      in_production: '受注生産中',
      ready: '発送準備中',
      in_transit: '配送中',
      delivered: '配達済み',
      failed: '決済失敗',
      abandoned: '放棄',
      cancelled: 'キャンセル',
    });
    expect(Object.keys(ORDER_PROGRESS_LABELS)).toEqual([...ORDER_PROGRESS_KEYS]);
    expect(PARTIALLY_SHIPPED_LABEL).toBe('一部発送済み');
    expect(ORDER_PROGRESS_STEP_LABELS).toEqual({
      payment: 'お支払い',
      in_production: '受注生産中',
      ready: '発送準備中',
      in_transit: '配送中',
      delivered: '配達済み',
    });
  });
});

describe('deriveOrderProgress', () => {
  it.each([
    ['payment_in_progress', 'payment_in_progress', '支払い手続き中'],
    ['pending', 'unpaid', '未決済'],
    ['failed', 'failed', '決済失敗'],
    ['abandoned', 'abandoned', '放棄'],
    ['cancelled', 'cancelled', 'キャンセル'],
  ] as const)('%s の注文は、商品の数に関係なく %s（%s）。一部発送済みの印は付かない', (status, key, label) => {
    const someShipped = [line({ shipped: 1, readyUnshipped: 1, unshipped: 1 }), BACKORDER_IN_PRODUCTION];

    expect(deriveOrderProgress(status, someShipped)).toEqual({ key, label, partiallyShipped: false });
  });

  it.each([
    ['在庫の品だけ・入金したところ', 'paid', [STOCK_READY], 'ready', '発送準備中', false],
    ['在庫の品だけ・全部送った', 'shipped', [STOCK_SHIPPED], 'in_transit', '配送中', false],
    ['在庫の品が2行・1行を送った', 'paid', [STOCK_READY, STOCK_SHIPPED], 'ready', '発送準備中', true],
    ['受注生産の品だけ・作っている途中', 'paid', [BACKORDER_IN_PRODUCTION], 'in_production', '受注生産中', false],
    ['受注生産の品だけ・仕上がった', 'paid', [BACKORDER_READY], 'ready', '発送準備中', false],
    ['在庫の品と受注生産の品・入金したところ', 'paid', [STOCK_READY, BACKORDER_IN_PRODUCTION], 'in_production', '受注生産中', false],
    ['在庫の品を先に送った', 'paid', [STOCK_SHIPPED, BACKORDER_IN_PRODUCTION], 'in_production', '受注生産中', true],
    ['受注生産の品が仕上がった（在庫の品は送り済み）', 'paid', [STOCK_SHIPPED, BACKORDER_READY], 'ready', '発送準備中', true],
    ['在庫の品と受注生産の品を全部送った', 'shipped', [STOCK_SHIPPED, BACKORDER_SHIPPED], 'in_transit', '配送中', false],
    ['商品が全部送り済みなら、状態が paid でも配送中', 'paid', [STOCK_SHIPPED], 'in_transit', '配送中', false],
    ['商品の行が無い異常な注文は発送準備中', 'paid', [], 'ready', '発送準備中', false],
    ['商品の行が無い異常な発送済みも発送準備中', 'shipped', [], 'ready', '発送準備中', false],
  ] as const)('%s → %s', (_name, status, lines, key, label, partiallyShipped) => {
    expect(deriveOrderProgress(status, lines)).toEqual({ key, label, partiallyShipped });
  });

  it('どの注文の状態でも例外を投げない', () => {
    for (const status of ORDER_STATUSES) {
      expect(() => deriveOrderProgress(status, [STOCK_READY, BACKORDER_IN_PRODUCTION])).not.toThrow();
    }
  });
});

describe('buildOrderProgressSteps', () => {
  const stepsOf = (status: (typeof ORDER_STATUSES)[number], lines: readonly OrderLineProgressCounts[]) =>
    buildOrderProgressSteps(deriveOrderProgress(status, lines), lines);
  const view = (steps: ReturnType<typeof buildOrderProgressSteps>) => steps?.map((step) => `${step.label}:${step.state}`);

  it.each([
    ['支払い手続き中', 'payment_in_progress'],
    ['決済失敗', 'failed'],
    ['放棄', 'abandoned'],
    ['キャンセル', 'cancelled'],
  ] as const)('%s の注文には段を出さない（null）', (_name, status) => {
    expect(stepsOf(status, [STOCK_READY, BACKORDER_IN_PRODUCTION])).toBeNull();
  });

  it('在庫の品だけの注文は4段。未決済の間は「お支払い」が今の段', () => {
    expect(view(stepsOf('pending', [STOCK_READY]))).toEqual(['お支払い:current', '発送準備中:todo', '配送中:todo', '配達済み:todo']);
    expect(view(stepsOf('paid', [STOCK_READY]))).toEqual(['お支払い:done', '発送準備中:current', '配送中:todo', '配達済み:todo']);
    expect(view(stepsOf('shipped', [STOCK_SHIPPED]))).toEqual(['お支払い:done', '発送準備中:done', '配送中:current', '配達済み:todo']);
  });

  it('受注生産の品を含む注文は5段。今の段は、いちばん手前の商品の段階で決まる', () => {
    const mixed = [STOCK_READY, BACKORDER_IN_PRODUCTION];

    expect(view(stepsOf('pending', mixed))).toEqual(['お支払い:current', '受注生産中:todo', '発送準備中:todo', '配送中:todo', '配達済み:todo']);
    expect(view(stepsOf('paid', mixed))).toEqual(['お支払い:done', '受注生産中:current', '発送準備中:todo', '配送中:todo', '配達済み:todo']);
    // 在庫の品を先に送っても、受注生産の品が作っている途中なら「受注生産中」のまま
    expect(view(stepsOf('paid', [STOCK_SHIPPED, BACKORDER_IN_PRODUCTION]))).toEqual([
      'お支払い:done', '受注生産中:current', '発送準備中:todo', '配送中:todo', '配達済み:todo',
    ]);
    expect(view(stepsOf('paid', [STOCK_SHIPPED, BACKORDER_READY]))).toEqual([
      'お支払い:done', '受注生産中:done', '発送準備中:current', '配送中:todo', '配達済み:todo',
    ]);
    expect(view(stepsOf('shipped', [STOCK_SHIPPED, BACKORDER_SHIPPED]))).toEqual([
      'お支払い:done', '受注生産中:done', '発送準備中:done', '配送中:current', '配達済み:todo',
    ]);
  });

  it('段の記号は 支払い → 受注生産中 → 発送準備中 → 配送中 → 配達済み の順', () => {
    expect(stepsOf('paid', [BACKORDER_IN_PRODUCTION])?.map((step) => step.key)).toEqual([
      'payment', 'in_production', 'ready', 'in_transit', 'delivered',
    ]);
    expect(stepsOf('paid', [STOCK_READY])?.map((step) => step.key)).toEqual(['payment', 'ready', 'in_transit', 'delivered']);
  });

  it('配達済みは、4段でも5段でも全部の段が済み（E-4 で配達の状況が入るまで、窓口は出さない言葉）', () => {
    const delivered: OrderProgress = { key: 'delivered', label: '配達済み', partiallyShipped: false };

    expect(view(buildOrderProgressSteps(delivered, [STOCK_SHIPPED]))).toEqual(['お支払い:done', '発送準備中:done', '配送中:done', '配達済み:done']);
    expect(view(buildOrderProgressSteps(delivered, [STOCK_SHIPPED, BACKORDER_SHIPPED]))).toEqual([
      'お支払い:done', '受注生産中:done', '発送準備中:done', '配送中:done', '配達済み:done',
    ]);
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/order-progress.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(['@/lib/orders/order-payment-types']);
    expect(source).toMatch(/import type \{ OrderStatus \} from/);
  });
});
