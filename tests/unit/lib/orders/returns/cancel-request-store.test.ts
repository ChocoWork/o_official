import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import {
  closeCancelRequest,
  declineCancelRequest,
  listOrderCancelRequests,
  resolveCancelRequest,
} from '@/lib/orders/returns/cancel-request-store';
import { ReturnStoreError, type ReturnStore } from '@/lib/orders/returns/return-store';
import { declaredParams, expectRefusal, migrationText, storeWith } from './return-store-test-utils';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const ACTOR_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const REFUND_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const CANCEL_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = '11b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = '11b2c3d4-1111-4222-8333-444455556662';

// TS が呼ぶ DB の関数（移行 F）と、その呼び出し
const CALLS: Array<[rpcName: string, run: (store: ReturnStore) => Promise<unknown>]> = [
  ['list_order_cancel_requests', (store) => listOrderCancelRequests(store, ORDER_ID)],
  [
    'admin_decline_cancel_request',
    (store) =>
      declineCancelRequest(store, {
        cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, declineReason: 'other', declineMessage: 'すでに発送の準備を進めています。',
      }),
  ],
  ['admin_close_cancel_request', (store) => closeCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID })],
  [
    'admin_resolve_cancel_request',
    (store) => resolveCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, refundId: REFUND_ID, orderCancelled: false }),
  ],
];

// 答えの行が1つ要る関数（行が返らなければ、DB の誤りとして止める）
const ROW_REQUIRED_RPCS = ['admin_decline_cancel_request', 'admin_close_cancel_request', 'admin_resolve_cancel_request'];

