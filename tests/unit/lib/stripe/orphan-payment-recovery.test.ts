const mockReconcileCheckoutPayment = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcileCheckoutPayment(...args),
}));

import {
  MARK_RECOVERED_ATTEMPTS,
  ORDER_LOOKUP_BATCH_SIZE,
  ORPHAN_LOOKBACK_SECONDS,
  createOrphanRecoveryDeps,
  loadRecoveredOrderSummaries,
  placedOrderId,
  recoverOrphanPayments,
  type OrdersQueryClient,
  type OrphanRecoveryDeps,
} from '@/lib/stripe/orphan-payment-recovery';
import type { ReconcileResult, ReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler';
import type { OpsStore } from '@/lib/ops/ops-store';

const NOW = Date.parse('2026-10-05T03:00:00.000Z');
const RECONCILER_DEPS = { name: 'reconciler-deps' } as unknown as ReconcilerDeps;

function placed(orderId: string, type: 'place_and_mark_paid' | 'place_and_mark_awaiting' = 'place_and_mark_paid'): ReconcileResult {
  return { kind: 'ok', action: { type }, orderId, orderStatus: type === 'place_and_mark_paid' ? 'paid' : 'pending' };
}

async function* sessions(ids: string[]): AsyncIterable<string> {
  for (const id of ids) yield id;
}

/** 呼び出しを確かめられるよう、外の関数を jest.fn にした形 */
type MockedDeps = Omit<OrphanRecoveryDeps, 'listCompletedSessionIds' | 'findSessionIdsWithOrders' | 'reconcile' | 'markRecovered'> & {
  listCompletedSessionIds: jest.Mock;
  findSessionIdsWithOrders: jest.Mock;
  reconcile: jest.Mock;
  markRecovered: jest.Mock;
};

function recoveryDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
  return {
    listCompletedSessionIds: jest.fn(() => sessions(['cs_1', 'cs_2', 'cs_3'])),
    findSessionIdsWithOrders: jest.fn(async () => new Set<string>()),
    reconcile: jest.fn(async (sessionId: string) => placed(`order-${sessionId}`)),
    markRecovered: jest.fn(async () => 'recovered_from_payment' as const),
    now: () => NOW,
    deadline: NOW + 45_000,
    ...overrides,
  };
}

