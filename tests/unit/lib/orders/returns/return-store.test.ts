import fs from 'node:fs';
import path from 'node:path';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import type { RefundErrorCode } from '@/lib/orders/refund/refund-types';
import {
  ReturnStoreError,
  cancelReturn,
  closeReturnMissing,
  countReturnAttention,
  createReturn,
  getShopReturnSettings,
  inspectReturn,
  listOrderReturnSummaries,
  listOrderReturns,
  loadReturnCreateMaterials,
  receiveReturn,
  recordReturnFeePayment,
  refundReturn,
  releaseReturnExchange,
  reopenReturn,
  toReturnErrorCode,
  updateShopReturnSettings,
  type CreateReturnInput,
  type ReceiveReturnInput,
  type RefundReturnInput,
  type ReturnStore,
  type ShopReturnSettingsPatch,
} from '@/lib/orders/returns/return-store';
import { RETURN_ERROR_CODES, type ShopReturnSettingsUpdate } from '@/lib/orders/returns/return-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const EMPTY_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455558888';
const ACTOR_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'c1b2c3d4-1111-4222-8333-444455556666';
const RETURN_ID = 'd1b2c3d4-1111-4222-8333-444455556666';
const RECEIPT_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const REFUND_ID = 'f1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = '01b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = '11b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = '11b2c3d4-1111-4222-8333-444455556662';
const EXCHANGE_ITEM_ID = '21b2c3d4-1111-4222-8333-444455556661';
const LINE_1 = '31b2c3d4-1111-4222-8333-444455556661';
const LINE_2 = '31b2c3d4-1111-4222-8333-444455556662';

type RpcAnswer = { data?: unknown; error?: { message?: string; code?: string } | null };

/** rpc だけを持つ入れ物。関数の名前ごとに答えを決める。決めていない関数は空の行を返す（null を決めた時は null のまま返す） */
function storeWith(answers: Record<string, RpcAnswer>) {
  const rpc = jest.fn(async (...call: [name: string, args?: Record<string, unknown>]) => {
    const answer = answers[call[0]];
    return { data: answer && 'data' in answer ? answer.data : [], error: answer?.error ?? null };
  });
  return { store: { rpc } as unknown as ReturnStore, rpc };
}

/** 版の頭の数字は本番に当てる時に付け替わるので、移行のファイルは名前の後ろで探す */
function migrationText(suffix: string): string {
  const directory = path.join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(directory, files[0]), 'utf8');
}

const MIGRATION_SUFFIXES = ['_order_return_records.sql', '_order_return_actions.sql', '_order_return_receipts.sql'];

/** 移行 A・B・C の本文をつないだ物 */
function returnMigrationsText(): string {
  return MIGRATION_SUFFIXES.map(migrationText).join('\n');
}

