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
  it('10の言葉・一部発送済みの印・進み具合の段の名前は設計書のとおり', () => {
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
      cancel_pending: 'キャンセルの手続き中',
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

/** 在庫の品。2つとも発送前に返金した（これから送る品も、送った品も残っていない） */
const STOCK_REFUNDED = line({ readyUnshipped: 0, unshipped: 0 });
/** 受注生産の品。2つとも作り始める前に返金した */
const BACKORDER_REFUNDED = line({ fulfillmentType: 'backorder', readyUnshipped: 0, unshipped: 0 });

describe('deriveOrderProgress の「キャンセルの手続き中」（グループ E-2 設計書 5-3・9-1）', () => {
  const OPEN_REFUND = { hasOpenRefund: true };

  it.each([
    ['在庫の品だけを全部返金した', [STOCK_REFUNDED]],
    ['在庫の品と受注生産の品を全部返金した', [STOCK_REFUNDED, BACKORDER_REFUNDED]],
  ] as const)('支払い済みで、送った品も未発送の品も無く、返金が手続き中なら cancel_pending（%s）。段は出さない', (_name, lines) => {
    const progress = deriveOrderProgress('paid', lines, OPEN_REFUND);

    expect(progress).toEqual({ key: 'cancel_pending', label: 'キャンセルの手続き中', partiallyShipped: false });
    expect(buildOrderProgressSteps(progress, lines)).toBeNull();
  });

  it('手続き中の返金が無ければ（指定なし・false・空）、同じ数でも今までの言葉（発送準備中）のまま', () => {
    const today = { key: 'ready', label: '発送準備中', partiallyShipped: false };

    expect(deriveOrderProgress('paid', [STOCK_REFUNDED])).toEqual(today);
    expect(deriveOrderProgress('paid', [STOCK_REFUNDED], { hasOpenRefund: false })).toEqual(today);
    expect(deriveOrderProgress('paid', [STOCK_REFUNDED], {})).toEqual(today);
  });

  it.each([
    ['まだ送る品が残っている（一部だけ返金した）', 'paid', [STOCK_READY, STOCK_REFUNDED]],
    ['送った品がある（送った後の返金の手続き中）', 'paid', [STOCK_SHIPPED]],
    ['送った品があり、残りを発送前に返金した', 'paid', [STOCK_SHIPPED, STOCK_REFUNDED]],
    ['受注生産の品を作っている途中', 'paid', [BACKORDER_IN_PRODUCTION]],
    ['発送済み（shipped）の注文', 'shipped', [STOCK_SHIPPED]],
  ] as const)('返金が手続き中でも、%s は今までの言葉のまま', (_name, status, lines) => {
    expect(deriveOrderProgress(status, lines, OPEN_REFUND)).toEqual(deriveOrderProgress(status, lines));
  });

  it.each(['payment_in_progress', 'pending', 'failed', 'abandoned', 'cancelled'] as const)(
    '支払い済みでない注文（%s）は、手続き中の返金があっても今までの言葉のまま',
    (status) => {
      expect(deriveOrderProgress(status, [STOCK_REFUNDED], OPEN_REFUND)).toEqual(deriveOrderProgress(status, [STOCK_REFUNDED]));
    },
  );
});

describe('deriveOrderProgress の配達済み（グループ E-4 設計書 7-2）', () => {
  /** DB の集計（取り消した発送は除いてある）。取り消していない発送のうち配達済みの数 */
  const delivered = (activeCount: number, deliveredCount: number) => ({ delivery: { activeCount, deliveredCount } });

  it('全部の取消でない発送が配達済みなら配達済み。進み具合の段は全部済み', () => {
    const lines = [STOCK_SHIPPED];

    const progress = deriveOrderProgress('shipped', lines, delivered(1, 1));
    const steps = buildOrderProgressSteps(progress, lines);

    expect(progress.key).toBe('delivered');
    expect(progress.label).toBe('配達済み');
    expect(progress.partiallyShipped).toBe(false);
    expect(steps).toHaveLength(4);
    expect(steps?.every((step) => step.state === 'done')).toBe(true);
  });

  it('受注生産の品を含む注文も、全部の発送が配達済みなら5段が全部済み', () => {
    const lines = [STOCK_SHIPPED, BACKORDER_SHIPPED];

    const progress = deriveOrderProgress('shipped', lines, delivered(2, 2));
    const steps = buildOrderProgressSteps(progress, lines);

    expect(progress.key).toBe('delivered');
    expect(steps).toHaveLength(5);
    expect(steps?.every((step) => step.state === 'done')).toBe(true);
  });

  it('状態が paid のままでも、商品が全部送り済みで発送が全部配達済みなら配達済み（今の「配送中」と同じ決まり）', () => {
    expect(deriveOrderProgress('paid', [STOCK_SHIPPED], delivered(1, 1)).key).toBe('delivered');
  });

  it('一部だけ配達済みと発送0件は配達済みにしない', () => {
    const partial = deriveOrderProgress('shipped', [STOCK_SHIPPED], delivered(2, 1));
    const empty = deriveOrderProgress('shipped', [STOCK_SHIPPED], delivered(0, 0));
    const none = deriveOrderProgress('shipped', [STOCK_SHIPPED], delivered(2, 0));

    expect(partial.key).toBe('in_transit');
    expect(partial.label).toBe('配送中');
    expect(empty.key).not.toBe('delivered');
    expect(empty.key).toBe('in_transit');
    expect(none.key).toBe('in_transit');
  });

  it('発送準備中か受注生産中の品が残れば先の段を保つ', () => {
    const ready = deriveOrderProgress('paid', [STOCK_READY, STOCK_SHIPPED], delivered(1, 1));
    const making = deriveOrderProgress('paid', [STOCK_SHIPPED, BACKORDER_IN_PRODUCTION], delivered(1, 1));
    const makingAndReady = deriveOrderProgress('paid', [STOCK_READY, BACKORDER_IN_PRODUCTION], delivered(1, 1));

    expect(ready.key).toBe('ready');
    expect(ready.partiallyShipped).toBe(true);
    expect(making.key).toBe('in_production');
    expect(making.partiallyShipped).toBe(true);
    expect(makingAndReady.key).toBe('in_production');
  });

  it('固定の言葉（未決済・失敗・放棄・キャンセル）と、キャンセルの手続き中は、配達済みの集計を渡されても変えない', () => {
    for (const status of ['payment_in_progress', 'pending', 'failed', 'abandoned', 'cancelled'] as const) {
      expect(deriveOrderProgress(status, [STOCK_SHIPPED], delivered(1, 1))).toEqual(deriveOrderProgress(status, [STOCK_SHIPPED]));
    }
    expect(deriveOrderProgress('paid', [STOCK_REFUNDED], { hasOpenRefund: true, ...delivered(1, 1) }).key).toBe('cancel_pending');
  });

  it('発送した品が1つも数に無い（商品の行が空・全部未発送）のに集計だけが全部配達済みという壊れた答えでは、配達済みにしない', () => {
    expect(deriveOrderProgress('shipped', [], delivered(1, 1)).key).toBe('ready');
    expect(deriveOrderProgress('paid', [BACKORDER_REFUNDED], delivered(1, 1)).key).toBe('ready');
  });

  it('集計を渡さない・delivery を省いた呼び出しは、従来どおり「配送中」', () => {
    expect(deriveOrderProgress('shipped', [STOCK_SHIPPED]).key).toBe('in_transit');
    expect(deriveOrderProgress('shipped', [STOCK_SHIPPED], {}).key).toBe('in_transit');
    expect(deriveOrderProgress('shipped', [STOCK_SHIPPED], { hasOpenRefund: false }).key).toBe('in_transit');
    expect(deriveOrderProgress('shipped', [STOCK_SHIPPED], { delivery: undefined }).key).toBe('in_transit');
  });
});

describe('buildOrderProgressSteps', () => {
  const stepsOf =(status: (typeof ORDER_STATUSES)[number], lines: readonly OrderLineProgressCounts[]) =>
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

  it('配達済みは、4段でも5段でも全部の段が済む', () => {
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

    // delivery-types は画面からも読める型だけの置き場（server-only の delivery-store ではない）
    expect(specifiers).toEqual(['@/lib/orders/order-payment-types', '@/lib/orders/tracking/delivery-types']);
    expect(source).toMatch(/import type \{ OrderStatus \} from/);
    expect(source).toMatch(/import type \{ OrderDeliverySummary \} from '@\/lib\/orders\/tracking\/delivery-types'/);
  });
});
