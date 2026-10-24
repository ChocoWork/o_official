/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createPurchaseOrder, getAdminPurchaseOrder, listAdminPurchaseOrderLines, PurchaseOrderError,
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

  test.each(Object.entries(PURCHASE_ORDER_ERRORS))(
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