/** CREATE FUNCTION public.{name}( … ) の引数の名前。DEFAULT のある引数は省略できる物として返す */
function declaredParams(sql: string, name: string): Array<{ name: string; optional: boolean }> {
  // SQL のコメント（-- から行末まで）は、括弧や引用符を含みうるので、先に捨てる
  const text = sql.replace(/--.*$/gm, '');
  const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`).exec(text);
  expect(head).not.toBeNull();

  // 対応する ) までを、括弧・角括弧・引用符の外のカンマで引数に分ける
  const pieces: string[] = [];
  let current = '';
  let depth = 1;
  let quoted = false;
  for (let index = (head?.index ?? 0) + (head?.[0].length ?? 0); index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    if (!quoted && (char === '(' || char === '[')) depth += 1;
    if (!quoted && (char === ')' || char === ']')) depth -= 1;
    if (depth === 0) break;
    if (!quoted && depth === 1 && char === ',') {
      pieces.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  pieces.push(current);

  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .map((piece) => ({ name: piece.split(/\s+/)[0], optional: /\bDEFAULT\b/i.test(piece) }));
}

// E-2 の返金の DB の言葉 → 記号（refund-store.ts の表）。受け取りと返金の中で E-2 の返金が断ると、この言葉が届く
const REFUND_DB_WORDS = [
  ['ORDER_NOT_FOUND', 'order_not_found'],
  ['ORDER_NOT_REFUNDABLE', 'order_not_refundable'],
  ['ORDER_NOT_CANCELLABLE', 'order_not_cancellable'],
  ['AWAITING_REFUND_EXISTS', 'awaiting_refund_exists'],
  ['REFUND_REQUEST_MISMATCH', 'refund_request_mismatch'],
  ['REFUND_LINE_NOT_IN_ORDER', 'refund_line_not_in_order'],
  ['REFUND_QUANTITY_EXCEEDS_UNSHIPPED', 'quantity_exceeds_unshipped'],
  ['REFUND_QUANTITY_EXCEEDS_SHIPPED', 'quantity_exceeds_shipped'],
  ['REFUND_SHIPPING_EXCEEDS', 'shipping_exceeds'],
  ['REFUND_EXCEEDS_REFUNDABLE', 'exceeds_refundable'],
  ['REFUND_MUST_INCLUDE_UNSHIPPED', 'must_include_unshipped'],
  ['REFUND_MUST_BE_FULL', 'must_be_full'],
  ['REFUND_ARGUMENT_INVALID', 'invalid_argument'],
  ['SETTINGS_ARGUMENT_INVALID', 'invalid_argument'],
] as const satisfies ReadonlyArray<readonly [string, RefundErrorCode]>;

/** DB が word で断った時に、run が ReturnStoreError（記号 code）で止まること */
async function expectRefusal(
  rpcName: string,
  word: string,
  code: string,
  run: (store: ReturnStore) => Promise<unknown>,
): Promise<void> {
  const { store } = storeWith({ [rpcName]: { error: { message: word, code: 'P0001' } } });

  const error = await run(store).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ReturnStoreError);
  expect(error).not.toBeInstanceOf(RefundStoreError);
  expect(error).toMatchObject({ code });
}

// ---- 呼び出しの入力 ----

// 返送料を差し引く送り状（お店の送り状）で、X を返金・Y を交換（在庫から）にする返品。交換の手数料と送料は設定の値（null）
const CREATE_INPUT: CreateReturnInput = {
  orderId: ORDER_ID,
  actorId: ACTOR_ID,
  requestKey: REQUEST_KEY,
  lines: [
    {
      fulfillmentId: FULFILLMENT_ID, orderItemId: ITEM_1, quantity: 1, reason: 'defective', reasonNote: null,
      resolution: 'refund', exchangeVariantId: null, exchangeMethod: null,
    },
    {
      fulfillmentId: FULFILLMENT_ID, orderItemId: ITEM_2, quantity: 2, reason: 'size_too_small', reasonNote: 'タグ付き',
      resolution: 'exchange', exchangeVariantId: 42, exchangeMethod: 'stock',
    },
  ],
  returnMethod: 'shop_label',
  returnShippingPayer: 'customer',
  returnCarrier: 'yamato',
  returnTrackingNumber: 'AB-1234',
  returnShippingFee: 800,
  restockingFeePercent: 10,
  exchangeFee: null,
  exchangeShippingFee: null,
  shopNote: '電話で受付',
  notifyCustomer: true,
};

// 店長が、X を在庫に戻し、Y をお返しし、交換の行は作って送るに変え、計算どおりの額を今返金する受け取り
const RECEIVE_INPUT: ReceiveReturnInput = {
  returnId: RETURN_ID,
  actorId: ACTOR_ID,
  actorCanRefund: true,
  requestKey: REQUEST_KEY,
  units: [
    { returnLineId: LINE_1, disposition: 'restocked', quantity: 1 },
    { returnLineId: LINE_2, disposition: 'sent_back', quantity: 1 },
  ],
  exchangeOverrides: [{ returnLineId: LINE_2, action: 'make' }],
  refundChoice: 'now',
  refundAmount: 2400,
  refundShippingAmount: 0,
  note: '箱が潰れていた',
  notifyCustomer: true,
  sentBackMessage: '着用の跡があるためお返しします',
  sentBackCarrier: 'yamato',
  sentBackTrackingNumber: 'AB-9999',
};

const REFUND_INPUT: RefundReturnInput = {
  returnId: RETURN_ID,
  actorId: ACTOR_ID,
  requestKey: REQUEST_KEY,
  amount: 2400,
  shippingAmount: 500,
  note: '額を相談して決めた',
  notifyCustomer: true,
};

// TS が呼ぶ DB の関数（移行 A・B・C）と、その呼び出し
const CALLS: Array<[rpcName: string, run: (store: ReturnStore) => Promise<unknown>]> = [
  ['admin_create_return', (store) => createReturn(store, CREATE_INPUT)],
  ['admin_receive_return', (store) => receiveReturn(store, RECEIVE_INPUT)],
  ['admin_refund_return', (store) => refundReturn(store, REFUND_INPUT)],
  ['admin_cancel_return', (store) => cancelReturn(store, { returnId: RETURN_ID, actorId: ACTOR_ID })],
  ['admin_close_return_missing', (store) => closeReturnMissing(store, { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY })],
  ['admin_reopen_return', (store) => reopenReturn(store, { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY })],
  [
    'admin_inspect_return',
    (store) =>
      inspectReturn(store, {
        returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY,
        lines: [{ returnLineId: LINE_1, restocked: 1, notRestocked: 1 }],
      }),
  ],
  [
    'admin_record_return_fee_payment',
    (store) => recordReturnFeePayment(store, { returnId: RETURN_ID, actorId: ACTOR_ID, note: '振込', waive: false }),
  ],
  ['admin_release_return_exchange', (store) => releaseReturnExchange(store, { returnId: RETURN_ID, actorId: ACTOR_ID })],
  ['get_order_return_materials', (store) => loadReturnCreateMaterials(store, ORDER_ID)],
  ['list_order_returns', (store) => listOrderReturns(store, ORDER_ID)],
  ['list_order_return_summaries', (store) => listOrderReturnSummaries(store, [ORDER_ID])],
  ['count_order_return_attention', (store) => countReturnAttention(store)],
  ['get_shop_return_settings', (store) => getShopReturnSettings(store)],
  [
    'admin_update_shop_return_settings',
    (store) => updateShopReturnSettings(store, { settings: { restockingFeePercent: 10 }, actorId: ACTOR_ID }),
  ],
];

// 答えの行が1つ要る関数（行が返らなければ、DB の誤りとして止める）。材料は注文が無い時の断りなので別に確かめる
const ROW_REQUIRED_RPCS = [
  'admin_create_return',
  'admin_receive_return',
  'admin_refund_return',
  'admin_cancel_return',
  'admin_close_return_missing',
  'admin_reopen_return',
  'admin_inspect_return',
  'admin_record_return_fee_payment',
  'admin_release_return_exchange',
  'count_order_return_attention',
  'get_shop_return_settings',
  'admin_update_shop_return_settings',
];

describe('toReturnErrorCode', () => {
  it.each(RETURN_ERROR_CODES)('返品の言葉 %s は、同じ綴りの記号', (code) => {
    expect(toReturnErrorCode(code)).toBe(code);
    // PostgREST は言葉の前後に別の文を足すことがある
    expect(toReturnErrorCode(`error: ${code} (detail)`)).toBe(code);
  });

  it.each(REFUND_DB_WORDS)('E-2 の言葉 %s は、E-2 の記号 %s のまま渡す', (word, code) => {
    expect(toReturnErrorCode(word)).toBe(code);
    expect(toReturnErrorCode(`error: ${word} (detail)`)).toBe(code);
  });

  it('注文の番号を200件より多く渡した断り（TOO_MANY_ORDERS）は、C-4 にも E-2 にも記号が無いので RETURN_ARGUMENT_INVALID', () => {
    expect(toReturnErrorCode('TOO_MANY_ORDERS')).toBe('RETURN_ARGUMENT_INVALID');
    expect(toReturnErrorCode('error: TOO_MANY_ORDERS (detail)')).toBe('RETURN_ARGUMENT_INVALID');
  });

  it('どの言葉も、別の言葉の一部になっていない（部分一致で記号を決めるため。綴りが足されて重なると、記号を取り違える）', () => {
    const words: string[] = [...RETURN_ERROR_CODES, 'TOO_MANY_ORDERS', ...REFUND_DB_WORDS.map(([word]) => word)];
    const overlaps = words.flatMap((word) =>
      words.filter((other) => other !== word && other.includes(word)).map((other) => `${word} は ${other} の一部`),
    );

    expect(overlaps).toEqual([]);
  });

  it('返品の言葉と E-2 の言葉が両方入った文は、返品の言葉の記号になる', () => {
    expect(toReturnErrorCode('RETURN_STATE_CONFLICT / ORDER_NOT_FOUND')).toBe('RETURN_STATE_CONFLICT');
    expect(toReturnErrorCode('ORDER_NOT_FOUND / RETURN_STATE_CONFLICT')).toBe('RETURN_STATE_CONFLICT');
  });

  it('表に無い言葉・空・undefined は null', () => {
    expect(toReturnErrorCode('RETURN_UNKNOWN_WORD')).toBeNull();
    expect(toReturnErrorCode('connection refused')).toBeNull();
    expect(toReturnErrorCode('')).toBeNull();
    expect(toReturnErrorCode(undefined)).toBeNull();
  });
});

describe('移行 A・B・C との突き合わせ（Task 1〜3 の移行がある前提。無ければこの describe だけ FAIL する）', () => {
  it('DB の関数が止める返品の言葉は、移行の本文にある（綴りが食い違うと、画面に出る言葉が変わる）', () => {
    const sql = returnMigrationsText();

    for (const code of RETURN_ERROR_CODES) {
      expect(sql).toContain(code);
    }
  });

  it('返品の言葉のほかに store が記号に直す DB の言葉（TOO_MANY_ORDERS・ORDER_NOT_FOUND・SETTINGS_ARGUMENT_INVALID）も、移行の本文にある', () => {
    const sql = returnMigrationsText();

    for (const word of ['TOO_MANY_ORDERS', 'ORDER_NOT_FOUND', 'SETTINGS_ARGUMENT_INVALID']) {
      expect(sql).toContain(word);
    }
  });

  it('TS が呼ぶ DB の関数は、移行の本文にある（名前が食い違うと、呼んだ時に初めて分かる）', () => {
    const sql = returnMigrationsText();

    for (const [rpcName] of CALLS) {
      expect(sql).toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${rpcName}\\s*\\(`));
    }
  });

  it.each(CALLS)('%s に渡す引数の名前は、移行の関数の引数と一字も違わない（食い違うと PostgREST が関数を見つけられない）', async (rpcName, run) => {
    const { store, rpc } = storeWith({});

    await run(store).catch(() => undefined);

    expect(rpc).toHaveBeenCalledTimes(1);
    const [calledName, args] = rpc.mock.calls[0];
    expect(calledName).toBe(rpcName);
    const declared = declaredParams(returnMigrationsText(), rpcName);
    const passed = Object.keys(args ?? {});
    // 渡した引数が関数に無い、または、省略できない引数を渡していない
    expect(passed.filter((name) => !declared.some((param) => param.name === name))).toEqual([]);
    expect(declared.filter((param) => !param.optional && !passed.includes(param.name)).map((param) => param.name)).toEqual([]);
  });

  it('手数料の受け取りの記録の関数は、C-1 のとおり引数に _waive（いただかないで終える）を持つ。P27', () => {
    const declared = declaredParams(returnMigrationsText(), 'admin_record_return_fee_payment');

    expect(declared.map((param) => param.name).sort()).toEqual(['_actor_id', '_note', '_return_id', '_waive']);
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
    await expectRefusal(rpcName, 'RETURN_STATE_CONFLICT', 'RETURN_STATE_CONFLICT', run);
  });

  it('DB が E-2 の言葉で断れば、E-2 の記号のまま ReturnStoreError に載せる（RefundOperationError にしない）', async () => {
    await expectRefusal(rpcName, 'AWAITING_REFUND_EXISTS', 'awaiting_refund_exists', run);
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

describe('createReturn', () => {
  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す。手数料は null のまま渡す（DB がショップの設定の値を入れる）', async () => {
    const { store, rpc } = storeWith({
      admin_create_return: { data: [{ return_id: RETURN_ID, number: 2, status: 'open', replayed: false }] },
    });

    await expect(createReturn(store, CREATE_INPUT)).resolves.toEqual({
      returnId: RETURN_ID, number: 2, status: 'open', replayed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_create_return', {
      _order_id: ORDER_ID,
      _actor_id: ACTOR_ID,
      _request_key: REQUEST_KEY,
      _lines: [
        {
          fulfillment_id: FULFILLMENT_ID, order_item_id: ITEM_1, quantity: 1, reason: 'defective', reason_note: null,
          resolution: 'refund', exchange_variant_id: null, exchange_method: null,
        },
        {
          fulfillment_id: FULFILLMENT_ID, order_item_id: ITEM_2, quantity: 2, reason: 'size_too_small', reason_note: 'タグ付き',
          resolution: 'exchange', exchange_variant_id: 42, exchange_method: 'stock',
        },
      ],
      _return_method: 'shop_label',
      _return_shipping_payer: 'customer',
      _return_carrier: 'yamato',
      _return_tracking_number: 'AB-1234',
      _return_shipping_fee: 800,
      _restocking_fee_percent: 10,
      _exchange_fee: null,
      _exchange_shipping_fee: null,
      _shop_note: '電話で受付',
      _notify_customer: true,
    });
  });

  it('同じ二重防止の番号の送り直しは、前の結果をそのまま返す（replayed が true）。行が1つのオブジェクトで来ても読める', async () => {
    const { store } = storeWith({
      admin_create_return: { data: { return_id: RETURN_ID, number: 1, status: 'closed', replayed: true } },
    });

    await expect(createReturn(store, CREATE_INPUT)).resolves.toEqual({
      returnId: RETURN_ID, number: 1, status: 'closed', replayed: true,
    });
  });

  it.each([
    'RETURN_ARGUMENT_INVALID',
    'RETURN_QUANTITY_EXCEEDS',
    'RETURN_EXCHANGE_VARIANT_INVALID',
    'RETURN_ADDRESS_REQUIRED',
    'RETURN_REASON_NOTE_REQUIRED',
    'RETURN_FEE_INVALID',
    'RETURN_REQUEST_MISMATCH',
    'ORDER_NOT_RETURNABLE',
  ] as const)('DB が %s で断れば、同じ綴りの記号', async (word) => {
    await expectRefusal('admin_create_return', word, word, (store) => createReturn(store, CREATE_INPUT));
  });

  it('注文が無い断り（E-2 の言葉 ORDER_NOT_FOUND）は E-2 の記号 order_not_found', async () => {
    await expectRefusal('admin_create_return', 'ORDER_NOT_FOUND', 'order_not_found', (store) => createReturn(store, CREATE_INPUT));
  });
});