describe('移行 F との突き合わせ（段2の Task 3 の移行がある前提。無ければこの describe だけ FAIL する）', () => {
  it('TS が呼ぶ DB の関数は、移行 F の本文にある（名前が食い違うと、呼んだ時に初めて分かる）', () => {
    const sql = migrationText('_order_return_request_reviews.sql');

    for (const [rpcName] of CALLS) {
      expect(sql).toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${rpcName}\\s*\\(`));
    }
  });

  it.each(CALLS)('%s に渡す引数の名前は、移行 F の関数の引数と一字も違わない（食い違うと PostgREST が関数を見つけられない）', async (rpcName, run) => {
    const { store, rpc } = storeWith({});

    await run(store).catch(() => undefined);

    expect(rpc).toHaveBeenCalledTimes(1);
    const [calledName, args] = rpc.mock.calls[0];
    expect(calledName).toBe(rpcName);
    const declared = declaredParams(migrationText('_order_return_request_reviews.sql'), rpcName);
    const passed = Object.keys(args ?? {});
    // 渡した引数が関数に無い、または、省略できない引数を渡していない
    expect(passed.filter((name) => !declared.some((param) => param.name === name))).toEqual([]);
    expect(declared.filter((param) => !param.optional && !passed.includes(param.name)).map((param) => param.name)).toEqual([]);
  });

  it('キャンセルの申し込みで DB が止める言葉は、移行 F の本文にある（綴りが食い違うと、画面に出る言葉が変わる）', () => {
    const sql = migrationText('_order_return_request_reviews.sql');

    for (const word of [
      'CANCEL_REQUEST_NOT_FOUND',
      'CANCEL_REQUEST_STATE_CONFLICT',
      'CANCEL_REQUEST_RESOLUTION_INVALID',
      'RETURN_DECLINE_MESSAGE_REQUIRED',
    ]) {
      expect(sql).toContain(word);
    }
  });
});

describe('listOrderCancelRequests', () => {
  // list_order_cancel_requests の答え（jsonb の配列。共通の約束 C-2 の AdminCancelRequest のキーを snake_case にした形）
  const NOTHING = {
    decline_reason: null, decline_message: null, declined_at: null, declined_by_email: null,
    resolved_at: null, resolved_by_email: null, resolved_refund_id: null, resolved_by_cancel_at: null,
    closed_at: null, closed_by_email: null,
  };
  const REQUESTED_JSON = {
    id: CANCEL_ID, status: 'requested', requested_at: '2026-10-12T02:00:00+00:00', customer_note: '色違いを買い直します',
    lines: [
      { order_item_id: ITEM_1, item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, unshipped: 1 },
      { order_item_id: ITEM_2, item_name: 'レザーベルト', color: null, size: null, quantity: 1, unshipped: 0 },
    ],
    ...NOTHING,
  };
  const NOTHING_CAMEL = {
    declineReason: null, declineMessage: null, declinedAt: null, declinedByEmail: null,
    resolvedAt: null, resolvedByEmail: null, resolvedRefundId: null, resolvedByCancelAt: null,
    closedAt: null, closedByEmail: null,
  };
  const REQUESTED = {
    id: CANCEL_ID, status: 'requested', requestedAt: '2026-10-12T02:00:00+00:00', customerNote: '色違いを買い直します',
    lines: [
      { orderItemId: ITEM_1, itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, unshipped: 1 },
      { orderItemId: ITEM_2, itemName: 'レザーベルト', color: null, size: null, quantity: 1, unshipped: 0 },
    ],
    ...NOTHING_CAMEL,
  };

  it('注文のキャンセルの申し込みの一覧を、キーを camelCase にして返す', async () => {
    const { store, rpc } = storeWith({ list_order_cancel_requests: { data: [REQUESTED_JSON] } });

    await expect(listOrderCancelRequests(store, ORDER_ID)).resolves.toEqual([REQUESTED]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_order_cancel_requests', { _order_id: ORDER_ID });
  });

  it('お断り・解決（返金）・解決（取消）・解決済みの申し込みの中身と、した人のメールを写す', async () => {
    const declined = {
      ...REQUESTED_JSON, id: 'e2b2c3d4-1111-4222-8333-444455556666', status: 'declined', customer_note: null,
      decline_reason: 'other', decline_message: 'すでに発送の準備を進めています。',
      declined_at: '2026-10-12T03:00:00+00:00', declined_by_email: 'support@example.com',
    };
    const resolvedByRefund = {
      ...REQUESTED_JSON, id: 'e3b2c3d4-1111-4222-8333-444455556666', status: 'resolved',
      resolved_at: '2026-10-12T04:00:00+00:00', resolved_by_email: 'owner@example.com', resolved_refund_id: REFUND_ID,
    };
    const resolvedByCancel = {
      ...REQUESTED_JSON, id: 'e4b2c3d4-1111-4222-8333-444455556666', status: 'resolved',
      resolved_at: '2026-10-12T05:00:00+00:00', resolved_by_email: 'owner@example.com', resolved_by_cancel_at: '2026-10-12T04:59:00+00:00',
    };
    const closed = {
      ...REQUESTED_JSON, id: 'e5b2c3d4-1111-4222-8333-444455556666', status: 'closed',
      closed_at: '2026-10-12T06:00:00+00:00', closed_by_email: 'support@example.com',
    };
    const { store } = storeWith({ list_order_cancel_requests: { data: [declined, resolvedByRefund, resolvedByCancel, closed] } });

    const [d, r, c, x] = await listOrderCancelRequests(store, ORDER_ID);

    expect(d).toMatchObject({
      status: 'declined', customerNote: null, declineReason: 'other', declineMessage: 'すでに発送の準備を進めています。',
      declinedAt: '2026-10-12T03:00:00+00:00', declinedByEmail: 'support@example.com',
    });
    expect(r).toMatchObject({
      status: 'resolved', resolvedAt: '2026-10-12T04:00:00+00:00', resolvedByEmail: 'owner@example.com',
      resolvedRefundId: REFUND_ID, resolvedByCancelAt: null,
    });
    expect(c).toMatchObject({
      status: 'resolved', resolvedRefundId: null, resolvedByCancelAt: '2026-10-12T04:59:00+00:00',
    });
    expect(x).toMatchObject({ status: 'closed', closedAt: '2026-10-12T06:00:00+00:00', closedByEmail: 'support@example.com' });
  });

  it('お断りの理由の3つの記号を写す。表に無い記号は null', async () => {
    for (const reason of ['window_passed', 'final_sale', 'other']) {
      const { store } = storeWith({ list_order_cancel_requests: { data: [{ ...REQUESTED_JSON, decline_reason: reason }] } });

      const [request] = await listOrderCancelRequests(store, ORDER_ID);

      expect(request.declineReason).toBe(reason);
    }
    const weird = storeWith({ list_order_cancel_requests: { data: [{ ...REQUESTED_JSON, decline_reason: 'weird' }] } });
    const [request] = await listOrderCancelRequests(weird.store, ORDER_ID);
    expect(request.declineReason).toBeNull();
  });

  it('申し込みが無ければ空の配列。状態が表に無い記号なら、黙って別の状態にせず RefundStoreError', async () => {
    const empty = storeWith({ list_order_cancel_requests: { data: null } });
    await expect(listOrderCancelRequests(empty.store, ORDER_ID)).resolves.toEqual([]);

    const weird = storeWith({ list_order_cancel_requests: { data: [{ ...REQUESTED_JSON, status: 'weird' }] } });
    const error = await listOrderCancelRequests(weird.store, ORDER_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).toMatchObject({ operation: 'list_order_cancel_requests' });
  });
});

describe('declineCancelRequest・closeCancelRequest・resolveCancelRequest', () => {
  it('declineCancelRequest: DB の関数の引数名のとおりに渡し、申し込みの番号と状態を返す', async () => {
    const { store, rpc } = storeWith({
      admin_decline_cancel_request: { data: [{ cancel_request_id: CANCEL_ID, status: 'declined' }] },
    });

    await expect(
      declineCancelRequest(store, {
        cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, declineReason: 'window_passed', declineMessage: '受付の期限を過ぎています。',
      }),
    ).resolves.toEqual({ cancelRequestId: CANCEL_ID, status: 'declined' });

    expect(rpc).toHaveBeenCalledWith('admin_decline_cancel_request', {
      _cancel_request_id: CANCEL_ID,
      _actor_id: ACTOR_ID,
      _decline_reason: 'window_passed',
      _decline_message: '受付の期限を過ぎています。',
    });
  });

  it('closeCancelRequest: 「解決済みにする」。申し込みの番号と実行した人だけを渡す', async () => {
    const { store, rpc } = storeWith({ admin_close_cancel_request: { data: { cancel_request_id: CANCEL_ID, status: 'closed' } } });

    await expect(closeCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID })).resolves.toEqual({
      cancelRequestId: CANCEL_ID, status: 'closed',
    });

    expect(rpc).toHaveBeenCalledWith('admin_close_cancel_request', { _cancel_request_id: CANCEL_ID, _actor_id: ACTOR_ID });
  });

  it('resolveCancelRequest: 返金で解決する時は返金の番号を渡し、取消の印は偽。取消で解決する時は返金の番号が null で、取消の印が真', async () => {
    const { store, rpc } = storeWith({ admin_resolve_cancel_request: { data: [{ cancel_request_id: CANCEL_ID, status: 'resolved' }] } });

    await expect(
      resolveCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, refundId: REFUND_ID, orderCancelled: false }),
    ).resolves.toEqual({ cancelRequestId: CANCEL_ID, status: 'resolved' });
    expect(rpc).toHaveBeenLastCalledWith('admin_resolve_cancel_request', {
      _cancel_request_id: CANCEL_ID, _actor_id: ACTOR_ID, _refund_id: REFUND_ID, _order_cancelled: false,
    });

    await resolveCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, refundId: null, orderCancelled: true });
    expect(rpc).toHaveBeenLastCalledWith('admin_resolve_cancel_request', {
      _cancel_request_id: CANCEL_ID, _actor_id: ACTOR_ID, _refund_id: null, _order_cancelled: true,
    });
  });

  it.each([
    [
      'admin_decline_cancel_request', 'CANCEL_REQUEST_NOT_FOUND',
      (store: ReturnStore) =>
        declineCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, declineReason: 'other', declineMessage: 'x' }),
    ],
    [
      'admin_decline_cancel_request', 'RETURN_DECLINE_MESSAGE_REQUIRED',
      (store: ReturnStore) =>
        declineCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, declineReason: 'other', declineMessage: ' ' }),
    ],
    [
      'admin_decline_cancel_request', 'CANCEL_REQUEST_STATE_CONFLICT',
      (store: ReturnStore) =>
        declineCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, declineReason: 'other', declineMessage: 'x' }),
    ],
    [
      'admin_close_cancel_request', 'CANCEL_REQUEST_STATE_CONFLICT',
      (store: ReturnStore) => closeCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID }),
    ],
    [
      'admin_resolve_cancel_request', 'CANCEL_REQUEST_RESOLUTION_INVALID',
      (store: ReturnStore) =>
        resolveCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, refundId: null, orderCancelled: false }),
    ],
    [
      'admin_resolve_cancel_request', 'CANCEL_REQUEST_STATE_CONFLICT',
      (store: ReturnStore) =>
        resolveCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID, refundId: REFUND_ID, orderCancelled: false }),
    ],
  ])('%s は DB が %s で断れば、同じ綴りの記号', async (rpcName, word, run) => {
    await expectRefusal(rpcName, word, word, run);
  });

  it('答えの状態が表に無い記号なら、黙って別の状態にせず RefundStoreError', async () => {
    const { store } = storeWith({ admin_close_cancel_request: { data: [{ cancel_request_id: CANCEL_ID, status: 'weird' }] } });

    const error = await closeCancelRequest(store, { cancelRequestId: CANCEL_ID, actorId: ACTOR_ID }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).toMatchObject({ operation: 'admin_close_cancel_request' });
  });
});

describe.each(CALLS)('%s の失敗', (rpcName, run) => {
  const dbError = { message: '宛先・氏名を含む DB の文', code: '08006' };

  it('記号の無い DB の失敗は RefundStoreError（DB の文はメッセージに入れず、cause にだけ残す）', async () => {
    const { store } = storeWith({ [rpcName]: { error: dbError } });

    const error = (await run(store).catch((caught: unknown) => caught)) as RefundStoreError;

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).not.toBeInstanceOf(ReturnStoreError);
    expect(error.message).toBe(`refund store failed: ${rpcName}`);
    expect(error.operation).toBe(rpcName);
    expect(error.code).toBe('08006');
    expect(error.cause).toEqual(dbError);
  });

  it('DB が返品の言葉で断れば、同じ綴りの記号を持つ ReturnStoreError', async () => {
    await expectRefusal(rpcName, 'RETURN_ARGUMENT_INVALID', 'RETURN_ARGUMENT_INVALID', run);
  });

  it('DB が E-2 の言葉で断れば、E-2 の記号のまま ReturnStoreError に載せる（RefundOperationError にしない）', async () => {
    await expectRefusal(rpcName, 'ORDER_NOT_FOUND', 'order_not_found', run);
  });
});

describe('行が返らない時', () => {
  it.each(CALLS.filter(([rpcName]) => ROW_REQUIRED_RPCS.includes(rpcName)))('%s は RefundStoreError', async (rpcName, run) => {
    const { store } = storeWith({ [rpcName]: { data: [] } });

    const error = await run(store).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).toMatchObject({ operation: rpcName });
  });
});
