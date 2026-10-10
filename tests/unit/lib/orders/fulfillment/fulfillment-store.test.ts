import fs from 'node:fs';
import path from 'node:path';
import {
  cancelCompletion,
  cancelFulfillment,
  createFulfillment,
  FulfillmentOperationError,
  FulfillmentStoreError,
  listOrderCompletions,
  listOrderFulfillments,
  listOrderLineFulfillment,
  recordCompletion,
  toFulfillmentErrorCode,
  type FulfillmentStore,
} from '@/lib/orders/fulfillment/fulfillment-store';
import { FULFILLMENT_ERROR_CODES, type FulfillmentErrorCode } from '@/lib/orders/fulfillment/fulfillment-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const EMPTY_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455558888';
const ACTOR_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'c1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'd1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'f1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'f1b2c3d4-1111-4222-8333-444455556662';

type RpcAnswer = { data?: unknown; error?: { message?: string; code?: string } | null };

/** rpc だけを持つ入れ物。関数の名前ごとに答えを決める。決めていない関数は空の行を返す */
function storeWith(answers: Record<string, RpcAnswer>) {
  const rpc = jest.fn(async (...call: [name: string, args?: Record<string, unknown>]) => {
    const answer = answers[call[0]];
    return { data: answer?.data ?? [], error: answer?.error ?? null };
  });
  return { store: { rpc } as unknown as FulfillmentStore, rpc };
}