describe('receiveReturn', () => {
  const RECEIVED_ROW = {
    receipt_id: RECEIPT_ID, return_status: 'open', refund_id: REFUND_ID, refund_amount: 2400, refund_status: 'awaiting_response',
    exchange_order_item_ids: [EXCHANGE_ITEM_ID], fee_due_amount: 0, shop_notice_enqueued: false, replayed: false,
  };

  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す', async () => {
    const { store, rpc } = storeWith({ admin_receive_return: { data: [RECEIVED_ROW] } });

    await expect(receiveReturn(store, RECEIVE_INPUT)).resolves.toEqual({
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refundId: REFUND_ID,
      refundAmount: 2400,
      refundStatus: 'awaiting_response',
      exchangeOrderItemIds: [EXCHANGE_ITEM_ID],
      feeDueAmount: 0,
      shopNoticeEnqueued: false,
      replayed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_receive_return', {
      _return_id: RETURN_ID,
      _actor_id: ACTOR_ID,
      _actor_can_refund: true,
      _request_key: REQUEST_KEY,
      _units: [
        { return_line_id: LINE_1, disposition: 'restocked', quantity: 1 },
        { return_line_id: LINE_2, disposition: 'sent_back', quantity: 1 },
      ],
      _exchange_overrides: [{ return_line_id: LINE_2, action: 'make' }],
      _refund_choice: 'now',
      _refund_amount: 2400,
      _refund_shipping_amount: 0,
      _note: '箱が潰れていた',
      _notify_customer: true,
      _sent_back_message: '着用の跡があるためお返しします',
      _sent_back_carrier: 'yamato',
      _sent_back_tracking_number: 'AB-9999',
    });
  });

  it('返金の無い受け取りは、返金の番号・額・状態が null、交換の品の行が無ければ空の配列。お支払い待ちの額と店への知らせを写す', async () => {
    const { store } = storeWith({
      admin_receive_return: {
        data: [{
          receipt_id: RECEIPT_ID, return_status: 'open', refund_id: null, refund_amount: null, refund_status: null,
          exchange_order_item_ids: null, fee_due_amount: 1600, shop_notice_enqueued: true, replayed: false,
        }],
      },
    });

    await expect(
      receiveReturn(store, { ...RECEIVE_INPUT, actorCanRefund: false, refundChoice: 'consult', refundAmount: null }),
    ).resolves.toEqual({
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refundId: null,
      refundAmount: null,
      refundStatus: null,
      exchangeOrderItemIds: [],
      feeDueAmount: 1600,
      shopNoticeEnqueued: true,
      replayed: false,
    });
  });

  it('返金額が0円になる受け取り（手数料が商品の額以上など。P20）は、返金の番号が null・状態が waived。返金の記録は作られず、お支払い待ちの額が残る', async () => {
    const { store, rpc } = storeWith({
      admin_receive_return: {
        data: [{
          receipt_id: RECEIPT_ID, return_status: 'open', refund_id: null, refund_amount: 0, refund_status: 'waived',
          exchange_order_item_ids: [], fee_due_amount: 88, shop_notice_enqueued: false, replayed: false,
        }],
      },
    });

    await expect(receiveReturn(store, { ...RECEIVE_INPUT, refundAmount: 0 })).resolves.toEqual({
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refundId: null,
      refundAmount: 0,
      refundStatus: 'waived',
      exchangeOrderItemIds: [],
      feeDueAmount: 88,
      shopNoticeEnqueued: false,
      replayed: false,
    });
    // 店長が額を0に直した時は、計算どおり（null）ではなく 0 を渡す
    expect(rpc).toHaveBeenCalledWith('admin_receive_return', expect.objectContaining({ _refund_amount: 0 }));
  });

  it('同じ二重防止の番号の送り直しは、前の受け取りと返金の記録をそのまま返す（replayed が true。Review Focus 1）', async () => {
    const { store } = storeWith({ admin_receive_return: { data: [{ ...RECEIVED_ROW, replayed: true, refund_status: 'pending' }] } });

    await expect(receiveReturn(store, RECEIVE_INPUT)).resolves.toMatchObject({
      receiptId: RECEIPT_ID, refundId: REFUND_ID, refundStatus: 'pending', replayed: true,
    });
  });

  it('サポートの受け取り（actorCanRefund が false）は、そのまま DB に渡す。権限そのものは窓口が確かめる', async () => {
    const { store, rpc } = storeWith({ admin_receive_return: { data: [RECEIVED_ROW] } });

    await receiveReturn(store, { ...RECEIVE_INPUT, actorCanRefund: false, refundChoice: 'consult' });

    expect(rpc).toHaveBeenCalledWith(
      'admin_receive_return',
      expect.objectContaining({ _actor_can_refund: false, _refund_choice: 'consult' }),
    );
  });

  it.each([
    'RETURN_NOT_FOUND',
    'RETURN_STATE_CONFLICT',
    'RETURN_RECEIPT_EXCEEDS',
    'RETURN_EXCHANGE_OUT_OF_STOCK',
    'RETURN_FORBIDDEN',
    'RETURN_REFUND_AMOUNT_INVALID',
    'RETURN_SENT_BACK_MESSAGE_REQUIRED',
    'RETURN_REQUEST_MISMATCH',
  ] as const)('DB が %s で断れば、同じ綴りの記号', async (word) => {
    await expectRefusal('admin_receive_return', word, word, (store) => receiveReturn(store, RECEIVE_INPUT));
  });

  it.each(REFUND_DB_WORDS)('受け取りの中で E-2 の返金が %s で断れば、E-2 の記号 %s のまま渡す（確かめ中の返金がある時など）', async (word, code) => {
    await expectRefusal('admin_receive_return', word, code, (store) => receiveReturn(store, RECEIVE_INPUT));
  });
});

