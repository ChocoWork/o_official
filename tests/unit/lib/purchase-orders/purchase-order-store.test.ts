/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  confirmPurchaseOrderQuantities, createPurchaseOrder, getAdminPurchaseOrder, listAdminPurchaseOrderLines, PurchaseOrderError,
  receivePurchaseOrder, reversePurchaseOrderReceipt, shortClosePurchaseOrder, updatePurchaseOrderHeader,
} from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_ERRORS } from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, dbListRow, LINE_2, listRow, ORDER_ID as READ_ORDER_ID } from './purchase-order-fixtures';

const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const input = {
  supplierName: '工場A',
  memo: '春の追加分',
  lines: [{ variantId: 11, quantity: 5 }, { variantId: 12, quantity: 3 }],
  requestKey: REQUEST_KEY,
};
const dbResult = { id: ORDER_ID, number: 'PO-20261025-0001', version: 1, replayed: false };

/**
 * 表のうち、DETAIL を持たない誤り。外す割当の確認（GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED）は DETAIL が
 * {"releasedQuantity":n} でなければ受け入れないので、受け取りの取消の試験（Task 7）が別に確かめる。
 */
const PLAIN_ERRORS = Object.entries(PURCHASE_ORDER_ERRORS).filter(([message]) => message !== 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED');

beforeEach(() => rpc.mockReset());

async function failureOf(run: () => Promise<unknown>): Promise<PurchaseOrderError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PurchaseOrderError);
    return error as PurchaseOrderError;
  }
  throw new Error('expected a PurchaseOrderError');
}

describe('PurchaseOrderError', () => {
  test.each(['GROUP_G_ARGUMENT_INVALID', 'GROUP_G_FORBIDDEN', 'GROUP_G_REQUEST_KEY_CONFLICT'])(
    'FREQ-526-AC-02: 表にある code（%s）は表の本文と code を持つ', (code) => {
      const error = new PurchaseOrderError(PURCHASE_ORDER_ERRORS[code][1], code);
      expect({ status: error.status, code: error.code, message: error.message })
        .toEqual({ status: PURCHASE_ORDER_ERRORS[code][1], code, message: PURCHASE_ORDER_ERRORS[code][2] });
    });

  test.each([
    ['DOCUMENT_NOT_UPLOADED', 409, 'ファイルがまだ届いていません。もう一度アップロードしてください。'],
    ['DOCUMENT_TYPE_UNSUPPORTED', 422, 'PDF・JPEG・PNG のファイルを選んでください。'],
    ['DOCUMENT_STORAGE_UNAVAILABLE', 503, 'ファイルの保存先に接続できません。時間をおいて再度お試しください。'],
    ['DOCUMENT_NOT_FOUND', 404, '原本を取得できません。'],
  ])('FREQ-530-AC-02: 原本の code（%s）は、渡した状態のまま原本の表の本文と code を持つ', (code, status, body) => {
    const error = new PurchaseOrderError(status, code);
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status, code, message: body });
  });

  test.each(['PRIVATE-MARKER', 'toString', '__proto__', 'constructor', 'hasOwnProperty', ''])(
    'FREQ-526-AC-02: 表に無い code（%j）でも落ちず、code 無しの固定の失敗の文になる', (code) => {
      const error = new PurchaseOrderError(500, code);
      expect(error.status).toBe(500);
      expect(error.code).toBeUndefined();
      expect(error.message).toBe('発注の記録に失敗しました');
      expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    });

  test('FREQ-526-AC-02: 引数が無ければ 500・code 無し・固定の失敗の文', () => {
    const error = new PurchaseOrderError();
    expect({ status: error.status, code: error.code, message: error.message, name: error.name })
      .toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました', name: 'PurchaseOrderError' });
  });
});