// DB の関数が止める言葉 → 誤りの記号（共通の約束 C-2）
const DB_WORDS = [
  ['ORDER_NOT_FOUND', 'order_not_found'],
  ['ORDER_NOT_SHIPPABLE', 'not_shippable'],
  ['SHIPPING_ADDRESS_INCOMPLETE', 'address_incomplete'],
  ['PAYMENT_REVIEW_REQUIRED', 'payment_review_required'],
  ['LINE_NOT_IN_ORDER', 'quantity_exceeds_ready'],
  ['QUANTITY_EXCEEDS_READY', 'quantity_exceeds_ready'],
  ['FULFILLMENT_REQUEST_MISMATCH', 'fulfillment_request_mismatch'],
  ['FULFILLMENT_ARGUMENT_INVALID', 'invalid_argument'],
  ['COMPLETION_ARGUMENT_INVALID', 'invalid_argument'],
  ['FULFILLMENT_NOT_FOUND', 'fulfillment_not_found'],
  ['FULFILLMENT_CANCEL_NOT_ALLOWED', 'fulfillment_cancel_not_allowed'],
  ['ORDER_NOT_IN_PRODUCTION', 'not_in_production'],
  ['LINE_NOT_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['QUANTITY_EXCEEDS_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['COMPLETION_REQUEST_MISMATCH', 'completion_request_mismatch'],
  ['COMPLETION_NOT_FOUND', 'completion_not_found'],
  ['COMPLETION_ALREADY_SHIPPED', 'completion_already_shipped'],
] as const satisfies ReadonlyArray<readonly [string, FulfillmentErrorCode]>;

describe('toFulfillmentErrorCode', () => {
  it.each(DB_WORDS)('DB の言葉 %s は %s', (word, code) => {
    expect(toFulfillmentErrorCode(word)).toBe(code);
    // PostgREST は言葉の前後に別の文を足すことがある
    expect(toFulfillmentErrorCode(`error: ${word} (detail)`)).toBe(code);
  });

  it('14の記号が全部、どれかの DB の言葉から届く', () => {
    expect(new Set(DB_WORDS.map(([, code]) => code))).toEqual(new Set(FULFILLMENT_ERROR_CODES));
  });

  it('表に無い言葉・空・undefined は null', () => {
    expect(toFulfillmentErrorCode('TOO_MANY_ORDERS')).toBeNull();
    expect(toFulfillmentErrorCode('connection refused')).toBeNull();
    expect(toFulfillmentErrorCode('')).toBeNull();
    expect(toFulfillmentErrorCode(undefined)).toBeNull();
  });

  it('DB の関数が止める言葉は、移行の本文にある（綴りが食い違うと、画面に出る言葉が変わる）', () => {
    // 版の頭の数字は本番に当てる時に付け替わるので、名前の後ろで探す
    const migrationText = (suffix: string) => {
      const directory = path.join(process.cwd(), 'supabase/migrations');
      const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
      expect(files).toHaveLength(1);
      return fs.readFileSync(path.join(directory, files[0]), 'utf8');
    };
    const sql = `${migrationText('_order_fulfillments.sql')}\n${migrationText('_fulfillment_order_emails.sql')}`;

    for (const [word] of DB_WORDS) {
      expect(sql).toContain(word);
    }
  });
});

describe('createFulfillment', () => {
  const INPUT = {
    orderId: ORDER_ID,
    actorId: ACTOR_ID,
    requestKey: REQUEST_KEY,
    carrier: 'yamato' as const,
    trackingNumber: '1234-5678-9012',
    notifyCustomer: true,
    lines: [{ orderItemId: ITEM_1, quantity: 2 }, { orderItemId: ITEM_2, quantity: 1 }],
  };

  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す', async () => {
    const { store, rpc } = storeWith({
      admin_create_fulfillment: {
        data: [{ fulfillment_id: FULFILLMENT_ID, number: 2, completes_order: false, order_status: 'paid', replayed: false }],
      },
    });

    await expect(createFulfillment(store, INPUT)).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 2, completesOrder: false, orderStatus: 'paid', replayed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_create_fulfillment', {
      _order_id: ORDER_ID,
      _actor_id: ACTOR_ID,
      _request_key: REQUEST_KEY,
      _shipping_carrier: 'yamato',
      _tracking_number: '1234-5678-9012',
      _notify_customer: true,
      _lines: [{ order_item_id: ITEM_1, quantity: 2 }, { order_item_id: ITEM_2, quantity: 1 }],
    });
  });

  it('全部送った発送は completesOrder と発送済みを返す。同じ番号の送り直しは replayed が true', async () => {
    const { store } = storeWith({
      admin_create_fulfillment: {
        // PostgREST は行を1つのオブジェクトで返すこともある
        data: { fulfillment_id: FULFILLMENT_ID, number: 3, completes_order: true, order_status: 'shipped', replayed: true },
      },
    });

    await expect(createFulfillment(store, { ...INPUT, notifyCustomer: false })).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 3, completesOrder: true, orderStatus: 'shipped', replayed: true,
    });
  });

  it('DB が決まった言葉で断れば、記号を持つ FulfillmentOperationError', async () => {
    const { store } = storeWith({
      admin_create_fulfillment: { error: { message: 'QUANTITY_EXCEEDS_READY', code: '22023' } },
    });

    const error = await createFulfillment(store, INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FulfillmentOperationError);
    expect(error).toMatchObject({ code: 'quantity_exceeds_ready' });
  });

  it('知らない DB の失敗は FulfillmentStoreError。DB の文はメッセージに入れず、cause にだけ残す', async () => {
    const dbError = { message: '宛先・氏名を含む DB の文', code: '08006' };
    const { store } = storeWith({ admin_create_fulfillment: { error: dbError } });

    const error = (await createFulfillment(store, INPUT).catch((caught: unknown) => caught)) as FulfillmentStoreError;

    expect(error).toBeInstanceOf(FulfillmentStoreError);
    expect(error).not.toBeInstanceOf(FulfillmentOperationError);
    expect(error.message).toBe('fulfillment store failed: admin_create_fulfillment');
    expect(error.operation).toBe('admin_create_fulfillment');
    expect(error.code).toBe('08006');
    expect(error.cause).toEqual(dbError);
  });

  it('行が返らなければ FulfillmentStoreError', async () => {
    const { store } = storeWith({ admin_create_fulfillment: { data: [] } });

    await expect(createFulfillment(store, INPUT)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('cancelFulfillment', () => {
  const INPUT = { orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, actorId: ACTOR_ID };

  it('DB の関数の引数名のとおりに渡し、取り消した結果と注文の状態を返す', async () => {
    const { store, rpc } = storeWith({ admin_cancel_fulfillment: { data: [{ outcome: 'cancelled', order_status: 'paid' }] } });

    await expect(cancelFulfillment(store, INPUT)).resolves.toEqual({ outcome: 'cancelled', orderStatus: 'paid' });

    expect(rpc).toHaveBeenCalledWith('admin_cancel_fulfillment', {
      _order_id: ORDER_ID, _fulfillment_id: FULFILLMENT_ID, _actor_id: ACTOR_ID,
    });
  });

  it('もう取り消してあれば already_cancelled', async () => {
    const { store } = storeWith({ admin_cancel_fulfillment: { data: [{ outcome: 'already_cancelled', order_status: 'paid' }] } });

    await expect(cancelFulfillment(store, INPUT)).resolves.toEqual({ outcome: 'already_cancelled', orderStatus: 'paid' });
  });

  it('DB の言葉は記号に直し、知らない結果の言葉は FulfillmentStoreError', async () => {
    const refused = storeWith({ admin_cancel_fulfillment: { error: { message: 'FULFILLMENT_CANCEL_NOT_ALLOWED', code: '22023' } } });
    await expect(cancelFulfillment(refused.store, INPUT)).rejects.toMatchObject({ code: 'fulfillment_cancel_not_allowed' });

    const unknown = storeWith({ admin_cancel_fulfillment: { data: [{ outcome: 'weird', order_status: 'paid' }] } });
    await expect(cancelFulfillment(unknown.store, INPUT)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('recordCompletion', () => {
  const INPUT = { orderId: ORDER_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY, lines: [{ orderItemId: ITEM_1, quantity: 2 }] };

  it('DB の関数の引数名のとおりに渡し、記録した行の番号を集める', async () => {
    const { store, rpc } = storeWith({
      admin_record_completion: {
        data: [
          { completion_id: COMPLETION_ID, order_item_id: ITEM_1, quantity: 2, replayed: false },
          { completion_id: 'e1b2c3d4-1111-4222-8333-444455556667', order_item_id: ITEM_2, quantity: 1, replayed: false },
        ],
      },
    });

    await expect(recordCompletion(store, INPUT)).resolves.toEqual({
      completionIds: [COMPLETION_ID, 'e1b2c3d4-1111-4222-8333-444455556667'], replayed: false,
    });

    expect(rpc).toHaveBeenCalledWith('admin_record_completion', {
      _order_id: ORDER_ID, _actor_id: ACTOR_ID, _request_key: REQUEST_KEY, _lines: [{ order_item_id: ITEM_1, quantity: 2 }],
    });
  });

  it('同じ番号の送り直しは、全部の行が replayed のとき replayed が true', async () => {
    const { store } = storeWith({
      admin_record_completion: { data: [{ completion_id: COMPLETION_ID, order_item_id: ITEM_1, quantity: 2, replayed: true }] },
    });

    await expect(recordCompletion(store, INPUT)).resolves.toEqual({ completionIds: [COMPLETION_ID], replayed: true });
  });

  it('DB の言葉は記号に直し、行が返らなければ FulfillmentStoreError', async () => {
    const refused = storeWith({ admin_record_completion: { error: { message: 'QUANTITY_EXCEEDS_IN_PRODUCTION', code: '22023' } } });
    await expect(recordCompletion(refused.store, INPUT)).rejects.toMatchObject({ code: 'quantity_exceeds_in_production' });

    const empty = storeWith({ admin_record_completion: { data: [] } });
    await expect(recordCompletion(empty.store, INPUT)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('cancelCompletion', () => {
  const INPUT = { orderId: ORDER_ID, completionId: COMPLETION_ID, actorId: ACTOR_ID };

  it('DB の関数の引数名のとおりに渡し、結果を返す', async () => {
    const { store, rpc } = storeWith({ admin_cancel_completion: { data: [{ outcome: 'cancelled' }] } });

    await expect(cancelCompletion(store, INPUT)).resolves.toEqual({ outcome: 'cancelled' });

    expect(rpc).toHaveBeenCalledWith('admin_cancel_completion', {
      _order_id: ORDER_ID, _completion_id: COMPLETION_ID, _actor_id: ACTOR_ID,
    });
  });

  it('送った数を下回る取消は、記号 completion_already_shipped で断る', async () => {
    const { store } = storeWith({ admin_cancel_completion: { error: { message: 'COMPLETION_ALREADY_SHIPPED', code: '22023' } } });

    await expect(cancelCompletion(store, INPUT)).rejects.toMatchObject({ code: 'completion_already_shipped' });
  });
});

describe('listOrderFulfillments / listOrderCompletions', () => {
  it('発送の一覧を窓口の形に直す。商品の行は jsonb の配列から読む', async () => {
    const { store, rpc } = storeWith({
      list_order_fulfillments: {
        data: [{
          fulfillment_id: FULFILLMENT_ID, number: 2, shipping_carrier: 'yamato', tracking_number: '1234-5678-9012', notify_customer: true,
          completes_order: false, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
          cancelled_by_email: null, legacy: false, lines: [{ order_item_id: ITEM_1, quantity: 2 }],
        }],
      },
    });

    await expect(listOrderFulfillments(store, ORDER_ID)).resolves.toEqual([{
      fulfillmentId: FULFILLMENT_ID, number: 2, shippingCarrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: true,
      completesOrder: false, shippedAt: '2026-10-10T02:00:00+00:00', createdByEmail: 'admin@example.com', cancelledAt: null,
      cancelledByEmail: null, legacy: false, lines: [{ orderItemId: ITEM_1, quantity: 2 }],
    }]);

    expect(rpc).toHaveBeenCalledWith('list_order_fulfillments', { _order_id: ORDER_ID });
  });

  it('前からの記録（配送業者・伝票番号・操作した人が空）と、取り消した記録も読める', async () => {
    const { store } = storeWith({
      list_order_fulfillments: {
        data: [{
          fulfillment_id: FULFILLMENT_ID, number: 1, shipping_carrier: null, tracking_number: null, notify_customer: false,
          completes_order: true, shipped_at: '2026-09-01T00:00:00+00:00', created_by_email: null,
          cancelled_at: '2026-10-11T03:00:00+00:00', cancelled_by_email: 'owner@example.com', legacy: true, lines: null,
        }],
      },
    });

    await expect(listOrderFulfillments(store, ORDER_ID)).resolves.toEqual([{
      fulfillmentId: FULFILLMENT_ID, number: 1, shippingCarrier: null, trackingNumber: null, notifyCustomer: false,
      completesOrder: true, shippedAt: '2026-09-01T00:00:00+00:00', createdByEmail: null,
      cancelledAt: '2026-10-11T03:00:00+00:00', cancelledByEmail: 'owner@example.com', legacy: true, lines: [],
    }]);
  });

  it('仕上がりの一覧を窓口の形に直す', async () => {
    const { store, rpc } = storeWith({
      list_order_completions: {
        data: [{
          completion_id: COMPLETION_ID, order_item_id: ITEM_2, quantity: 1, created_at: '2026-10-10T01:00:00+00:00',
          created_by_email: null, cancelled_at: null, cancelled_by_email: null, legacy: true,
        }],
      },
    });

    await expect(listOrderCompletions(store, ORDER_ID)).resolves.toEqual([{
      completionId: COMPLETION_ID, orderItemId: ITEM_2, quantity: 1, createdAt: '2026-10-10T01:00:00+00:00',
      createdByEmail: null, cancelledAt: null, cancelledByEmail: null, legacy: true,
    }]);

    expect(rpc).toHaveBeenCalledWith('list_order_completions', { _order_id: ORDER_ID });
  });

  it('DB の失敗は FulfillmentStoreError', async () => {
    const { store } = storeWith({ list_order_fulfillments: { error: { message: 'down', code: '08006' } } });

    await expect(listOrderFulfillments(store, ORDER_ID)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('listOrderLineFulfillment', () => {
  const countRow = (orderId: string, orderItemId: string, overrides: Record<string, unknown> = {}) => ({
    order_id: orderId, order_item_id: orderItemId, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 1,
    completed: 2, in_production: 0, ready_unshipped: 1, unshipped: 1, ...overrides,
  });

  it('空の入力は DB を呼ばず、空の Map を返す', async () => {
    const { store, rpc } = storeWith({});

    await expect(listOrderLineFulfillment(store, [])).resolves.toEqual(new Map());

    expect(rpc).not.toHaveBeenCalled();
  });

  it('行を注文ごとに集める。行が無い注文も空の配列でキーに入る。受注生産の行は variantId が null でもよい', async () => {
    const { store, rpc } = storeWith({
      list_order_line_fulfillment: {
        data: [
          countRow(ORDER_ID, ITEM_1),
          countRow(ORDER_ID, ITEM_2, { variant_id: null, fulfillment_type: 'backorder', quantity: 3, shipped: 0, completed: 1, in_production: 2, ready_unshipped: 1, unshipped: 3 }),
          countRow(OTHER_ORDER_ID, 'f1b2c3d4-1111-4222-8333-444455556663'),
        ],
      },
    });

    const result = await listOrderLineFulfillment(store, [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID] });
    expect(result.get(ORDER_ID)).toEqual([
      {
        orderId: ORDER_ID, orderItemId: ITEM_1, variantId: 11, fulfillmentType: 'stock', quantity: 2, shipped: 1, completed: 2,
        inProduction: 0, readyUnshipped: 1, unshipped: 1,
      },
      {
        orderId: ORDER_ID, orderItemId: ITEM_2, variantId: null, fulfillmentType: 'backorder', quantity: 3, shipped: 0, completed: 1,
        inProduction: 2, readyUnshipped: 1, unshipped: 3,
      },
    ]);
    expect(result.get(OTHER_ORDER_ID)).toHaveLength(1);
    expect(result.get(EMPTY_ORDER_ID)).toEqual([]);
  });

  it('同じ番号は1回として数える', async () => {
    const { store, rpc } = storeWith({ list_order_line_fulfillment: { data: [countRow(ORDER_ID, ITEM_1)] } });

    const result = await listOrderLineFulfillment(store, [ORDER_ID, ORDER_ID]);

    expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
    expect(result.get(ORDER_ID)).toHaveLength(1);
  });

  it('200件ずつに分けて呼ぶ（DB の関数は201件以上を断るため）', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const { store, rpc } = storeWith({ list_order_line_fulfillment: { data: [] } });

    const result = await listOrderLineFulfillment(store, ids);

    expect(rpc.mock.calls.map(([, args]) => (args?._order_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(rpc.mock.calls[0][1]?._order_ids).toEqual(ids.slice(0, 200));
    expect(rpc.mock.calls[2][1]?._order_ids).toEqual(ids.slice(400));
    expect(result.size).toBe(450);
  });

  it('DB の失敗は FulfillmentStoreError', async () => {
    const { store } = storeWith({ list_order_line_fulfillment: { error: { message: 'TOO_MANY_ORDERS', code: '22023' } } });

    await expect(listOrderLineFulfillment(store, [ORDER_ID])).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});
