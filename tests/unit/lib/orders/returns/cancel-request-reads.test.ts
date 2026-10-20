import type { SupabaseClient } from '@supabase/supabase-js';

const mockListOrderLineFulfillment = jest.fn();
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({
  ...jest.requireActual('@/lib/orders/fulfillment/fulfillment-store'),
  listOrderLineFulfillment: (...args: unknown[]) => mockListOrderLineFulfillment(...args),
}));

import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import {
  CANCEL_REQUEST_FILTER_LIMIT,
  countOrdersWithOpenCancelRequest,
  findOrderIdsWithOpenCancelRequest,
  listOrderIdsWithOpenCancelRequest,
  loadCancelRequestOrderContext,
} from '@/lib/orders/returns/cancel-request-reads';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

type QueryResult = { data?: unknown; count?: number | null; error?: { message?: string; code?: string } | null };

/**
 * from(表) が返す検索の入れ物の見本。select・eq・in・order・limit は呼ばれた順に記録して自分を返し、
 * 待つ（await）と答えが返る。maybeSingle は答えを返す
 */
function fakeClient(result: QueryResult) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder.maybeSingle = async (...args: unknown[]) => {
    calls.push(['maybeSingle', args]);
    return result;
  };
  builder.then = (resolve: (value: QueryResult) => unknown) => resolve(result);
  const from = jest.fn(() => builder);
  return { client: { from } as unknown as SupabaseClient, from, calls };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  mockListOrderLineFulfillment.mockReset();
});

describe('listOrderIdsWithOpenCancelRequest（絞り込み cancelRequest=open の注文の番号）', () => {
  it('開いている申し込み（status = requested）の注文の番号を、申し込みの新しい順に500件まで読む', async () => {
    const { client, from, calls } = fakeClient({ data: [{ order_id: 'order-b' }, { order_id: 'order-a' }], error: null });

    await expect(listOrderIdsWithOpenCancelRequest(client)).resolves.toEqual(['order-b', 'order-a']);

    expect(from).toHaveBeenCalledWith('order_cancel_requests');
    expect(calls).toEqual([
      ['select', ['order_id']],
      ['eq', ['status', 'requested']],
      ['order', ['requested_at', { ascending: false }]],
      ['limit', [500]],
    ]);
    expect(CANCEL_REQUEST_FILTER_LIMIT).toBe(500);
  });

  it('行が無ければ（data が null でも）空の配列', async () => {
    const { client } = fakeClient({ data: null, error: null });

    await expect(listOrderIdsWithOpenCancelRequest(client)).resolves.toEqual([]);
  });

  it('読めなかったら RefundStoreError（呼び出しの名前と DB の記号だけ。DB の文は出さない）', async () => {
    const { client } = fakeClient({ data: null, error: { message: '宛先を含む DB の文', code: '42501' } });

    const error = await errorOf(listOrderIdsWithOpenCancelRequest(client));

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).toMatchObject({ operation: 'list_open_cancel_requests', code: '42501' });
    expect((error as Error).message).not.toContain('宛先');
  });
});

describe('findOrderIdsWithOpenCancelRequest（一覧の各行の印 cancelRequestOpen）', () => {
  it('渡した注文のうち、開いている申し込みのある物の番号を集めて返す', async () => {
    const { client, from, calls } = fakeClient({ data: [{ order_id: 'order-a' }], error: null });

    await expect(findOrderIdsWithOpenCancelRequest(client, ['order-a', 'order-b'])).resolves.toEqual(new Set(['order-a']));

    expect(from).toHaveBeenCalledWith('order_cancel_requests');
    expect(calls).toEqual([
      ['select', ['order_id']],
      ['eq', ['status', 'requested']],
      ['in', ['order_id', ['order-a', 'order-b']]],
    ]);
  });

  it('注文の番号が空なら、DB を読まずに空の集まりを返す', async () => {
    const { client, from } = fakeClient({ data: [], error: null });

    await expect(findOrderIdsWithOpenCancelRequest(client, [])).resolves.toEqual(new Set());
    expect(from).not.toHaveBeenCalled();
  });

  it('読めなかったら RefundStoreError', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'DB の文', code: '08006' } });

    const error = await errorOf(findOrderIdsWithOpenCancelRequest(client, ['order-a']));

    expect(error).toMatchObject({ name: 'RefundStoreError', operation: 'find_open_cancel_requests', code: '08006' });
  });
});