describe('refundReturn', () => {
  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す', async () => {
    const { store, rpc } = storeWith({
      admin_refund_return: { data: [{ refund_id: REFUND_ID, amount: 2900, status: 'awaiting_response', replayed: false }] },
    });

    await expect(refundReturn(store, REFUND_INPUT)).resolves.toEqual({
      refundId: REFUND_ID, amount: 2900, status: 'awaiting_response', replayed: false,
    });

    expect(rpc).toHaveBeenCalledWith('admin_refund_return', {
      _return_id: RETURN_ID,
      _actor_id: ACTOR_ID,
      _request_key: REQUEST_KEY,
      _amount: 2400,
      _shipping_amount: 500,
      _note: '額を相談して決めた',
      _notify_customer: true,
    });
  });

  it('額を0にして渡すと、返金しないで終える。返金の記録は無いので、返金の番号が null・状態が waived（P20）。送り直しも同じ答え', async () => {
    const first = storeWith({ admin_refund_return: { data: [{ refund_id: null, amount: 0, status: 'waived', replayed: false }] } });

    await expect(refundReturn(first.store, { ...REFUND_INPUT, amount: 0, shippingAmount: 0 })).resolves.toEqual({
      refundId: null, amount: 0, status: 'waived', replayed: false,
    });
    expect(first.rpc).toHaveBeenCalledWith('admin_refund_return', expect.objectContaining({ _amount: 0, _shipping_amount: 0 }));

    const again = storeWith({ admin_refund_return: { data: [{ refund_id: null, amount: 0, status: 'waived', replayed: true }] } });
    await expect(refundReturn(again.store, { ...REFUND_INPUT, amount: 0, shippingAmount: 0 })).resolves.toEqual({
      refundId: null, amount: 0, status: 'waived', replayed: true,
    });
  });

  it('額を決めない（計算どおり）時は null を渡す。同じ番号の送り直しは前の返金の記録をそのまま返す', async () => {
    const { store, rpc } = storeWith({
      admin_refund_return: { data: [{ refund_id: REFUND_ID, amount: 2666, status: 'pending', replayed: true }] },
    });

    await expect(refundReturn(store, { ...REFUND_INPUT, amount: null, shippingAmount: 0 })).resolves.toEqual({
      refundId: REFUND_ID, amount: 2666, status: 'pending', replayed: true,
    });
    expect(rpc).toHaveBeenCalledWith('admin_refund_return', expect.objectContaining({ _amount: null, _shipping_amount: 0 }));
  });

  it.each([
    'RETURN_NOT_FOUND',
    'RETURN_STATE_CONFLICT',
    'RETURN_FORBIDDEN',
    'RETURN_NOTHING_TO_REFUND',
    'RETURN_REFUND_AMOUNT_INVALID',
    'RETURN_REQUEST_MISMATCH',
  ] as const)('DB が %s で断れば、同じ綴りの記号', async (word) => {
    await expectRefusal('admin_refund_return', word, word, (store) => refundReturn(store, REFUND_INPUT));
  });

  it.each(REFUND_DB_WORDS)('E-2 の返金が %s で断れば、E-2 の記号 %s のまま渡す', async (word, code) => {
    await expectRefusal('admin_refund_return', word, code, (store) => refundReturn(store, REFUND_INPUT));
  });
});

describe('取消・開き直し・届かないで終える・検品・手数料の記録・支払いを待たずに送る', () => {
  it('cancelReturn: 返品と実行した人を渡し、返品の番号と状態を返す', async () => {
    const { store, rpc } = storeWith({ admin_cancel_return: { data: [{ return_id: RETURN_ID, status: 'cancelled' }] } });

    await expect(cancelReturn(store, { returnId: RETURN_ID, actorId: ACTOR_ID })).resolves.toEqual({
      returnId: RETURN_ID, status: 'cancelled',
    });
    expect(rpc).toHaveBeenCalledWith('admin_cancel_return', { _return_id: RETURN_ID, _actor_id: ACTOR_ID });
  });

  it('closeReturnMissing・reopenReturn: 二重防止の番号を渡し、受け取りの記録の番号と返品の状態と replayed を返す', async () => {
    const closed = storeWith({
      admin_close_return_missing: { data: [{ receipt_id: RECEIPT_ID, return_status: 'closed', replayed: false }] },
    });
    await expect(closeReturnMissing(closed.store, { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY })).resolves.toEqual({
      receiptId: RECEIPT_ID, returnStatus: 'closed', replayed: false,
    });
    expect(closed.rpc).toHaveBeenCalledWith('admin_close_return_missing', {
      _return_id: RETURN_ID, _actor_id: ACTOR_ID, _request_key: REQUEST_KEY,
    });

    const reopened = storeWith({
      admin_reopen_return: { data: [{ receipt_id: RECEIPT_ID, return_status: 'open', replayed: true }] },
    });
    await expect(reopenReturn(reopened.store, { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY })).resolves.toEqual({
      receiptId: RECEIPT_ID, returnStatus: 'open', replayed: true,
    });
    expect(reopened.rpc).toHaveBeenCalledWith('admin_reopen_return', {
      _return_id: RETURN_ID, _actor_id: ACTOR_ID, _request_key: REQUEST_KEY,
    });
  });

  it('inspectReturn: 品ごとの在庫に戻す数・戻さない数を渡す', async () => {
    const { store, rpc } = storeWith({
      admin_inspect_return: { data: [{ receipt_id: RECEIPT_ID, return_status: 'closed', replayed: false }] },
    });

    await expect(
      inspectReturn(store, {
        returnId: RETURN_ID,
        actorId: ACTOR_ID,
        requestKey: REQUEST_KEY,
        lines: [{ returnLineId: LINE_1, restocked: 1, notRestocked: 1 }, { returnLineId: LINE_2, restocked: 0, notRestocked: 2 }],
      }),
    ).resolves.toEqual({ receiptId: RECEIPT_ID, returnStatus: 'closed', replayed: false });

    expect(rpc).toHaveBeenCalledWith('admin_inspect_return', {
      _return_id: RETURN_ID,
      _actor_id: ACTOR_ID,
      _request_key: REQUEST_KEY,
      _lines: [
        { return_line_id: LINE_1, restocked: 1, not_restocked: 1 },
        { return_line_id: LINE_2, restocked: 0, not_restocked: 2 },
      ],
    });
  });

  it('recordReturnFeePayment・releaseReturnExchange: 返品の番号と状態を返す。メモは無くてもよい（null）。受け取りの記録（waive が偽）は _waive を偽で渡す', async () => {
    const paid = storeWith({
      admin_record_return_fee_payment: { data: [{ return_id: RETURN_ID, return_status: 'closed' }] },
    });
    await expect(
      recordReturnFeePayment(paid.store, { returnId: RETURN_ID, actorId: ACTOR_ID, note: null, waive: false }),
    ).resolves.toEqual({ returnId: RETURN_ID, returnStatus: 'closed' });
    expect(paid.rpc).toHaveBeenCalledWith('admin_record_return_fee_payment', {
      _return_id: RETURN_ID, _actor_id: ACTOR_ID, _note: null, _waive: false,
    });

    const released = storeWith({
      admin_release_return_exchange: { data: [{ return_id: RETURN_ID, return_status: 'open' }] },
    });
    await expect(releaseReturnExchange(released.store, { returnId: RETURN_ID, actorId: ACTOR_ID })).resolves.toEqual({
      returnId: RETURN_ID, returnStatus: 'open',
    });
    expect(released.rpc).toHaveBeenCalledWith('admin_release_return_exchange', { _return_id: RETURN_ID, _actor_id: ACTOR_ID });
  });

  it('recordReturnFeePayment: waive が真なら「いただかないで終える」。_waive を真のまま渡し、答えの形は受け取りの記録と同じ（P27）', async () => {
    const { store, rpc } = storeWith({
      admin_record_return_fee_payment: { data: [{ return_id: RETURN_ID, return_status: 'closed' }] },
    });

    await expect(
      recordReturnFeePayment(store, { returnId: RETURN_ID, actorId: ACTOR_ID, note: '常連のお客様のため', waive: true }),
    ).resolves.toEqual({ returnId: RETURN_ID, returnStatus: 'closed' });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_record_return_fee_payment', {
      _return_id: RETURN_ID, _actor_id: ACTOR_ID, _note: '常連のお客様のため', _waive: true,
    });
  });

  it.each([
    ['admin_cancel_return', 'RETURN_STATE_CONFLICT', (store: ReturnStore) => cancelReturn(store, { returnId: RETURN_ID, actorId: ACTOR_ID })],
    ['admin_reopen_return', 'RETURN_STATE_CONFLICT', (store: ReturnStore) => reopenReturn(store, { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY })],
    ['admin_close_return_missing', 'RETURN_REQUEST_MISMATCH', (store: ReturnStore) => closeReturnMissing(store, { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY })],
    ['admin_record_return_fee_payment', 'RETURN_FORBIDDEN', (store: ReturnStore) => recordReturnFeePayment(store, { returnId: RETURN_ID, actorId: ACTOR_ID, note: null, waive: false })],
    ['admin_release_return_exchange', 'RETURN_NOT_FOUND', (store: ReturnStore) => releaseReturnExchange(store, { returnId: RETURN_ID, actorId: ACTOR_ID })],
  ])('%s は DB が %s で断れば、同じ綴りの記号', async (rpcName, word, run) => {
    await expectRefusal(rpcName, word, word, run);
  });
});