describe('createPurchaseOrder', () => {
  test('FREQ-526-AC-02: RPC admin_create_purchase_order を、引数名どおり・実行者つきで1回だけ呼ぶ', async () => {
    rpc.mockResolvedValue({ data: dbResult, error: null });
    await expect(createPurchaseOrder(client, 'actor-1', input)).resolves.toEqual(dbResult);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_create_purchase_order', {
      _supplier_name: '工場A',
      _memo: '春の追加分',
      _lines: [{ variantId: 11, quantity: 5 }, { variantId: 12, quantity: 3 }],
      _actor_id: 'actor-1',
      _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-526-AC-02: メモが無ければ null を渡し、明細は variantId と quantity だけを渡す（余分な項目は付けない）', async () => {
    rpc.mockResolvedValue({ data: dbResult, error: null });
    const lines = [{ variantId: 11, quantity: 5, extra: 'x' }] as unknown as typeof input.lines;
    await createPurchaseOrder(client, 'actor-1', { ...input, memo: null, lines });
    const args = rpc.mock.calls[0][1];
    expect(args._memo).toBeNull();
    expect(args._lines).toEqual([{ variantId: 11, quantity: 5 }]);
    expect(Object.keys(args._lines[0])).toEqual(['variantId', 'quantity']);
  });

  test('FREQ-526-AC-03: 再送された結果（replayed: true）はそのまま返す', async () => {
    rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
    await expect(createPurchaseOrder(client, 'actor-1', input)).resolves.toEqual({ ...dbResult, replayed: true });
  });

  test.each(PLAIN_ERRORS)(
    'FREQ-526-AC-02: DB の %s は message と SQLSTATE が両方そろった時だけ、表の状態と固定の本文の PurchaseOrderError にする',
    async (message, [sqlstate, status, body]) => {
      rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
      const error = await failureOf(() => createPurchaseOrder(client, 'actor-1', input));
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status, code: message, message: body });
      expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
      expect(error.cause).toBeUndefined();
    },
  );

  test('FREQ-526-AC-02: 表の3つ（入力・権限・同じ要求番号で別の内容）の状態と本文は計画のとおり', () => {
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_ARGUMENT_INVALID).toEqual(['22023', 400, '入力を確かめてください。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_FORBIDDEN).toEqual(['42501', 403, '発注を扱う権限がありません。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_REQUEST_KEY_CONFLICT).toEqual(['23505', 409, '同じ要求番号で異なる操作は実行できません。']);
  });

  test.each([
    ['message は表にあるが SQLSTATE が違う', { message: 'GROUP_G_FORBIDDEN', code: '22023' }],
    ['SQLSTATE は表と同じだが message が表に無い', { message: 'PRIVATE-MARKER', code: '42501' }],
    ['message が無い', { code: '42501' }],
    ['code が無い', { message: 'GROUP_G_FORBIDDEN' }],
    ['message の前後に余分な文字', { message: 'GROUP_G_FORBIDDEN ', code: '42501' }],
    ['message は継承した名前（toString）', { message: 'toString', code: '42501' }],
    ['PostgREST の別の誤り', { message: 'PRIVATE-MARKER', code: 'PGRST202', details: 'PRIVATE-MARKER' }],
  ])('FREQ-526-AC-02: 未知・不一致（%s）は500の固定の文で、生の文も code も出さない', async (_name, dbError) => {
    rpc.mockResolvedValue({ data: null, error: dbError });
    const error = await failureOf(() => createPurchaseOrder(client, 'actor-1', input));
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({
      status: 500, code: undefined, message: '発注の記録に失敗しました',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    expect(error.cause).toBeUndefined();
  });

  test('FREQ-526-AC-02: 通信そのものの失敗（RPC が throw）も500の固定の文で、生の文を持たない', async () => {
    rpc.mockRejectedValue(new TypeError('PRIVATE-MARKER'));
    const error = await failureOf(() => createPurchaseOrder(client, 'actor-1', input));
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({
      status: 500, code: undefined, message: '発注の記録に失敗しました',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    expect(error.cause).toBeUndefined();
  });

  test.each([
    ['null', null],
    ['配列', [dbResult]],
    ['文字列', 'PRIVATE-MARKER'],
    ['id が uuid でない', { ...dbResult, id: 'abc' }],
    ['id が無い', { ...dbResult, id: undefined }],
    ['number の形が違う', { ...dbResult, number: 'PO-2026-1' }],
    ['number が前後に余分な文字', { ...dbResult, number: ' PO-20261025-0001' }],
    ['version が0', { ...dbResult, version: 0 }],
    ['version が小数', { ...dbResult, version: 1.5 }],
    ['version が文字列', { ...dbResult, version: '1' }],
    ['replayed が真偽値でない', { ...dbResult, replayed: 'false' }],
    ['replayed が無い', { ...dbResult, replayed: undefined }],
  ])('FREQ-526-AC-02: 戻り値の型検査: %s は500の固定の文（成功として返さない）', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const error = await failureOf(() => createPurchaseOrder(client, 'actor-1', input));
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({
      status: 500, code: undefined, message: '発注の記録に失敗しました',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-526-AC-02: 戻り値に余分な項目があっても、返すのは id・number・version・replayed の4つだけ', async () => {
    rpc.mockResolvedValue({ data: { ...dbResult, secret: 'PRIVATE-MARKER' }, error: null });
    const result = await createPurchaseOrder(client, 'actor-1', input);
    expect(Object.keys(result)).toEqual(['id', 'number', 'version', 'replayed']);
  });
});

describe('発注書の書込み（Task 6）: updatePurchaseOrderHeader・confirmPurchaseOrderQuantities・shortClosePurchaseOrder', () => {
  const LINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const LINE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const base = { purchaseOrderId: ORDER_ID, expectedVersion: 3, requestKey: REQUEST_KEY };

  const writers = [
    {
      name: 'updatePurchaseOrderHeader',
      rpcName: 'admin_update_purchase_order_header',
      call: () => updatePurchaseOrderHeader(client, 'actor-1', { ...base, supplierName: '工場B', memo: '新しいメモ', reason: '社名変更' }),
      args: { _purchase_order_id: ORDER_ID, _expected_version: 3, _supplier_name: '工場B', _memo: '新しいメモ', _reason: '社名変更', _actor_id: 'actor-1', _request_key: REQUEST_KEY },
      data: { version: 4, replayed: false },
      keys: ['version', 'replayed'],
      broken: [
        ['null', null], ['配列', [{ version: 4, replayed: false }]], ['version が0', { version: 0, replayed: false }],
        ['version が小数', { version: 1.5, replayed: false }], ['version が文字列', { version: '4', replayed: false }],
        ['replayed が無い', { version: 4 }], ['replayed が文字列', { version: 4, replayed: 'false' }],
      ] as Array<[string, unknown]>,
    },
    {
      name: 'confirmPurchaseOrderQuantities',
      rpcName: 'admin_confirm_purchase_order_quantities',
      call: () => confirmPurchaseOrderQuantities(client, 'actor-1', {
        ...base, lines: [{ lineId: LINE_A, quantity: 4, unitPriceYen: 1200 }, { lineId: LINE_B, quantity: 0, unitPriceYen: null }], reason: '工場の都合',
      }),
      args: {
        _purchase_order_id: ORDER_ID, _expected_version: 3,
        _lines: [{ lineId: LINE_A, quantity: 4, unitPriceYen: 1200 }, { lineId: LINE_B, quantity: 0, unitPriceYen: null }],
        _reason: '工場の都合', _actor_id: 'actor-1', _request_key: REQUEST_KEY,
      },
      data: { version: 4, changedLines: 2, replayed: false },
      keys: ['version', 'changedLines', 'replayed'],
      broken: [
        ['null', null], ['version が0', { version: 0, changedLines: 1, replayed: false }],
        ['changedLines が負', { version: 4, changedLines: -1, replayed: false }], ['changedLines が小数', { version: 4, changedLines: 1.5, replayed: false }],
        ['changedLines が無い', { version: 4, replayed: false }], ['replayed が無い', { version: 4, changedLines: 1 }],
      ] as Array<[string, unknown]>,
    },
    {
      name: 'shortClosePurchaseOrder',
      rpcName: 'admin_short_close_purchase_order',
      call: () => shortClosePurchaseOrder(client, 'actor-1', { ...base, lineIds: [LINE_B, LINE_A], reason: '残りを打ち切る' }),
      args: { _purchase_order_id: ORDER_ID, _expected_version: 3, _line_ids: [LINE_B, LINE_A], _reason: '残りを打ち切る', _actor_id: 'actor-1', _request_key: REQUEST_KEY },
      data: { version: 4, closedQuantity: 7, replayed: false },
      keys: ['version', 'closedQuantity', 'replayed'],
      broken: [
        ['null', null], ['version が0', { version: 0, closedQuantity: 1, replayed: false }],
        ['closedQuantity が負', { version: 4, closedQuantity: -1, replayed: false }], ['closedQuantity が文字列', { version: 4, closedQuantity: '7', replayed: false }],
        ['closedQuantity が無い', { version: 4, replayed: false }], ['replayed が真偽値でない', { version: 4, closedQuantity: 1, replayed: 0 }],
      ] as Array<[string, unknown]>,
    },
  ];

  describe.each(writers)('$name', (writer) => {
    test('FREQ-527-AC-01: RPC を引数名どおり・実行者つきで1回だけ呼び、DB の戻りをそのまま返す', async () => {
      rpc.mockResolvedValue({ data: writer.data, error: null });
      await expect(writer.call()).resolves.toEqual(writer.data);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(writer.rpcName, writer.args);
    });

    test('FREQ-527-AC-01: 再送された結果（replayed: true）はそのまま返し、戻りは決まった項目だけ（余分な項目は落とす）', async () => {
      rpc.mockResolvedValue({ data: { ...writer.data, replayed: true, secret: 'PRIVATE-MARKER' }, error: null });
      const result = await writer.call();
      expect(result).toEqual({ ...writer.data, replayed: true });
      expect(Object.keys(result)).toEqual(writer.keys);
    });

    test.each(PLAIN_ERRORS)(
      'FREQ-527-AC-01: DB の %s は message と SQLSTATE が両方そろった時だけ、表の状態と固定の本文の PurchaseOrderError にする',
      async (message, [sqlstate, status, body]) => {
        rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
        const error = await failureOf(writer.call);
        expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status, code: message, message: body });
        expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
        expect(error.cause).toBeUndefined();
      },
    );

    test.each([
      ['message は表にあるが SQLSTATE が違う', { message: 'GROUP_G_PO_VERSION_CONFLICT', code: '22023' }],
      ['SQLSTATE は表と同じだが message が表に無い', { message: 'PRIVATE-MARKER', code: '55000' }],
      ['message が無い', { code: '55000' }],
      ['code が無い', { message: 'GROUP_G_PO_VERSION_CONFLICT' }],
      ['message は継承した名前（toString）', { message: 'toString', code: '55000' }],
      ['PostgREST の別の誤り', { message: 'PRIVATE-MARKER', code: 'PGRST202', details: 'PRIVATE-MARKER' }],
    ])('FREQ-527-AC-01: 未知・不一致（%s）は500の固定の文で、生の文も code も出さない', async (_name, dbError) => {
      rpc.mockResolvedValue({ data: null, error: dbError });
      const error = await failureOf(writer.call);
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました' });
      expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    });

    test('FREQ-527-AC-01: 通信そのものの失敗（RPC が throw）も500の固定の文で、生の文を持たない', async () => {
      rpc.mockRejectedValue(new TypeError('PRIVATE-MARKER'));
      const error = await failureOf(writer.call);
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました' });
      expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
      expect(error.cause).toBeUndefined();
    });

    test.each(writer.broken)('FREQ-527-AC-01: 戻り値の型検査: %s は500の固定の文（成功として返さない）', async (_name, data) => {
      rpc.mockResolvedValue({ data, error: null });
      const error = await failureOf(writer.call);
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました' });
    });
  });

  test('FREQ-527-AC-01: 発注先・メモの訂正でメモが null ならメモを空にする（null をそのまま渡す）', async () => {
    rpc.mockResolvedValue({ data: { version: 4, replayed: false }, error: null });
    await updatePurchaseOrderHeader(client, 'actor-1', { ...base, supplierName: '工場A', memo: null, reason: 'メモを消す' });
    expect(rpc.mock.calls[0][1]._memo).toBeNull();
  });

  test('FREQ-527-AC-01: 数量の確定で理由が null なら null を渡す。明細は lineId・quantity・unitPriceYen の3項目だけで、単価 0 と null を区別して渡す', async () => {
    rpc.mockResolvedValue({ data: { version: 2, changedLines: 0, replayed: false }, error: null });
    const lines = [{ lineId: LINE_A, quantity: 5, unitPriceYen: 0, extra: 'x' }, { lineId: LINE_B, quantity: 3, unitPriceYen: null }] as unknown as Array<{ lineId: string; quantity: number; unitPriceYen: number | null }>;
    await confirmPurchaseOrderQuantities(client, 'actor-1', { ...base, expectedVersion: 1, lines, reason: null });
    const args = rpc.mock.calls[0][1];
    expect(args._reason).toBeNull();
    expect(args._lines).toEqual([{ lineId: LINE_A, quantity: 5, unitPriceYen: 0 }, { lineId: LINE_B, quantity: 3, unitPriceYen: null }]);
    expect(Object.keys(args._lines[0])).toEqual(['lineId', 'quantity', 'unitPriceYen']);
  });
});

describe('受け取り（Task 7）: receivePurchaseOrder・reversePurchaseOrderReceipt', () => {
  const LINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const LINE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const RECEIPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const NEW_RECEIPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const RECEIPT_LINE_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const RECEIPT_LINE_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
  const base = { purchaseOrderId: ORDER_ID, expectedVersion: 3, requestKey: REQUEST_KEY };
  const RECEIPT_FORBIDDEN = '受け取りを記録する権限がありません。';

  const writers = [
    {
      name: 'receivePurchaseOrder',
      rpcName: 'admin_receive_purchase_order',
      call: () => receivePurchaseOrder(client, 'actor-1', {
        ...base, receivedOn: '2026-10-26', memo: '午前便', lines: [{ lineId: LINE_B, quantity: 3 }, { lineId: LINE_A, quantity: 2 }],
      }),
      args: {
        _purchase_order_id: ORDER_ID, _expected_version: 3, _received_on: '2026-10-26', _memo: '午前便',
        _lines: [{ lineId: LINE_B, quantity: 3 }, { lineId: LINE_A, quantity: 2 }], _actor_id: 'actor-1', _request_key: REQUEST_KEY,
      },
      data: { receiptId: NEW_RECEIPT, version: 4, allocatedQuantity: 2, replayed: false },
      keys: ['receiptId', 'version', 'allocatedQuantity', 'replayed'],
      broken: [
        ['null', null], ['配列', [{ receiptId: NEW_RECEIPT, version: 4, allocatedQuantity: 2, replayed: false }]],
        ['receiptId が無い', { version: 4, allocatedQuantity: 2, replayed: false }], ['receiptId が uuid でない', { receiptId: 'abc', version: 4, allocatedQuantity: 2, replayed: false }],
        ['version が0', { receiptId: NEW_RECEIPT, version: 0, allocatedQuantity: 2, replayed: false }],
        ['allocatedQuantity が負', { receiptId: NEW_RECEIPT, version: 4, allocatedQuantity: -1, replayed: false }],
        ['allocatedQuantity が小数', { receiptId: NEW_RECEIPT, version: 4, allocatedQuantity: 1.5, replayed: false }],
        ['allocatedQuantity が文字列', { receiptId: NEW_RECEIPT, version: 4, allocatedQuantity: '2', replayed: false }],
        ['allocatedQuantity が無い', { receiptId: NEW_RECEIPT, version: 4, replayed: false }],
        ['replayed が真偽値でない', { receiptId: NEW_RECEIPT, version: 4, allocatedQuantity: 2, replayed: 0 }],
      ] as Array<[string, unknown]>,
    },
    {
      name: 'reversePurchaseOrderReceipt',
      rpcName: 'admin_reverse_purchase_order_receipt',
      call: () => reversePurchaseOrderReceipt(client, 'actor-1', {
        ...base, receiptId: RECEIPT, lines: [{ receiptLineId: RECEIPT_LINE_B, quantity: 1 }, { receiptLineId: RECEIPT_LINE_A, quantity: 2 }],
        reason: '数え間違い', expectedReleaseQuantity: 3,
      }),
      args: {
        _purchase_order_id: ORDER_ID, _expected_version: 3, _receipt_id: RECEIPT,
        _lines: [{ receiptLineId: RECEIPT_LINE_B, quantity: 1 }, { receiptLineId: RECEIPT_LINE_A, quantity: 2 }],
        _reason: '数え間違い', _expected_release_quantity: 3, _actor_id: 'actor-1', _request_key: REQUEST_KEY,
      },
      data: { receiptId: NEW_RECEIPT, version: 4, releasedQuantity: 3, replayed: false },
      keys: ['receiptId', 'version', 'releasedQuantity', 'replayed'],
      broken: [
        ['null', null], ['receiptId が無い', { version: 4, releasedQuantity: 3, replayed: false }],
        ['receiptId が uuid でない', { receiptId: 'abc', version: 4, releasedQuantity: 3, replayed: false }],
        ['version が0', { receiptId: NEW_RECEIPT, version: 0, releasedQuantity: 3, replayed: false }],
        ['releasedQuantity が負', { receiptId: NEW_RECEIPT, version: 4, releasedQuantity: -1, replayed: false }],
        ['releasedQuantity が文字列', { receiptId: NEW_RECEIPT, version: 4, releasedQuantity: '3', replayed: false }],
        ['releasedQuantity が無い', { receiptId: NEW_RECEIPT, version: 4, replayed: false }],
        ['replayed が無い', { receiptId: NEW_RECEIPT, version: 4, releasedQuantity: 3 }],
      ] as Array<[string, unknown]>,
    },
  ];

  describe.each(writers)('$name', (writer) => {
    test('FREQ-529-AC-01: RPC を引数名どおり・実行者つきで1回だけ呼び、DB の戻りをそのまま返す', async () => {
      rpc.mockResolvedValue({ data: writer.data, error: null });
      await expect(writer.call()).resolves.toEqual(writer.data);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(writer.rpcName, writer.args);
    });

    test('FREQ-529-AC-02: 再送された結果（replayed: true）はそのまま返し、戻りは決まった項目だけ（余分な項目は落とす）', async () => {
      rpc.mockResolvedValue({ data: { ...writer.data, replayed: true, secret: 'PRIVATE-MARKER' }, error: null });
      const result = await writer.call();
      expect(result).toEqual({ ...writer.data, replayed: true });
      expect(Object.keys(result)).toEqual(writer.keys);
    });

    test.each(PLAIN_ERRORS)(
      'FREQ-529-AC-01: DB の %s は message と SQLSTATE が両方そろった時だけ、表の状態と固定の本文の PurchaseOrderError にする（権限の文だけ受け取り用）',
      async (message, [sqlstate, status, body]) => {
        rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
        const error = await failureOf(writer.call);
        expect({ status: error.status, code: error.code, message: error.message })
          .toEqual({ status, code: message, message: message === 'GROUP_G_FORBIDDEN' ? RECEIPT_FORBIDDEN : body });
        expect(error.releasedQuantity).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
        expect(error.cause).toBeUndefined();
      },
    );

    test.each([
      ['message は表にあるが SQLSTATE が違う', { message: 'GROUP_G_PO_VERSION_CONFLICT', code: '22023' }],
      ['SQLSTATE は表と同じだが message が表に無い', { message: 'PRIVATE-MARKER', code: '55000' }],
      ['message が無い', { code: '55000' }],
      ['code が無い', { message: 'GROUP_G_PO_NOT_CONFIRMED' }],
      ['message は継承した名前（toString）', { message: 'toString', code: '55000' }],
      ['PostgREST の別の誤り', { message: 'PRIVATE-MARKER', code: 'PGRST202', details: 'PRIVATE-MARKER' }],
    ])('FREQ-529-AC-01: 未知・不一致（%s）は500の固定の文で、生の文も code も出さない', async (_name, dbError) => {
      rpc.mockResolvedValue({ data: null, error: dbError });
      const error = await failureOf(writer.call);
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました' });
      expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    });

    test('FREQ-529-AC-01: 通信そのものの失敗（RPC が throw）も500の固定の文で、生の文を持たない', async () => {
      rpc.mockRejectedValue(new TypeError('PRIVATE-MARKER'));
      const error = await failureOf(writer.call);
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました' });
      expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
      expect(error.cause).toBeUndefined();
    });

    test.each(writer.broken)('FREQ-529-AC-01: 戻り値の型検査: %s は500の固定の文（成功として返さない）', async (_name, data) => {
      rpc.mockResolvedValue({ data, error: null });
      const error = await failureOf(writer.call);
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました' });
    });
  });

  test('FREQ-529-AC-01: 受け取りの明細は lineId と quantity だけを渡し（余分な項目は付けない）、メモが無ければ null を渡す', async () => {
    rpc.mockResolvedValue({ data: { receiptId: NEW_RECEIPT, version: 4, allocatedQuantity: 0, replayed: false }, error: null });
    const lines = [{ lineId: LINE_A, quantity: 2, extra: 'x' }] as unknown as Array<{ lineId: string; quantity: number }>;
    await receivePurchaseOrder(client, 'actor-1', { ...base, receivedOn: '2026-10-26', memo: null, lines });
    const args = rpc.mock.calls[0][1];
    expect(args._memo).toBeNull();
    expect(args._lines).toEqual([{ lineId: LINE_A, quantity: 2 }]);
    expect(Object.keys(args._lines[0])).toEqual(['lineId', 'quantity']);
  });

  test('FREQ-529-AC-04: 取消の明細は receiptLineId と quantity だけを渡し、確認の数が無ければ null（最初の送信）。0 は 0 のまま渡す', async () => {
    rpc.mockResolvedValue({ data: { receiptId: NEW_RECEIPT, version: 4, releasedQuantity: 0, replayed: false }, error: null });
    const lines = [{ receiptLineId: RECEIPT_LINE_A, quantity: 2, extra: 'x' }] as unknown as Array<{ receiptLineId: string; quantity: number }>;
    await reversePurchaseOrderReceipt(client, 'actor-1', { ...base, receiptId: RECEIPT, lines, reason: '数え間違い', expectedReleaseQuantity: null });
    expect(rpc.mock.calls[0][1]._expected_release_quantity).toBeNull();
    expect(rpc.mock.calls[0][1]._lines).toEqual([{ receiptLineId: RECEIPT_LINE_A, quantity: 2 }]);
    expect(Object.keys(rpc.mock.calls[0][1]._lines[0])).toEqual(['receiptLineId', 'quantity']);
    await reversePurchaseOrderReceipt(client, 'actor-1', { ...base, receiptId: RECEIPT, lines, reason: '数え間違い', expectedReleaseQuantity: 0 });
    expect(rpc.mock.calls[1][1]._expected_release_quantity).toBe(0);
  });

  test('FREQ-529-AC-04: 外す割当の確認（55000）は DETAIL の {"releasedQuantity":n} だけを解釈し、409・code・releasedQuantity を持つ PurchaseOrderError にする', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', details: '{"releasedQuantity": 3}', hint: 'PRIVATE-MARKER' },
    });
    const error = await failureOf(() => reversePurchaseOrderReceipt(client, 'actor-1', {
      ...base, receiptId: RECEIPT, lines: [{ receiptLineId: RECEIPT_LINE_A, quantity: 2 }], reason: '数え間違い', expectedReleaseQuantity: null,
    }));
    expect({ status: error.status, code: error.code, message: error.message, releasedQuantity: error.releasedQuantity })
      .toEqual({ status: 409, code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', message: '割り当て済みの品を外す必要があります。数量を確認してください。', releasedQuantity: 3 });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    // 確認の数 0 もそのまま
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', details: '{"releasedQuantity": 0}' } });
    expect((await failureOf(() => receivePurchaseOrder(client, 'actor-1', {
      ...base, receivedOn: '2026-10-26', memo: null, lines: [{ lineId: LINE_A, quantity: 1 }],
    }))).releasedQuantity).toBe(0);
  });

  test.each([
    ['DETAIL が無い', undefined], ['DETAIL が null', null], ['DETAIL が JSON でない', 'not json'], ['キーが違う', '{"released": 3}'],
    ['キーが2つ', '{"releasedQuantity": 3, "extra": 1}'], ['点数が負', '{"releasedQuantity": -1}'], ['点数が小数', '{"releasedQuantity": 1.5}'],
    ['点数が文字', '{"releasedQuantity": "3"}'], ['点数が大きすぎる', '{"releasedQuantity": 2147483648}'], ['配列', '[3]'], ['SQLSTATE が違う（別の誤りの DETAIL）', '{"releasedQuantity": 3}'],
  ])('FREQ-529-AC-04: 確認の誤りでも %s なら確認として受け入れず、500の固定の文', async (name, details) => {
    const code = name.startsWith('SQLSTATE') ? '22023' : '55000';
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code, details } });
    const error = await failureOf(() => reversePurchaseOrderReceipt(client, 'actor-1', {
      ...base, receiptId: RECEIPT, lines: [{ receiptLineId: RECEIPT_LINE_B, quantity: 1 }], reason: '数え間違い', expectedReleaseQuantity: null,
    }));
    expect({ status: error.status, code: error.code, message: error.message, releasedQuantity: error.releasedQuantity })
      .toEqual({ status: 500, code: undefined, message: '発注の記録に失敗しました', releasedQuantity: undefined });
  });

  test('FREQ-529-AC-04: PurchaseOrderError は releasedQuantity を、表にある code の時だけ持つ', () => {
    expect(new PurchaseOrderError(409, 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', { releasedQuantity: 2 }).releasedQuantity).toBe(2);
    expect(new PurchaseOrderError(500, 'PRIVATE-MARKER', { releasedQuantity: 2 }).releasedQuantity).toBeUndefined();
    expect(new PurchaseOrderError(403, 'GROUP_G_FORBIDDEN', { surface: 'receipt' }).message).toBe(RECEIPT_FORBIDDEN);
    expect(new PurchaseOrderError(403, 'GROUP_G_FORBIDDEN').message).toBe('発注を扱う権限がありません。');
  });
});