describe('countOrdersWithOpenCancelRequest（一覧の上の一行の数 cancelRequestAttention）', () => {
  it('開いている申し込みの数を、行を読まずに数だけ読む', async () => {
    const { client, from, calls } = fakeClient({ count: 3, error: null });

    await expect(countOrdersWithOpenCancelRequest(client)).resolves.toBe(3);

    expect(from).toHaveBeenCalledWith('order_cancel_requests');
    expect(calls).toEqual([
      ['select', ['id', { count: 'exact', head: true }]],
      ['eq', ['status', 'requested']],
    ]);
  });

  it('数が返らなければ 0', async () => {
    const { client } = fakeClient({ count: null, error: null });

    await expect(countOrdersWithOpenCancelRequest(client)).resolves.toBe(0);
  });

  it('読めなかったら RefundStoreError', async () => {
    const { client } = fakeClient({ error: { message: 'DB の文', code: '08006' } });

    const error = await errorOf(countOrdersWithOpenCancelRequest(client));

    expect(error).toMatchObject({ name: 'RefundStoreError', operation: 'count_open_cancel_requests', code: '08006' });
  });
});

describe('loadCancelRequestOrderContext（キャンセルの申し込みの画面の窓口が読む、注文の状態と発送した数・未発送の数）', () => {
  it('注文の状態と、発送した数・未発送の数の合計（商品の行ごとの数の和）を返す', async () => {
    const { client, from, calls } = fakeClient({ data: { status: 'paid' }, error: null });
    mockListOrderLineFulfillment.mockResolvedValue(
      new Map([[ORDER_ID, [{ shipped: 1, unshipped: 4 }, { shipped: 0, unshipped: 2 }, { shipped: 2, unshipped: 0 }]]]),
    );

    await expect(loadCancelRequestOrderContext(client, ORDER_ID)).resolves.toEqual({ orderStatus: 'paid', shippedUnits: 3, unshippedUnits: 6 });

    expect(from).toHaveBeenCalledWith('orders');
    expect(calls).toEqual([
      ['select', ['status']],
      ['eq', ['id', ORDER_ID]],
      ['maybeSingle', []],
    ]);
    expect(mockListOrderLineFulfillment).toHaveBeenCalledWith(client, [ORDER_ID]);
  });

  it('商品の行が無ければ、発送した数も未発送の数も0', async () => {
    const { client } = fakeClient({ data: { status: 'pending' }, error: null });
    mockListOrderLineFulfillment.mockResolvedValue(new Map());

    await expect(loadCancelRequestOrderContext(client, ORDER_ID)).resolves.toEqual({ orderStatus: 'pending', shippedUnits: 0, unshippedUnits: 0 });
  });

  // listOrderLineFulfillment は、渡した番号を小文字にして DB に引くが、答えの鍵は渡した文字のまま（fulfillment-store.test.ts で固めてある）。
  // 窓口の uuid の検証が通した大文字の番号でも、渡した文字のままで引けば発送の数が合う。ここで小文字に直して引くと、鍵が合わず 0 になる
  it('窓口の検証が通した大文字の注文の番号でも、渡した文字のままで引き、発送の数・未発送の数を合わせる（答えの鍵は渡した文字のまま）', async () => {
    const upper = ORDER_ID.toUpperCase();
    const { client } = fakeClient({ data: { status: 'shipped' }, error: null });
    mockListOrderLineFulfillment.mockImplementation(async (_client: unknown, ids: string[]) =>
      new Map(ids.map((id): [string, Array<{ shipped: number; unshipped: number }>] => [id, [{ shipped: 2, unshipped: 1 }]])),
    );

    await expect(loadCancelRequestOrderContext(client, upper)).resolves.toEqual({
      orderStatus: 'shipped', shippedUnits: 2, unshippedUnits: 1,
    });
    expect(mockListOrderLineFulfillment).toHaveBeenCalledWith(client, [upper]);
  });

  it('注文が無ければ null', async () => {
    const { client } = fakeClient({ data: null, error: null });
    mockListOrderLineFulfillment.mockResolvedValue(new Map());

    await expect(loadCancelRequestOrderContext(client, ORDER_ID)).resolves.toBeNull();
  });

  it('注文を読めなければ RefundStoreError（呼び出しの名前と DB の記号だけ）', async () => {
    const { client } = fakeClient({ data: null, error: { message: '宛先を含む DB の文', code: '42501' } });
    mockListOrderLineFulfillment.mockResolvedValue(new Map());

    const error = await errorOf(loadCancelRequestOrderContext(client, ORDER_ID));

    expect(error).toMatchObject({ name: 'RefundStoreError', operation: 'load_order', code: '42501' });
    expect((error as Error).message).not.toContain('宛先');
  });

  it('発送した数を読めなければ、その誤りをそのまま投げる', async () => {
    const { client } = fakeClient({ data: { status: 'paid' }, error: null });
    mockListOrderLineFulfillment.mockRejectedValue(new Error('list_order_line_fulfillment failed'));

    await expect(loadCancelRequestOrderContext(client, ORDER_ID)).rejects.toThrow('list_order_line_fulfillment failed');
  });
});
