/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPurchaseOrder, PurchaseOrderError } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_ERRORS } from '@/lib/purchase-orders/purchase-order-types';

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