describe('recoverOrphanPayments（注文の無い支払いの拾い上げ）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('直近24時間の完了済みの Session を読み、注文の無いものだけを照合関数に渡して印を付ける', async () => {
    const deps = recoveryDeps({ findSessionIdsWithOrders: jest.fn(async () => new Set(['cs_2'])) });

    const result = await recoverOrphanPayments(deps);

    expect(ORPHAN_LOOKBACK_SECONDS).toBe(86400);
    expect(deps.listCompletedSessionIds).toHaveBeenCalledWith(Math.floor(NOW / 1000) - 86400);
    expect(deps.findSessionIdsWithOrders).toHaveBeenCalledWith(['cs_1', 'cs_2', 'cs_3']);
    expect(deps.reconcile.mock.calls.map(([sessionId]) => sessionId)).toEqual(['cs_1', 'cs_3']);
    expect(deps.markRecovered.mock.calls.map(([orderId]) => orderId)).toEqual(['order-cs_1', 'order-cs_3']);
    expect(result).toEqual({
      checkedSessions: 3,
      recovered: [
        { orderId: 'order-cs_1', reviewReason: 'recovered_from_payment' },
        { orderId: 'order-cs_3', reviewReason: 'recovered_from_payment' },
      ],
      failed: 0,
      timeBudgetExhausted: false,
    });
  });

  it('照合の結果が注文を作っていなければ印を付けない（Webhook が先に作った・対象外・要対応）', async () => {
    const results: ReconcileResult[] = [
      { kind: 'ok', action: { type: 'none' }, orderId: 'order-webhook', orderStatus: 'paid' },
      { kind: 'ok', action: { type: 'record_only', note: 'not_applicable' }, orderId: null, orderStatus: null },
      { kind: 'needs_action', exceptionId: 'exception-1', reason: 'order_not_creatable', orderId: null, orderStatus: null },
    ];
    const deps = recoveryDeps({ reconcile: jest.fn(async () => results.shift()!) });

    const result = await recoverOrphanPayments(deps);

    expect(deps.markRecovered).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([]);
  });

  it('在庫を確保できなかった注文は、在庫の理由のまま返す', async () => {
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1'])),
      reconcile: jest.fn(async (): Promise<ReconcileResult> => ({
        kind: 'needs_review', action: { type: 'place_and_mark_paid' }, orderId: 'order-1', orderStatus: 'paid',
      })),
      markRecovered: jest.fn(async () => 'stock_not_reserved' as const),
    });

    const result = await recoverOrphanPayments(deps);

    expect(result.recovered).toEqual([{ orderId: 'order-1', reviewReason: 'stock_not_reserved' }]);
  });

  it('1件の失敗で残りを止めず、失敗の数に入れる', async () => {
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1', 'cs_2'])),
      reconcile: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'stripe_unavailable' }))
        .mockResolvedValueOnce(placed('order-cs_2')),
    });

    const result = await recoverOrphanPayments(deps);

    expect(result.failed).toBe(1);
    expect(result.recovered).toEqual([{ orderId: 'order-cs_2', reviewReason: 'recovered_from_payment' }]);
  });

  it('照合が失敗した Session には印を付けず、失敗に数えて、次の Session の処理は続ける', async () => {
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1', 'cs_2'])),
      reconcile: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'stripe_unavailable' }))
        .mockResolvedValueOnce(placed('order-cs_2')),
    });

    const result = await recoverOrphanPayments(deps);

    expect(deps.markRecovered.mock.calls.map(([orderId]) => orderId)).toEqual(['order-cs_2']);
    expect(result.failed).toBe(1);
    expect(result.recovered).toEqual([{ orderId: 'order-cs_2', reviewReason: 'recovered_from_payment' }]);
    expect(console.error).toHaveBeenCalledWith('[orphan-recovery] Failed to recover a payment', 'cs_1', 'stripe_unavailable');
  });

  it('印を付ける処理が2回失敗しても3回目で付けられれば、印を付けた注文として返し、失敗に数えない', async () => {
    const down = () => Object.assign(new Error('down'), { code: 'db_unavailable' });
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1'])),
      markRecovered: jest.fn()
        .mockRejectedValueOnce(down())
        .mockRejectedValueOnce(down())
        .mockResolvedValueOnce('recovered_from_payment'),
    });

    const result = await recoverOrphanPayments(deps);

    expect(MARK_RECOVERED_ATTEMPTS).toBe(3);
    expect(deps.markRecovered).toHaveBeenCalledTimes(3);
    expect(result.recovered).toEqual([{ orderId: 'order-cs_1', reviewReason: 'recovered_from_payment' }]);
    expect(result.failed).toBe(0);
  });

  it('印を付ける処理が3回とも失敗したら、印なし（null）の注文として結果に載せ、失敗に数えて、注文の ID と原因を記録する', async () => {
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1'])),
      markRecovered: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'db_unavailable' });
      }),
    });

    const result = await recoverOrphanPayments(deps);

    expect(deps.markRecovered).toHaveBeenCalledTimes(3);
    expect(result.recovered).toEqual([{ orderId: 'order-cs_1', reviewReason: null }]);
    expect(result.failed).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('[orphan-recovery] Failed to mark a recovered order', 'order-cs_1', 'db_unavailable');
  });

  it('印を付けられなかった注文があっても、次の Session の処理は続ける', async () => {
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1', 'cs_2'])),
      markRecovered: jest.fn(async (orderId: string) => {
        if (orderId === 'order-cs_1') throw new Error('down');
        return 'recovered_from_payment' as const;
      }),
    });

    const result = await recoverOrphanPayments(deps);

    expect(result.recovered).toEqual([
      { orderId: 'order-cs_1', reviewReason: null },
      { orderId: 'order-cs_2', reviewReason: 'recovered_from_payment' },
    ]);
    expect(result.failed).toBe(1);
  });

  it('時間の予算を過ぎたら新しく照合せず、残りは次の回に回す', async () => {
    let clock = NOW;
    const deps = recoveryDeps({
      now: () => clock,
      reconcile: jest.fn(async (sessionId: string) => {
        clock += 30_000;
        return placed(`order-${sessionId}`);
      }),
    });

    const result = await recoverOrphanPayments(deps);

    expect(deps.reconcile).toHaveBeenCalledTimes(2);
    expect(result.timeBudgetExhausted).toBe(true);
    expect(result.recovered).toHaveLength(2);
  });

  it('注文の有無は、URL の長さのため、ORDER_LOOKUP_BATCH_SIZE 件ごとにまとめて確かめる', async () => {
    const total = ORDER_LOOKUP_BATCH_SIZE * 2 + 25;
    const ids = Array.from({ length: total }, (_, index) => `cs_${index}`);
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(ids)),
      findSessionIdsWithOrders: jest.fn(async (batch: string[]) => new Set(batch)),
    });

    const result = await recoverOrphanPayments(deps);

    // ID は URL に載る。本番の ID（66文字）なら50件で約3.5KB、100件だと約7KB で 8KB の上限に近い
    expect(ORDER_LOOKUP_BATCH_SIZE).toBe(50);
    expect(deps.findSessionIdsWithOrders.mock.calls.map(([batch]) => batch.length)).toEqual([
      ORDER_LOOKUP_BATCH_SIZE,
      ORDER_LOOKUP_BATCH_SIZE,
      25,
    ]);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(result.checkedSessions).toBe(total);
  });

  it('注文の有無を確かめられなければ、その回の拾い上げをやめる（呼び出し側で失敗として数える）', async () => {
    const deps = recoveryDeps({
      findSessionIdsWithOrders: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'db_unavailable' });
      }),
    });

    await expect(recoverOrphanPayments(deps)).rejects.toMatchObject({ code: 'db_unavailable' });
    expect(deps.reconcile).not.toHaveBeenCalled();
  });
});