/** 読取の失敗は、権限の拒否（PurchaseOrderError 403）以外は生の文を持たない内部の失敗 */
async function readFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('listAdminPurchaseOrderLines', () => {
  const second = listRow({ lineId: LINE_2, lineNo: 2, itemName: 'パンツ', colorName: null, sizeLabel: null, orderQuantity: null, outstandingQuantity: null, receivedQuantity: 0, displayStage: 'ordered' });

  test('FREQ-526-AC-04: RPC list_admin_purchase_order_lines を引数名どおり（limit・offset・実行者）1回だけ呼び、camelCase の行と全行数を返す', async () => {
    rpc.mockResolvedValue({ data: [dbListRow(2, listRow()), dbListRow(2, second)], error: null });
    await expect(listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 1 })).resolves.toEqual({ rows: [listRow(), second], total: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_admin_purchase_order_lines', { _limit: 20, _offset: 0, _actor_id: 'actor-1' });
  });

  test.each([[1, 20, 0], [2, 20, 20], [3, 20, 40], [4, 5, 15], [1, 100, 0], [10, 100, 900]])(
    'FREQ-526-AC-04: page=%i・limit=%i の offset は (page − 1) × limit = %i', async (page, limit, offset) => {
      rpc.mockResolvedValue({ data: [], error: null });
      await listAdminPurchaseOrderLines(client, 'actor-1', { limit, page });
      expect(rpc).toHaveBeenCalledWith('list_admin_purchase_order_lines', { _limit: limit, _offset: offset, _actor_id: 'actor-1' });
    });

  test('FREQ-526-AC-04: 行が無ければ rows は空で total は0', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 1 })).resolves.toEqual({ rows: [], total: 0 });
  });

  test('FREQ-526-AC-04: 頁の範囲に収まらない全行数（頁より多い）は total にそのまま入る', async () => {
    rpc.mockResolvedValue({ data: [dbListRow(45, listRow())], error: null });
    await expect(listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 3 })).resolves.toMatchObject({ total: 45 });
  });

  test('FREQ-526-AC-04: DB の列に余分な項目があっても、返す行は決まった12項目だけ', async () => {
    rpc.mockResolvedValue({ data: [{ ...dbListRow(1), storage_path: 'PRIVATE-MARKER' }], error: null });
    const { rows } = await listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 1 });
    expect(Object.keys(rows[0]).sort()).toEqual([
      'colorName', 'displayStage', 'itemName', 'lineId', 'lineNo', 'number', 'orderQuantity', 'outstandingQuantity',
      'provisionalQuantity', 'purchaseOrderId', 'receivedQuantity', 'sizeLabel',
    ]);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-540-AC-07: DB が GROUP_G_FORBIDDEN / 42501 で断ったら403の PurchaseOrderError（固定の文。DB の生の文も cause も持たない）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const error = await failureOf(() => listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 1 }));
    expect({ status: error.status, code: error.code }).toEqual({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    expect(error.cause).toBeUndefined();
  });

  test.each([
    ['message は権限の拒否だが SQLSTATE が違う', { message: 'GROUP_G_FORBIDDEN', code: '22023' }],
    ['SQLSTATE は権限の拒否だが message が違う', { message: 'PRIVATE-MARKER', code: '42501' }],
    ['message が前後に余分な文字', { message: 'GROUP_G_FORBIDDEN ', code: '42501' }],
    ['code が無い', { message: 'GROUP_G_FORBIDDEN' }],
    ['入力の誤り（窓口が先に検証するので内部の失敗）', { message: 'GROUP_G_ARGUMENT_INVALID', code: '22023' }],
    ['PostgREST の別の誤り', { message: 'PRIVATE-MARKER', code: 'PGRST202', details: 'PRIVATE-MARKER' }],
  ])('FREQ-526-AC-04: 権限の拒否と完全に一致しない失敗（%s）は PURCHASE_ORDER_READ_FAILED で、生の文を持たない', async (_name, dbError) => {
    rpc.mockResolvedValue({ data: null, error: dbError });
    const error = await readFailure(() => listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 1 }));
    expect(error).not.toBeInstanceOf(PurchaseOrderError);
    expect((error as Error).message).toBe('PURCHASE_ORDER_READ_FAILED');
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    expect((error as Error).cause).toBeUndefined();
  });

  test('FREQ-526-AC-04: 通信そのものの失敗（RPC が throw）も PURCHASE_ORDER_READ_FAILED', async () => {
    rpc.mockRejectedValue(new TypeError('PRIVATE-MARKER'));
    const error = await readFailure(() => listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 1 }));
    expect((error as Error).message).toBe('PURCHASE_ORDER_READ_FAILED');
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
  });

  test.each([
    ['null', null],
    ['配列でない', { rows: [] }],
    ['行がオブジェクトでない', ['x']],
    ['total が文字列', [{ ...dbListRow(1), total: '1' }]],
    ['total が負', [{ ...dbListRow(1), total: -1 }]],
    ['total が行数より小さい', [dbListRow(1, listRow()), dbListRow(1, second)]],
    ['行ごとに total が違う', [dbListRow(2, listRow()), dbListRow(3, second)]],
    ['同じ明細が2回', [dbListRow(2, listRow()), dbListRow(2, listRow())]],
    ['未知の表示段階', [{ ...dbListRow(1), display_stage: 'draft' }]],
    ['明細番号が0', [{ ...dbListRow(1), line_no: 0 }]],
    ['納品済みが負', [{ ...dbListRow(1), received_quantity: -1 }]],
    ['発注数量があるのに未納が NULL', [{ ...dbListRow(1), outstanding_quantity: null }]],
    ['未納が 発注数量 − 納品済み と合わない', [{ ...dbListRow(1), outstanding_quantity: 9 }]],
    ['発注書の番号の形が違う', [{ ...dbListRow(1), number: 'PO-1' }]],
  ])('FREQ-526-AC-04: 応答の形の崩れ（%s）は成功として返さず PURCHASE_ORDER_READ_FAILED', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const error = await readFailure(() => listAdminPurchaseOrderLines(client, 'actor-1', { limit: 20, page: 1 }));
    expect((error as Error).message).toBe('PURCHASE_ORDER_READ_FAILED');
  });
});