// ---- 読み出しの答えの変換 ----

const REASON_SHIPPING_PAYERS = {
  defective: 'shop', wrong_item: 'shop', size_too_small: 'customer', size_too_large: 'customer', color: 'customer',
  style: 'customer', not_as_described: 'customer', unwanted: 'customer', other: 'customer', unknown: 'customer',
} as const;
const REASON_OUT_OF_STOCK_EXCHANGE = {
  defective: 'make', wrong_item: 'make', size_too_small: 'decline', size_too_large: 'decline', color: 'decline',
  style: 'decline', not_as_described: 'decline', unwanted: 'decline', other: 'decline', unknown: 'decline',
} as const;

// get_order_return_materials の答え（jsonb。共通の約束 C-2 の型のキーを snake_case にした形）
const MATERIALS_JSON = {
  order: { id: ORDER_ID, status: 'shipped', has_awaiting_refund: false },
  shipments: [
    {
      fulfillment_id: FULFILLMENT_ID, number: 1, shipped_at: '2026-10-10T01:00:00+00:00', deadline_date: '2026-10-20', past_deadline: false,
      lines: [
        {
          order_item_id: ITEM_1, item_id: 12, variant_id: 101, item_name: 'シルクブラウス', color: '白', size: 'M',
          line_kind: 'order', quantity: 2, returnable: 2,
        },
        {
          order_item_id: EXCHANGE_ITEM_ID, item_id: 13, variant_id: null, item_name: 'リネンパンツ', color: null, size: null,
          line_kind: 'exchange', quantity: 1, returnable: 0,
        },
      ],
    },
    { fulfillment_id: '02b2c3d4-1111-4222-8333-444455556666', number: 2, shipped_at: '2026-09-01T01:00:00+00:00', deadline_date: null, past_deadline: true, lines: [] },
  ],
  exchange_options: [
    {
      item_id: 12,
      variants: [
        { variant_id: 101, color: '白', size: 'M', is_active: true, stock_quantity: 0, made_to_order_lead_days: 14 },
        { variant_id: 102, color: '白', size: 'L', is_active: false, stock_quantity: 3, made_to_order_lead_days: null },
      ],
    },
  ],
  settings: {
    return_address_set: true, no_return_needed_enabled: false, customer_paid_method: 'shop_label', shop_label_fee: 800,
    restocking_fee_enabled: true, restocking_fee_percent: 10, exchange_fees_enabled: true, exchange_fee: 500, exchange_shipping_fee: 300,
    reason_shipping_payers: REASON_SHIPPING_PAYERS, reason_out_of_stock_exchange: REASON_OUT_OF_STOCK_EXCHANGE,
  },
};
const MATERIALS = {
  order: { id: ORDER_ID, status: 'shipped', hasAwaitingRefund: false },
  shipments: [
    {
      fulfillmentId: FULFILLMENT_ID, number: 1, shippedAt: '2026-10-10T01:00:00+00:00', deadlineDate: '2026-10-20', pastDeadline: false,
      lines: [
        {
          orderItemId: ITEM_1, itemId: 12, variantId: 101, itemName: 'シルクブラウス', color: '白', size: 'M',
          lineKind: 'order', quantity: 2, returnable: 2,
        },
        {
          orderItemId: EXCHANGE_ITEM_ID, itemId: 13, variantId: null, itemName: 'リネンパンツ', color: null, size: null,
          lineKind: 'exchange', quantity: 1, returnable: 0,
        },
      ],
    },
    { fulfillmentId: '02b2c3d4-1111-4222-8333-444455556666', number: 2, shippedAt: '2026-09-01T01:00:00+00:00', deadlineDate: null, pastDeadline: true, lines: [] },
  ],
  exchangeOptions: [
    {
      itemId: 12,
      variants: [
        { variantId: 101, color: '白', size: 'M', isActive: true, stockQuantity: 0, madeToOrderLeadDays: 14 },
        { variantId: 102, color: '白', size: 'L', isActive: false, stockQuantity: 3, madeToOrderLeadDays: null },
      ],
    },
  ],
  settings: {
    returnAddressSet: true, noReturnNeededEnabled: false, customerPaidMethod: 'shop_label', shopLabelFee: 800,
    restockingFeeEnabled: true, restockingFeePercent: 10, exchangeFeesEnabled: true, exchangeFee: 500, exchangeShippingFee: 300,
    reasonShippingPayers: REASON_SHIPPING_PAYERS, reasonOutOfStockExchange: REASON_OUT_OF_STOCK_EXCHANGE,
  },
};

describe('loadReturnCreateMaterials', () => {
  it('作る画面の材料を、キーを camelCase にして返す。理由ごとの設定の表のキー（理由の記号）は直さない', async () => {
    const { store, rpc } = storeWith({ get_order_return_materials: { data: MATERIALS_JSON } });

    await expect(loadReturnCreateMaterials(store, ORDER_ID)).resolves.toEqual(MATERIALS);

    expect(rpc).toHaveBeenCalledWith('get_order_return_materials', { _order_id: ORDER_ID });
  });

  it('jsonb が配列に包まれて来ても読める', async () => {
    const { store } = storeWith({ get_order_return_materials: { data: [MATERIALS_JSON] } });

    await expect(loadReturnCreateMaterials(store, ORDER_ID)).resolves.toEqual(MATERIALS);
  });

  it('注文が無い時（答えが null か空）は、E-2 の記号 order_not_found の ReturnStoreError', async () => {
    for (const data of [null, []]) {
      const { store } = storeWith({ get_order_return_materials: { data } });

      const error = await loadReturnCreateMaterials(store, ORDER_ID).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ReturnStoreError);
      expect(error).toMatchObject({ code: 'order_not_found' });
    }
  });
});