describe('placedOrderId', () => {
  it('注文を作る行動のときだけ注文の ID を返す', () => {
    expect(placedOrderId(placed('order-1'))).toBe('order-1');
    expect(placedOrderId(placed('order-2', 'place_and_mark_awaiting'))).toBe('order-2');
    expect(placedOrderId({ kind: 'ok', action: { type: 'mark_awaiting' }, orderId: 'order-3', orderStatus: 'pending' })).toBeNull();
    expect(placedOrderId({ kind: 'needs_action', exceptionId: 'e', reason: 'order_not_creatable', orderId: null, orderStatus: null })).toBeNull();
  });
});

describe('createOrphanRecoveryDeps', () => {
  function ordersClient(responses: Array<{ data: unknown; error: unknown }>) {
    const inFn = jest.fn();
    for (const response of responses) inFn.mockResolvedValueOnce(response);
    const select = jest.fn(() => ({ in: inFn }));
    return { db: { from: jest.fn(() => ({ select })) } as unknown as OrdersQueryClient, select, inFn };
  }

  it('Stripe から直近の完了済みの Session を読み、ID を返す', async () => {
    const list = jest.fn(() => (async function* () {
      yield { id: 'cs_1' };
      yield { id: 'cs_2' };
    })());
    const deps = createOrphanRecoveryDeps({
      db: ordersClient([]).db,
      opsStore: { rpc: jest.fn() } as unknown as OpsStore,
      stripe: { checkout: { sessions: { list } } },
      reconcilerDeps: RECONCILER_DEPS,
      deadline: NOW,
    });

    const seen: string[] = [];
    for await (const sessionId of deps.listCompletedSessionIds(1_000)) seen.push(sessionId);

    expect(list).toHaveBeenCalledWith({ created: { gte: 1_000 }, status: 'complete', limit: 100 });
    expect(seen).toEqual(['cs_1', 'cs_2']);
    expect(deps.deadline).toBe(NOW);
  });

  it('注文のある Session の ID を集め、DB の失敗は db_unavailable にする', async () => {
    const { db, select, inFn } = ordersClient([
      { data: [{ checkout_session_id: 'cs_1' }], error: null },
      { data: null, error: { message: 'down' } },
    ]);
    const deps = createOrphanRecoveryDeps({
      db,
      opsStore: { rpc: jest.fn() } as unknown as OpsStore,
      stripe: { checkout: { sessions: { list: jest.fn() } } },
      reconcilerDeps: RECONCILER_DEPS,
      deadline: NOW,
    });

    await expect(deps.findSessionIdsWithOrders(['cs_1', 'cs_2'])).resolves.toEqual(new Set(['cs_1']));
    expect(select).toHaveBeenCalledWith('checkout_session_id');
    expect(inFn).toHaveBeenCalledWith('checkout_session_id', ['cs_1', 'cs_2']);
    await expect(deps.findSessionIdsWithOrders(['cs_3'])).rejects.toMatchObject({ code: 'db_unavailable' });
  });

  it('照合関数には Session ID だけを渡し、印は DB の関数で付ける', async () => {
    mockReconcileCheckoutPayment.mockResolvedValue(placed('order-1'));
    const rpc = jest.fn().mockResolvedValue({ data: 'recovered_from_payment', error: null });
    const deps = createOrphanRecoveryDeps({
      db: ordersClient([]).db,
      opsStore: { rpc } as unknown as OpsStore,
      stripe: { checkout: { sessions: { list: jest.fn() } } },
      reconcilerDeps: RECONCILER_DEPS,
      deadline: NOW,
    });

    await expect(deps.reconcile('cs_1')).resolves.toEqual(placed('order-1'));
    expect(mockReconcileCheckoutPayment).toHaveBeenCalledWith(RECONCILER_DEPS, { checkoutSessionId: 'cs_1' });
    await expect(deps.markRecovered('order-1')).resolves.toBe('recovered_from_payment');
    expect(rpc).toHaveBeenCalledWith('mark_order_recovered_from_payment', { _order_id: 'order-1' });
  });
});