describe('getAdminPurchaseOrder', () => {
  test('FREQ-526-AC-05: RPC get_admin_purchase_order を引数名どおり（発注書の id・実行者）1回だけ呼び、検査した詳細を返す', async () => {
    rpc.mockResolvedValue({ data: confirmedDetail(), error: null });
    await expect(getAdminPurchaseOrder(client, 'actor-1', READ_ORDER_ID)).resolves.toEqual(confirmedDetail());
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_admin_purchase_order', { _purchase_order_id: READ_ORDER_ID, _actor_id: 'actor-1' });
  });

  test('FREQ-526-AC-05: 発注書が無ければ null（DB が NULL を返す）', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getAdminPurchaseOrder(client, 'actor-1', READ_ORDER_ID)).resolves.toBeNull();
  });

  test('FREQ-526-AC-05: DB の戻りの余分な項目（保存先の鍵など）は返さない', async () => {
    rpc.mockResolvedValue({ data: { ...confirmedDetail(), storage_path: 'PRIVATE-MARKER' }, error: null });
    const detail = await getAdminPurchaseOrder(client, 'actor-1', READ_ORDER_ID);
    expect(JSON.stringify(detail)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-540-AC-07: DB が GROUP_G_FORBIDDEN / 42501 で断ったら403の PurchaseOrderError（固定の文。生の文も cause も持たない）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const error = await failureOf(() => getAdminPurchaseOrder(client, 'actor-1', READ_ORDER_ID));
    expect({ status: error.status, code: error.code }).toEqual({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    expect(error.cause).toBeUndefined();
  });

  test.each([
    ['権限の拒否だが SQLSTATE が違う', { message: 'GROUP_G_FORBIDDEN', code: '22023' }],
    ['SQLSTATE は権限の拒否だが message が違う', { message: 'PRIVATE-MARKER', code: '42501' }],
    ['PostgREST の別の誤り', { message: 'PRIVATE-MARKER', code: 'PGRST202', details: 'PRIVATE-MARKER' }],
  ])('FREQ-526-AC-05: 権限の拒否と完全に一致しない失敗（%s）は PURCHASE_ORDER_READ_FAILED', async (_name, dbError) => {
    rpc.mockResolvedValue({ data: null, error: dbError });
    const error = await readFailure(() => getAdminPurchaseOrder(client, 'actor-1', READ_ORDER_ID));
    expect(error).not.toBeInstanceOf(PurchaseOrderError);
    expect((error as Error).message).toBe('PURCHASE_ORDER_READ_FAILED');
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-526-AC-05: 通信そのものの失敗（RPC が throw）も PURCHASE_ORDER_READ_FAILED', async () => {
    rpc.mockRejectedValue(new TypeError('PRIVATE-MARKER'));
    const error = await readFailure(() => getAdminPurchaseOrder(client, 'actor-1', READ_ORDER_ID));
    expect((error as Error).message).toBe('PURCHASE_ORDER_READ_FAILED');
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
  });

  test.each([
    ['形の崩れ（未知の保存段階）', { ...confirmedDetail(), stage: 'draft' }],
    ['形の崩れ（行の納品済みが負）', { ...confirmedDetail(), lines: [{ ...confirmedDetail().lines[0], receivedQuantity: -1 }] }],
    ['配列', [confirmedDetail()]],
    ['文字列', 'PRIVATE-MARKER'],
    ['頼んだ id と違う発注書', { ...confirmedDetail(), id: '99999999-9999-4999-8999-999999999999' }],
  ])('FREQ-526-AC-05: 応答の崩れ（%s）は成功として返さず PURCHASE_ORDER_READ_FAILED', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const error = await readFailure(() => getAdminPurchaseOrder(client, 'actor-1', READ_ORDER_ID));
    expect((error as Error).message).toBe('PURCHASE_ORDER_READ_FAILED');
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
  });
});