// list_order_returns の答えの1件目: 返金の行（3点中2点を受け取り済み。うち1点は返金しないことにした）と、
// 交換（作って送る）の行を持つ受付中の返品（共通の約束 C-2 の OrderReturnDetail のキーを snake_case にした形。label は無い）
const RETURN_JSON = {
  id: RETURN_ID, number: 2, status: 'open', source: 'shop', display_status: 'in_progress', marks: ['partially_received', 'awaiting_fee'],
  return_method: 'shop_label', return_shipping_payer: 'customer', return_carrier: 'yamato', return_tracking_number: 'AB-1234',
  fees: {
    return_shipping_fee: 800, restocking_fee_percent: 10, exchange_fee: 500, exchange_shipping_fee: 300, fee_due_amount: 1600,
    fee_pending_deduction: 266, fee_received_at: null, exchange_released_at: '2026-10-12T05:00:00+00:00',
  },
  first_receipt_done: true, first_exchange_receipt_done: false,
  shop_note: '電話で受付', notify_customer: true, created_at: '2026-10-12T01:00:00+00:00', created_by_email: 'owner@example.com',
  closed_at: null, cancelled_at: null,
  lines: [
    {
      id: LINE_1, fulfillment_id: FULFILLMENT_ID, fulfillment_number: 1, order_item_id: ITEM_1, item_name: 'シルクブラウス', color: '白', size: 'M',
      quantity: 3, reason: 'defective', reason_note: null, resolution: 'refund', exchange: null,
      progress: {
        restocked: 1, not_restocked: 1, pending_inspection: 0, sent_back: 0, missing: 0, processed: 2, unprocessed: 1,
        exchanged: 0, refund_covered: 0, refund_waived: 1, refund_waiting: 1,
      },
      refund_amounts_by_count: [2666], refund_waiting_amount: 2666,
    },
    {
      id: LINE_2, fulfillment_id: FULFILLMENT_ID, fulfillment_number: 1, order_item_id: ITEM_2, item_name: 'リネンパンツ', color: null, size: null,
      quantity: 1, reason: 'size_too_small', reason_note: 'タグ付き', resolution: 'exchange',
      exchange: { variant_id: 202, color: '黒', size: 'L', method: 'make', stock_quantity: 0, made_to_order_lead_days: 14, out_of_stock_exchange: 'make' },
      progress: {
        restocked: 1, not_restocked: 0, pending_inspection: 0, sent_back: 0, missing: 0, processed: 1, unprocessed: 0,
        exchanged: 1, refund_covered: 0, refund_waived: 0, refund_waiting: 0,
      },
      refund_amounts_by_count: [], refund_waiting_amount: 0,
    },
  ],
  refunds: [{ id: REFUND_ID, amount: 2666, status: 'pending', created_at: '2026-10-12T02:00:00+00:00' }],
  receipts: [
    { id: RECEIPT_ID, kind: 'receive', refund_choice: 'consult', created_at: '2026-10-12T02:00:00+00:00', actor_email: 'support@example.com' },
    { id: '41b2c3d4-1111-4222-8333-444455556666', kind: 'close_missing', refund_choice: null, created_at: '2026-10-12T03:00:00+00:00', actor_email: null },
    { id: '42b2c3d4-1111-4222-8333-444455556666', kind: 'waive_refund', refund_choice: null, created_at: '2026-10-12T04:00:00+00:00', actor_email: 'owner@example.com' },
  ],
  exchange_items: [
    { order_item_id: EXCHANGE_ITEM_ID, item_name: 'リネンパンツ', color: '黒', size: 'L', quantity: 1, fulfillment_type: 'backorder', shipped: 0 },
  ],
};
const RETURN = {
  id: RETURN_ID, number: 2, label: 'ORD-A1B2C3D4-R2', status: 'open', source: 'shop', displayStatus: 'in_progress',
  marks: ['partially_received', 'awaiting_fee'],
  returnMethod: 'shop_label', returnShippingPayer: 'customer', returnCarrier: 'yamato', returnTrackingNumber: 'AB-1234',
  fees: {
    returnShippingFee: 800, restockingFeePercent: 10, exchangeFee: 500, exchangeShippingFee: 300, feeDueAmount: 1600,
    feePendingDeduction: 266, feeReceivedAt: null, exchangeReleasedAt: '2026-10-12T05:00:00+00:00',
  },
  firstReceiptDone: true, firstExchangeReceiptDone: false,
  shopNote: '電話で受付', notifyCustomer: true, createdAt: '2026-10-12T01:00:00+00:00', createdByEmail: 'owner@example.com',
  closedAt: null, cancelledAt: null,
  lines: [
    {
      id: LINE_1, fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 1, orderItemId: ITEM_1, itemName: 'シルクブラウス', color: '白', size: 'M',
      quantity: 3, reason: 'defective', reasonNote: null, resolution: 'refund', exchange: null,
      progress: {
        restocked: 1, notRestocked: 1, pendingInspection: 0, sentBack: 0, missing: 0, processed: 2, unprocessed: 1,
        exchanged: 0, refundCovered: 0, refundWaived: 1, refundWaiting: 1,
      },
      refundAmountsByCount: [2666], refundWaitingAmount: 2666,
    },
    {
      id: LINE_2, fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 1, orderItemId: ITEM_2, itemName: 'リネンパンツ', color: null, size: null,
      quantity: 1, reason: 'size_too_small', reasonNote: 'タグ付き', resolution: 'exchange',
      exchange: { variantId: 202, color: '黒', size: 'L', method: 'make', stockQuantity: 0, madeToOrderLeadDays: 14, outOfStockExchange: 'make' },
      progress: {
        restocked: 1, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0, processed: 1, unprocessed: 0,
        exchanged: 1, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
      },
      refundAmountsByCount: [], refundWaitingAmount: 0,
    },
  ],
  refunds: [{ id: REFUND_ID, amount: 2666, status: 'pending', createdAt: '2026-10-12T02:00:00+00:00' }],
  receipts: [
    { id: RECEIPT_ID, kind: 'receive', refundChoice: 'consult', createdAt: '2026-10-12T02:00:00+00:00', actorEmail: 'support@example.com' },
    { id: '41b2c3d4-1111-4222-8333-444455556666', kind: 'close_missing', refundChoice: null, createdAt: '2026-10-12T03:00:00+00:00', actorEmail: null },
    { id: '42b2c3d4-1111-4222-8333-444455556666', kind: 'waive_refund', refundChoice: null, createdAt: '2026-10-12T04:00:00+00:00', actorEmail: 'owner@example.com' },
  ],
  exchangeItems: [
    { orderItemId: EXCHANGE_ITEM_ID, itemName: 'リネンパンツ', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder', shipped: 0 },
  ],
};

// 取り消した返品（お客様の申し込みの形。行も記録も無く、状態の印も無い）
const CANCELLED_JSON = {
  id: '51b2c3d4-1111-4222-8333-444455556666', number: 1, status: 'cancelled', source: 'customer_request', display_status: null, marks: [],
  return_method: 'not_required', return_shipping_payer: 'shop', return_carrier: null, return_tracking_number: null,
  fees: {
    return_shipping_fee: 0, restocking_fee_percent: 0, exchange_fee: 0, exchange_shipping_fee: 0, fee_due_amount: 0,
    fee_pending_deduction: 0, fee_received_at: null, exchange_released_at: null,
  },
  first_receipt_done: false, first_exchange_receipt_done: false,
  shop_note: null, notify_customer: false, created_at: '2026-10-11T01:00:00+00:00', created_by_email: null,
  closed_at: null, cancelled_at: '2026-10-11T02:00:00+00:00',
  lines: null, refunds: null, receipts: null, exchange_items: null,
};

describe('listOrderReturns', () => {
  it('返品の一覧を窓口の形に直す。キーは camelCase、番号の文字（label）は注文の番号と返品の番号から付ける', async () => {
    const { store, rpc } = storeWith({ list_order_returns: { data: [RETURN_JSON] } });

    await expect(listOrderReturns(store, ORDER_ID)).resolves.toEqual([RETURN]);

    expect(rpc).toHaveBeenCalledWith('list_order_returns', { _order_id: ORDER_ID });
  });

  it('交換の予定の行にも、返金の行と同じ形の額の列（refund_amounts_by_count）が入る。受け取りで「返金に変える」時の見込みに使う', async () => {
    const [refundLine, exchangeLine] = RETURN_JSON.lines;
    const pendingExchange = {
      ...exchangeLine,
      quantity: 2,
      progress: { ...exchangeLine.progress, restocked: 0, processed: 0, unprocessed: 2, exchanged: 0 },
      refund_amounts_by_count: [4000, 8000],
    };
    const { store } = storeWith({ list_order_returns: { data: [{ ...RETURN_JSON, lines: [refundLine, pendingExchange] }] } });

    const [detail] = await listOrderReturns(store, ORDER_ID);

    expect(detail.lines[0]).toMatchObject({ resolution: 'refund', refundAmountsByCount: [2666] });
    expect(detail.lines[1]).toMatchObject({ resolution: 'exchange', refundAmountsByCount: [4000, 8000] });
  });

  it('取消・お断りの返品も読める。行・返金・受け取り・交換の品が null でも空の配列にし、状態の印は null・[]', async () => {
    const { store } = storeWith({ list_order_returns: { data: [CANCELLED_JSON] } });

    const [cancelled] = await listOrderReturns(store, ORDER_ID);

    expect(cancelled).toMatchObject({
      number: 1, label: 'ORD-A1B2C3D4-R1', status: 'cancelled', source: 'customer_request', displayStatus: null, marks: [],
      returnMethod: 'not_required', returnCarrier: null, returnTrackingNumber: null, shopNote: null, createdByEmail: null,
      cancelledAt: '2026-10-11T02:00:00+00:00', lines: [], refunds: [], receipts: [], exchangeItems: [],
    });
  });

  it('返品が無ければ空の配列。表に無い状態の記号・小さな印は捨てる（画面が言葉の表を引いて undefined にならない）', async () => {
    const empty = storeWith({ list_order_returns: { data: null } });
    await expect(listOrderReturns(empty.store, ORDER_ID)).resolves.toEqual([]);

    const weird = storeWith({ list_order_returns: { data: [{ ...RETURN_JSON, display_status: 'weird', marks: ['awaiting_items', 'weird'] }] } });
    const [detail] = await listOrderReturns(weird.store, ORDER_ID);

    expect(detail).toMatchObject({ displayStatus: null, marks: ['awaiting_items'] });
  });
});

describe('listOrderReturnSummaries', () => {
  const summaryRow = (orderId: string, overrides: Record<string, unknown> = {}) => ({
    order_id: orderId, display_status: 'refund_waiting', marks: [], next_action: 'refund', has_returnable: false,
    refund_waiting_returns: 1, requested_returns: 0, ...overrides,
  });
  const summary = (orderId: string, overrides: Record<string, unknown> = {}) => ({
    orderId, displayStatus: 'refund_waiting', marks: [], nextAction: 'refund', hasReturnable: false,
    refundWaitingReturns: 1, requestedReturns: 0, ...overrides,
  });

  it('空の入力は DB を呼ばず、空の Map を返す', async () => {
    const { store, rpc } = storeWith({});

    await expect(listOrderReturnSummaries(store, [])).resolves.toEqual(new Map());

    expect(rpc).not.toHaveBeenCalled();
  });

  it('要約を注文ごとに集める。DB が行を返さなかった注文も、返品なし・次にすることなしの要約でキーに入る', async () => {
    const { store, rpc } = storeWith({
      list_order_return_summaries: {
        data: [
          summaryRow(ORDER_ID),
          summaryRow(OTHER_ORDER_ID, {
            display_status: 'in_progress', marks: ['awaiting_items', 'awaiting_fee'], next_action: 'receive', has_returnable: true,
            refund_waiting_returns: 0, requested_returns: 2,
          }),
        ],
      },
    });

    const result = await listOrderReturnSummaries(store, [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_order_return_summaries', { _order_ids: [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID] });
    expect([...result.keys()]).toEqual([ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID]);
    expect(result.get(ORDER_ID)).toEqual(summary(ORDER_ID));
    expect(result.get(OTHER_ORDER_ID)).toEqual(
      summary(OTHER_ORDER_ID, {
        displayStatus: 'in_progress', marks: ['awaiting_items', 'awaiting_fee'], nextAction: 'receive', hasReturnable: true,
        refundWaitingReturns: 0, requestedReturns: 2,
      }),
    );
    expect(result.get(EMPTY_ORDER_ID)).toEqual({
      orderId: EMPTY_ORDER_ID, displayStatus: null, marks: [], nextAction: 'none', hasReturnable: false,
      refundWaitingReturns: 0, requestedReturns: 0,
    });
  });

  it('返品の無い注文（状態が null）と、表に無い記号（状態・印・次にすること）の扱い', async () => {
    const { store } = storeWith({
      list_order_return_summaries: {
        data: [
          summaryRow(ORDER_ID, { display_status: null, next_action: 'none', has_returnable: true, refund_waiting_returns: 0 }),
          summaryRow(OTHER_ORDER_ID, { display_status: 'weird', marks: ['weird', 'pending_inspection'], next_action: 'weird' }),
        ],
      },
    });

    const result = await listOrderReturnSummaries(store, [ORDER_ID, OTHER_ORDER_ID]);

    expect(result.get(ORDER_ID)).toEqual(
      summary(ORDER_ID, { displayStatus: null, nextAction: 'none', hasReturnable: true, refundWaitingReturns: 0 }),
    );
    expect(result.get(OTHER_ORDER_ID)).toEqual(
      summary(OTHER_ORDER_ID, { displayStatus: null, marks: ['pending_inspection'], nextAction: 'none' }),
    );
  });

  it('同じ番号は1回として数える。大文字の番号は RPC へ小文字で渡り、DB が小文字で返した行は渡した文字のキーに入る', async () => {
    const upper = ORDER_ID.toUpperCase();
    const { store, rpc } = storeWith({ list_order_return_summaries: { data: [summaryRow(ORDER_ID)] } });

    const result = await listOrderReturnSummaries(store, [upper, upper]);

    expect(rpc).toHaveBeenCalledWith('list_order_return_summaries', { _order_ids: [ORDER_ID] });
    expect([...result.keys()]).toEqual([upper]);
    expect(result.get(upper)).toEqual(summary(ORDER_ID));
  });

  it('200件ずつに分けて呼ぶ（DB の関数は201件以上を断るため）。渡した番号は全部キーに入る', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const { store, rpc } = storeWith({ list_order_return_summaries: { data: [] } });

    const result = await listOrderReturnSummaries(store, ids);

    expect(rpc.mock.calls.map(([, args]) => (args?._order_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(rpc.mock.calls[0][1]?._order_ids).toEqual(ids.slice(0, 200));
    expect(rpc.mock.calls[2][1]?._order_ids).toEqual(ids.slice(400));
    expect(result.size).toBe(450);
  });

  it('DB が TOO_MANY_ORDERS で断れば RETURN_ARGUMENT_INVALID（200件ずつに分けるので、ふつうは来ない）', async () => {
    await expectRefusal('list_order_return_summaries', 'TOO_MANY_ORDERS', 'RETURN_ARGUMENT_INVALID', (store) =>
      listOrderReturnSummaries(store, [ORDER_ID]),
    );
  });

  describe('PostgREST の max_rows（1000）で答えが切れうる時', () => {
    const rows = (count: number) => Array.from({ length: count }, () => summaryRow(ORDER_ID));

    it('1回の答えが 1000 行に届いたら、切れている恐れがあるので RefundStoreError で止める', async () => {
      const { store } = storeWith({ list_order_return_summaries: { data: rows(1000) } });

      const error = await listOrderReturnSummaries(store, [ORDER_ID]).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RefundStoreError);
      expect(error).toMatchObject({ operation: 'list_order_return_summaries' });
    });

    it('999 行なら通る', async () => {
      const { store } = storeWith({ list_order_return_summaries: { data: rows(999) } });

      await expect(listOrderReturnSummaries(store, [ORDER_ID])).resolves.toBeInstanceOf(Map);
    });
  });
});

describe('countReturnAttention', () => {
  it('一覧の上の一行の数を読む', async () => {
    const { store, rpc } = storeWith({ count_order_return_attention: { data: [{ requested: 2, refund_waiting: 3 }] } });

    await expect(countReturnAttention(store)).resolves.toEqual({ requested: 2, refundWaiting: 3 });

    expect(rpc).toHaveBeenCalledWith('count_order_return_attention', {});
  });
});

// get_shop_return_settings の答え（jsonb。共通の約束 C-2 の ShopReturnSettings のキーを snake_case にした形）
const SETTINGS_JSON = {
  requests_enabled: true,
  request_types: 'returns_only',
  notice_text: '',
  window_days: 7,
  window_start: 'each_item',
  delivery_buffer_days: 3,
  return_address: { name: 'Le Fil des Heures 返品係', postal_code: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
  customer_paid_method: 'customer_ships',
  shop_label_fee: 0,
  no_return_needed_enabled: false,
  restocking_fee_enabled: true,
  restocking_fee_percent: 10,
  exchange_fees_enabled: false,
  exchange_fee: 0,
  exchange_shipping_fee: 0,
  inspection_enabled: true,
  reasons: [
    {
      reason: 'defective', shown: true, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'make', photo: 'required',
      photo_instructions: '傷や不具合の場所がわかる写真をお送りください', shipping_payer: 'shop',
    },
    {
      reason: 'unknown', shown: false, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'decline', photo: 'none',
      photo_instructions: '', shipping_payer: 'customer',
    },
  ],
  updated: {
    requests: { at: null, by_email: null },
    window: { at: '2026-10-12T01:00:00+00:00', by_email: 'owner@example.com' },
    shipping: { at: null, by_email: null },
    reasons: { at: null, by_email: null },
    fees: { at: '2026-10-12T02:00:00+00:00', by_email: 'owner@example.com' },
    receiving: { at: null, by_email: null },
  },
};
const SETTINGS = {
  requestsEnabled: true,
  requestTypes: 'returns_only',
  noticeText: '',
  windowDays: 7,
  windowStart: 'each_item',
  deliveryBufferDays: 3,
  returnAddress: { name: 'Le Fil des Heures 返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
  customerPaidMethod: 'customer_ships',
  shopLabelFee: 0,
  noReturnNeededEnabled: false,
  restockingFeeEnabled: true,
  restockingFeePercent: 10,
  exchangeFeesEnabled: false,
  exchangeFee: 0,
  exchangeShippingFee: 0,
  inspectionEnabled: true,
  reasons: [
    {
      reason: 'defective', shown: true, resolutions: 'refund_and_exchange', outOfStockExchange: 'make', photo: 'required',
      photoInstructions: '傷や不具合の場所がわかる写真をお送りください', shippingPayer: 'shop',
    },
    {
      reason: 'unknown', shown: false, resolutions: 'refund_and_exchange', outOfStockExchange: 'decline', photo: 'none',
      photoInstructions: '', shippingPayer: 'customer',
    },
  ],
  updated: {
    requests: { at: null, byEmail: null },
    window: { at: '2026-10-12T01:00:00+00:00', byEmail: 'owner@example.com' },
    shipping: { at: null, byEmail: null },
    reasons: { at: null, byEmail: null },
    fees: { at: '2026-10-12T02:00:00+00:00', byEmail: 'owner@example.com' },
    receiving: { at: null, byEmail: null },
  },
};

describe('getShopReturnSettings / updateShopReturnSettings', () => {
  it('ショップの設定の返品の欄を読む。キーは camelCase、まとまりごとに最後に変えた人と時刻を添える', async () => {
    const { store, rpc } = storeWith({ get_shop_return_settings: { data: SETTINGS_JSON } });

    await expect(getShopReturnSettings(store)).resolves.toEqual(SETTINGS);

    expect(rpc).toHaveBeenCalledWith('get_shop_return_settings', {});
  });

  it('期限が無制限（null）で返送先が空（null）の設定も読める', async () => {
    const { store } = storeWith({ get_shop_return_settings: { data: { ...SETTINGS_JSON, window_days: null, return_address: null } } });

    await expect(getShopReturnSettings(store)).resolves.toMatchObject({ windowDays: null, returnAddress: null });
  });

  it('変える欄だけを DB の関数に渡す。値をそのまま渡す欄はキーを snake_case にする（全部）', async () => {
    const patch = {
      requestsEnabled: false,
      requestTypes: 'cancellations_only',
      noticeText: '注意書き',
      windowDays: 14,
      windowStart: 'last_item',
      deliveryBufferDays: 5,
      customerPaidMethod: 'shop_label',
      shopLabelFee: 800,
      noReturnNeededEnabled: true,
      restockingFeeEnabled: true,
      restockingFeePercent: 10,
      exchangeFeesEnabled: true,
      exchangeFee: 500,
      exchangeShippingFee: 300,
      inspectionEnabled: true,
    } satisfies ShopReturnSettingsPatch;
    const { store, rpc } = storeWith({ admin_update_shop_return_settings: { data: SETTINGS_JSON } });

    await expect(updateShopReturnSettings(store, { settings: patch, actorId: ACTOR_ID })).resolves.toEqual(SETTINGS);

    expect(rpc).toHaveBeenCalledWith('admin_update_shop_return_settings', {
      _settings: {
        requests_enabled: false,
        request_types: 'cancellations_only',
        notice_text: '注意書き',
        window_days: 14,
        window_start: 'last_item',
        delivery_buffer_days: 5,
        customer_paid_method: 'shop_label',
        shop_label_fee: 800,
        no_return_needed_enabled: true,
        restocking_fee_enabled: true,
        restocking_fee_percent: 10,
        exchange_fees_enabled: true,
        exchange_fee: 500,
        exchange_shipping_fee: 300,
        inspection_enabled: true,
      },
      _actor_id: ACTOR_ID,
    });
  });

  it('返送先は中身のキーを snake_case にする。期限を無制限（null）・返送先を空（null）にもできる', async () => {
    const { store, rpc } = storeWith({ admin_update_shop_return_settings: { data: SETTINGS_JSON } });

    await updateShopReturnSettings(store, {
      actorId: ACTOR_ID,
      settings: {
        windowDays: null,
        returnAddress: { name: '返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
      },
    });
    expect(rpc).toHaveBeenLastCalledWith('admin_update_shop_return_settings', {
      _settings: {
        window_days: null,
        return_address: { name: '返品係', postal_code: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
      },
      _actor_id: ACTOR_ID,
    });

    await updateShopReturnSettings(store, { actorId: ACTOR_ID, settings: { returnAddress: null } });
    expect(rpc).toHaveBeenLastCalledWith('admin_update_shop_return_settings', {
      _settings: { return_address: null },
      _actor_id: ACTOR_ID,
    });
  });

  it('理由ごとの設定は、理由の記号と、渡した欄だけの行にする（設定の画面が送る返送料の負担と在庫の無い交換だけの行も、段2の欄を含む全部の行も渡せる）', async () => {
    const { store, rpc } = storeWith({ admin_update_shop_return_settings: { data: SETTINGS_JSON } });

    await updateShopReturnSettings(store, {
      actorId: ACTOR_ID,
      settings: {
        reasons: [
          { reason: 'size_too_small', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          {
            reason: 'defective', shown: true, resolutions: 'refund_and_exchange', outOfStockExchange: 'make', photo: 'required',
            photoInstructions: '傷の場所がわかる写真をお送りください', shippingPayer: 'shop',
          },
        ],
      },
    });

    expect(rpc).toHaveBeenCalledWith('admin_update_shop_return_settings', {
      _settings: {
        reasons: [
          { reason: 'size_too_small', shipping_payer: 'customer', out_of_stock_exchange: 'decline' },
          {
            reason: 'defective', shown: true, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'make', photo: 'required',
            photo_instructions: '傷の場所がわかる写真をお送りください', shipping_payer: 'shop',
          },
        ],
      },
      _actor_id: ACTOR_ID,
    });
  });

  it('設定の画面が送る ShopReturnSettingsUpdate は、そのまま渡せる。段2の欄は DB に渡さない', async () => {
    const update: ShopReturnSettingsUpdate = {
      returnAddress: { name: '返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
      customerPaidMethod: 'shop_label',
      shopLabelFee: 800,
      noReturnNeededEnabled: false,
      windowDays: null,
      windowStart: 'last_item',
      deliveryBufferDays: 3,
      reasons: [{ reason: 'defective', shippingPayer: 'shop', outOfStockExchange: 'make' }],
      restockingFeeEnabled: true,
      restockingFeePercent: 10,
      exchangeFeesEnabled: false,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      inspectionEnabled: false,
    };
    const { store, rpc } = storeWith({ admin_update_shop_return_settings: { data: SETTINGS_JSON } });

    await updateShopReturnSettings(store, { settings: update, actorId: ACTOR_ID });

    expect(rpc).toHaveBeenCalledWith('admin_update_shop_return_settings', {
      _settings: {
        return_address: { name: '返品係', postal_code: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
        customer_paid_method: 'shop_label',
        shop_label_fee: 800,
        no_return_needed_enabled: false,
        window_days: null,
        window_start: 'last_item',
        delivery_buffer_days: 3,
        reasons: [{ reason: 'defective', shipping_payer: 'shop', out_of_stock_exchange: 'make' }],
        restocking_fee_enabled: true,
        restocking_fee_percent: 10,
        exchange_fees_enabled: false,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
        inspection_enabled: false,
      },
      _actor_id: ACTOR_ID,
    });
    const sent = (rpc.mock.calls[0][1]?._settings ?? {}) as Record<string, unknown>;
    for (const key of ['requests_enabled', 'request_types', 'notice_text']) {
      expect(sent).not.toHaveProperty(key);
    }
  });

  it('渡さない欄は DB に渡さない（何も変えない設定は空のオブジェクト）', async () => {
    const { store, rpc } = storeWith({ admin_update_shop_return_settings: { data: SETTINGS_JSON } });

    await updateShopReturnSettings(store, { actorId: ACTOR_ID, settings: {} });

    expect(rpc).toHaveBeenCalledWith('admin_update_shop_return_settings', { _settings: {}, _actor_id: ACTOR_ID });
  });

  it('形や範囲が違う設定を DB が SETTINGS_ARGUMENT_INVALID で断れば、E-2 の記号 invalid_argument のまま渡す（言葉と HTTP は RETURN_ARGUMENT_INVALID と同じ 400）', async () => {
    await expectRefusal('admin_update_shop_return_settings', 'SETTINGS_ARGUMENT_INVALID', 'invalid_argument', (store) =>
      updateShopReturnSettings(store, { settings: { restockingFeePercent: 101 }, actorId: ACTOR_ID }),
    );
  });
});

describe('このタスクの4つのファイルの書き方', () => {
  it.each(['return-types.ts', 'return-messages.ts', 'return-calc.ts', 'return-store.ts'])(
    "%s は import 'server-only' を書かない（単体テストと DB 結合テストが直接 import するため。src/lib/orders/refund/ と同じ）",
    (name) => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/returns', name), 'utf8');

      expect(source).not.toMatch(/import\s+['"]server-only['"]/);
    },
  );
});