describe('loadRecoveredOrderSummaries', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('拾った注文の金額を読む。読めなければ金額不明（null）のまま返し、読めなかったことを1行だけ記録する', async () => {
    const inFn = jest.fn()
      .mockResolvedValueOnce({ data: [{ id: 'order-1', total_amount: 12000, currency: 'jpy' }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    const db = { from: () => ({ select: () => ({ in: inFn }) }) } as unknown as OrdersQueryClient;
    const recovered = [
      { orderId: 'order-1', reviewReason: 'recovered_from_payment' as const },
      { orderId: 'order-2', reviewReason: 'stock_not_reserved' as const },
    ];

    await expect(loadRecoveredOrderSummaries(db, recovered)).resolves.toEqual([
      { orderId: 'order-1', reviewReason: 'recovered_from_payment', totalAmount: 12000, currency: 'jpy' },
      { orderId: 'order-2', reviewReason: 'stock_not_reserved', totalAmount: null, currency: null },
    ]);
    expect(inFn).toHaveBeenCalledWith('id', ['order-1', 'order-2']);
    expect(console.error).not.toHaveBeenCalled();
    await expect(loadRecoveredOrderSummaries(db, recovered.slice(0, 1))).resolves.toEqual([
      { orderId: 'order-1', reviewReason: 'recovered_from_payment', totalAmount: null, currency: null },
    ]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('[orphan-recovery] Failed to read recovered order amounts', 'db_unavailable');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('down');
  });

  it('印を付けられなかった注文（reviewReason が null）も、そのまま返す', async () => {
    const inFn = jest.fn()
      .mockResolvedValueOnce({ data: [{ id: 'order-1', total_amount: 5000, currency: 'jpy' }], error: null });
    const db = { from: () => ({ select: () => ({ in: inFn }) }) } as unknown as OrdersQueryClient;

    await expect(loadRecoveredOrderSummaries(db, [{ orderId: 'order-1', reviewReason: null }])).resolves.toEqual([
      { orderId: 'order-1', reviewReason: null, totalAmount: 5000, currency: 'jpy' },
    ]);
  });

  it('拾った注文が無ければ DB を読まない', async () => {
    const from = jest.fn();
    await expect(loadRecoveredOrderSummaries({ from } as unknown as OrdersQueryClient, [])).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});
