/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

import type { SupabaseClient } from '@supabase/supabase-js';
import { inspect } from 'util';
import {
  cancelShipmentSlip,
  canCorrectShipmentDate,
  classify,
  confirmShipmentSlip,
  correctShipmentDate,
  discardShipmentSlipDraft,
  getAdminShipmentSlip,
  listAdminOrderShipmentSlips,
  listAdminPacking,
  listAdminShipmentSlips,
  listShipmentAccountingInputs,
  markShipmentSlipDelivered,
  saveShipmentSlipDraft,
  ShipmentSlipError,
  updateShipmentSlipTracking,
} from '@/lib/orders/shipment-slips/shipment-slip-store';
import { SHIPMENT_SLIP_ERRORS } from '@/lib/orders/shipment-slips/shipment-slip-types';
import {
  confirmedDetail,
  dbPackingRow,
  dbSlipListRow,
  draftDetail,
  FULFILLMENT_ID,
  FULFILLMENT_ID_2,
  ITEM_ID_2,
  ORDER_ID,
  packingRow,
  SLIP_ID,
  SLIP_ID_2,
  slipListRow,
} from './shipment-slip-fixtures';

const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;
const FAILED = '発送の記録に失敗しました';

describe('listShipmentAccountingInputs', () => {
  const raw = { slip_id: SLIP_ID, fulfillment_id: FULFILLMENT_ID, order_item_id: ITEM_ID_2, quantity: 2,
    shipment_date: '2026-10-25', revision_id: SLIP_ID_2, cancelled_at: null };
  test('FREQ-535-AC-05: service-role accounting reader sends its exact three arguments and projects only approved fields', async () => {
    rpc.mockResolvedValue({ data: [{ ...raw, private_value: 'PRIVATE' }], error: null });
    expect(await listShipmentAccountingInputs(client, { from: '2026-10-01', to: '2026-10-31', limit: 100 })).toEqual([
      { slipId: SLIP_ID, fulfillmentId: FULFILLMENT_ID, orderItemId: ITEM_ID_2, quantity: 2, shipmentDate: '2026-10-25', revisionId: SLIP_ID_2, cancelledAt: null },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_shipment_accounting_inputs', { _from: '2026-10-01', _to: '2026-10-31', _limit: 100 });
  });
  test.each([null, {}, [null], [{ ...raw, quantity: 0 }], [{ ...raw, shipment_date: '2026-02-30' }],
    [{ ...raw, revision_id: 'bad' }], [{ ...raw, cancelled_at: 'bad' }], [raw, raw]])('FREQ-535-AC-05: malformed accounting material is a fixed 500 (%#)', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(listShipmentAccountingInputs(client, { from: '2026-10-01', to: '2026-10-31', limit: 100 })).rejects.toMatchObject({ status: 500, message: FAILED });
  });
  test('FREQ-535-AC-05: empty input, cancellation time, business denial and transport failure retain the store contract', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await listShipmentAccountingInputs(client, { from: '2026-10-01', to: '2026-10-31', limit: 100 })).toEqual([]);
    rpc.mockResolvedValueOnce({ data: [{ ...raw, cancelled_at: '2026-10-26T01:00:00+00:00' }], error: null });
    expect((await listShipmentAccountingInputs(client, { from: '2026-10-01', to: '2026-10-31', limit: 100 }))[0].cancelledAt).toBe('2026-10-26T01:00:00+00:00');
    rpc.mockResolvedValueOnce({ data: [{ ...raw, revision_id: null }], error: null });
    expect((await listShipmentAccountingInputs(client, { from: '2026-10-01', to: '2026-10-31', limit: 100 }))[0].revisionId).toBeNull();
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' } });
    await expect(listShipmentAccountingInputs(client, { from: '2026-10-01', to: '2026-10-31', limit: 0 })).rejects.toMatchObject({ status: 400, code: 'GROUP_G_ARGUMENT_INVALID' });
    rpc.mockRejectedValueOnce(new Error('PRIVATE'));
    await expect(listShipmentAccountingInputs(client, { from: '2026-10-01', to: '2026-10-31', limit: 100 })).rejects.toMatchObject({ status: 500, message: FAILED });
  });
});

describe('canCorrectShipmentDate', () => {
  const required = ['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read'];
  const permissionRow = (codes: string[]) => ({ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } });
  test.each([[], required.slice(1), [required[0]], required].map((codes) => [codes]))('FREQ-540-AC-10: 権限集合%jを静かに読み、3権限が揃う時だけtrue', async (codes) => {
    const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), or: jest.fn().mockResolvedValue({ data: [permissionRow(codes)], error: null }) };
    const from = jest.fn().mockReturnValue(query);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await canCorrectShipmentDate({ from } as unknown as SupabaseClient, 'authorized-actor')).toBe(codes.length === 3);
      expect(from).toHaveBeenCalledWith('user_roles');
      expect(query.eq).toHaveBeenCalledWith('user_id', 'authorized-actor');
      expect(query.eq).toHaveBeenCalledWith('active', true);
      expect(query.or).toHaveBeenCalledWith(expect.stringMatching(/^expires_at\.is\.null,expires_at\.gt\./));
      expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); }
  });
  test('FREQ-540-AC-10: 有効な複数役割の和集合で数え、照会失敗は固定500', async () => {
    const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), or: jest.fn().mockResolvedValue({ data: [permissionRow(required.slice(0, 1)), permissionRow(required.slice(1))], error: null }) };
    const aclClient = { from: jest.fn().mockReturnValue(query) } as unknown as SupabaseClient;
    expect(await canCorrectShipmentDate(aclClient, 'actor')).toBe(true);
    query.or.mockResolvedValueOnce({ data: null, error: { message: 'PRIVATE' } });
    await expect(canCorrectShipmentDate(aclClient, 'actor')).rejects.toMatchObject({ status: 500, message: FAILED });
  });
});

describe('correctShipmentDate', () => {
  const input = { slipId: SLIP_ID, expectedVersion: 2, shipmentDate: '2026-10-24', reason: '記録の訂正', requestKey: SLIP_ID_2 };
  const result = { id: SLIP_ID, version: 3, shipmentDate: input.shipmentDate, replayed: false };
  test('FREQ-535-AC-03: 認可actorと全引数を1回RPCへ渡し、許可された成功項目だけ返す', async () => {
    rpc.mockResolvedValue({ data: { ...result, private_value: 'PRIVATE' }, error: null });
    expect(await correctShipmentDate(client, 'actor', input)).toEqual(result);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_correct_shipment_date', { _slip_id: SLIP_ID, _expected_version: 2,
      _shipment_date: input.shipmentDate, _reason: input.reason, _actor_id: 'actor', _request_key: SLIP_ID_2 });
  });
  test.each([null, {}, { ...result, id: SLIP_ID_2 }, { ...result, version: 0 }, { ...result, shipmentDate: '2026-02-30' }, { ...result, replayed: 'true' }])('FREQ-535-AC-03: 崩れた成功%jを固定500にする', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(correctShipmentDate(client, 'actor', input)).rejects.toMatchObject({ status: 500, message: FAILED });
  });
  test('FREQ-535-AC-03: 再送と既知・未知の失敗を分類する', async () => {
    rpc.mockResolvedValueOnce({ data: { ...result, replayed: true }, error: null });
    expect(await correctShipmentDate(client, 'actor', input)).toEqual({ ...result, replayed: true });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY', code: '22023' } });
    await expect(correctShipmentDate(client, 'actor', input)).rejects.toMatchObject({ status: 409, code: 'GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY' });
    rpc.mockRejectedValueOnce(new Error('PRIVATE'));
    await expect(correctShipmentDate(client, 'actor', input)).rejects.toMatchObject({ status: 500, message: FAILED });
  });
});

/** 失敗を捕まえて、状態・code・本文を返す */
async function failure(action: () => Promise<unknown>): Promise<{ status: number; code: string | undefined; message: string; error: unknown }> {
  try {
    await action();
  } catch (error) {
    const typed = error as ShipmentSlipError;
    return { status: typed.status, code: typed.code, message: typed.message, error };
  }
  throw new Error('failure expected');
}

beforeEach(() => {
  rpc.mockReset();
});

describe('listAdminPacking', () => {
  test('FREQ-531-AC-01: DB の関数 list_admin_packing を実行者つきで1回呼び、行を camelCase にして total は total_count から取る', async () => {
    rpc.mockResolvedValue({
      data: [
        dbPackingRow({ total_count: 120 }),
        dbPackingRow({ order_item_id: ITEM_ID_2, blocked_reasons: ['variant_missing'], shippable_quantity: 0, is_exchange: true, other_slip_numbers: ['SL-20261025-0002'], total_count: 120 }),
      ],
      error: null,
    });
    const result = await listAdminPacking(client, 'actor-1', { slipId: null, limit: 50, page: 3 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_admin_packing', { _slip_id: null, _limit: 50, _offset: 100, _actor_id: 'actor-1' });
    expect(result.total).toBe(120);
    expect(result.rows).toEqual([
      packingRow(),
      packingRow({ orderItemId: ITEM_ID_2, blockedReasons: ['variant_missing'], shippableQuantity: 0, isExchange: true, otherSlipNumbers: ['SL-20261025-0002'] }),
    ]);
  });

  test('FREQ-531-AC-03: slipId を渡すと下書きの番号で呼び、選んでいる数が付く', async () => {
    rpc.mockResolvedValue({ data: [dbPackingRow({ selected_quantity: 2 })], error: null });
    const result = await listAdminPacking(client, 'actor-1', { slipId: SLIP_ID, limit: 100, page: 1 });
    expect(rpc).toHaveBeenCalledWith('list_admin_packing', { _slip_id: SLIP_ID, _limit: 100, _offset: 0, _actor_id: 'actor-1' });
    expect(result.rows[0].selectedQuantity).toBe(2);
  });

  test('FREQ-531-AC-01: 行が無ければ空の行と total 0', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(listAdminPacking(client, 'actor-1', { slipId: null, limit: 50, page: 1 })).resolves.toEqual({ rows: [], total: 0 });
  });

  test.each([
    ['配列でない', null],
    ['行がオブジェクトでない', ['x']],
    ['total_count が無い', [{ ...dbPackingRow(), total_count: undefined }]],
    ['total_count が文字', [dbPackingRow({ total_count: '1' })]],
    ['total_count が負', [dbPackingRow({ total_count: -1 })]],
    ['total_count が行数より少ない', [dbPackingRow({ total_count: 1 }), dbPackingRow({ order_item_id: ITEM_ID_2, total_count: 1 })]],
    ['行の total_count が揃わない', [dbPackingRow({ total_count: 5 }), dbPackingRow({ order_item_id: ITEM_ID_2, total_count: 6 })]],
    ['同じ明細が重なる', [dbPackingRow({ total_count: 2 }), dbPackingRow({ total_count: 2 })]],
    ['行が崩れている', [dbPackingRow({ ready_quantity: 0 })]],
    ['阻害理由が知らない値', [dbPackingRow({ blocked_reasons: ['unknown'], shippable_quantity: 0 })]],
  ])('FREQ-531-AC-01: 戻りが崩れている（%s）と、生の中身を持たない固定の500', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const result = await failure(() => listAdminPacking(client, 'actor-1', { slipId: null, limit: 50, page: 1 }));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test('FREQ-531-AC-04: DB が権限で断ると 403 と固定の文（生の文・details は持たない）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await failure(() => listAdminPacking(client, 'actor-1', { slipId: null, limit: 50, page: 1 }));
    expect(result).toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN', message: '発送を扱う権限がありません。' });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-531-AC-04: RPC が投げても固定の500', async () => {
    rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await failure(() => listAdminPacking(client, 'actor-1', { slipId: null, limit: 50, page: 1 }));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });
});

describe('classify（message と SQLSTATE の完全一致だけで分類する）', () => {
  test.each(Object.entries(SHIPMENT_SLIP_ERRORS))('FREQ-531-AC-04: %s は表の状態と本文', (message, [sqlstate, status, body]) => {
    const error = classify({ message, code: sqlstate, details: 'PRIVATE-MARKER' });
    expect(error).toBeInstanceOf(ShipmentSlipError);
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status, code: message, message: body });
  });

  test.each([
    ['message が表にあっても SQLSTATE が違う', { message: 'GROUP_G_FORBIDDEN', code: '22023' }],
    ['SQLSTATE が無い', { message: 'GROUP_G_FORBIDDEN' }],
    ['message が表に無い', { message: 'PRIVATE-MARKER', code: '42501' }],
    ['message が内部のエラー', { message: 'GROUP_G_SHIPMENT_CONSUMPTION', code: '23514' }],
    ['継承した名前 toString', { message: 'toString', code: '42501' }],
    ['継承した名前 __proto__', { message: '__proto__', code: '42501' }],
    ['継承した名前 constructor', { message: 'constructor', code: '42501' }],
    ['message が文字でない', { message: 1, code: '42501' }],
    ['null', null],
    ['文字', 'GROUP_G_FORBIDDEN'],
  ])('FREQ-531-AC-04: %s は固定の500（code を持たない）', (_name, error) => {
    const classified = classify(error);
    expect({ status: classified.status, code: classified.code, message: classified.message }).toEqual({ status: 500, code: undefined, message: FAILED });
    expect(inspect(classified, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-531-AC-04: ShipmentSlipError は DB の生の誤りも cause も持たない', () => {
    const classified = classify({ message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER' });
    expect(Object.keys(classified).sort()).toEqual(['code', 'name', 'status']);
    expect((classified as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('listAdminShipmentSlips', () => {
  test('FREQ-531-AC-01: DB の関数 list_admin_shipment_slips を段階つきで1回呼び、行と total を返す', async () => {
    rpc.mockResolvedValue({
      data: [
        dbSlipListRow({ total_count: 2 }),
        dbSlipListRow({ id: SLIP_ID_2, number: 'SL-20261025-0002', stage: 'draft', expired: true, shipment_date: null, shipping_carrier: null, tracking_number: null, total_count: 2 }),
      ],
      error: null,
    });
    const result = await listAdminShipmentSlips(client, 'actor-1', { stage: 'confirmed', limit: 20, page: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_admin_shipment_slips', { _stage: 'confirmed', _limit: 20, _offset: 20, _actor_id: 'actor-1' });
    expect(result).toEqual({
      rows: [slipListRow(), slipListRow({ id: SLIP_ID_2, number: 'SL-20261025-0002', stage: 'draft', expired: true, shipmentDate: null, shippingCarrier: null, trackingNumber: null })],
      total: 2,
    });
  });

  test('FREQ-531-AC-01: 段階を指定しなければ null を渡す', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await listAdminShipmentSlips(client, 'actor-1', { stage: null, limit: 20, page: 1 });
    expect(rpc).toHaveBeenCalledWith('list_admin_shipment_slips', { _stage: null, _limit: 20, _offset: 0, _actor_id: 'actor-1' });
  });

  test.each([
    ['配列でない', { rows: [] }],
    ['同じ票が重なる', [dbSlipListRow({ total_count: 2 }), dbSlipListRow({ total_count: 2 })]],
    ['行が崩れている', [dbSlipListRow({ stage: 'unknown' })]],
    ['運送会社だけがある', [dbSlipListRow({ tracking_number: null })]],
  ])('FREQ-531-AC-01: 戻りが崩れている（%s）と固定の500', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await failure(() => listAdminShipmentSlips(client, 'actor-1', { stage: null, limit: 20, page: 1 })))
      .toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test('FREQ-531-AC-04: DB が引数を断ると 400、権限で断ると 403', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_ARGUMENT_INVALID', code: '22023' } });
    expect(await failure(() => listAdminShipmentSlips(client, 'actor-1', { stage: null, limit: 20, page: 1 })))
      .toMatchObject({ status: 400, code: 'GROUP_G_ARGUMENT_INVALID', message: '入力を確かめてください。' });
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
    expect(await failure(() => listAdminShipmentSlips(client, 'actor-1', { stage: null, limit: 20, page: 1 })))
      .toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
  });
});

describe('getAdminShipmentSlip', () => {
  test('FREQ-531-AC-01: DB の関数 get_admin_shipment_slip を票の番号と実行者で1回呼び、詳細を返す', async () => {
    rpc.mockResolvedValue({ data: confirmedDetail(), error: null });
    await expect(getAdminShipmentSlip(client, 'actor-1', SLIP_ID)).resolves.toEqual(confirmedDetail());
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_admin_shipment_slip', { _slip_id: SLIP_ID, _actor_id: 'actor-1' });
  });

  test('FREQ-531-AC-01: 大文字で頼んだ票でも、同じ票が返れば通る', async () => {
    rpc.mockResolvedValue({ data: draftDetail(), error: null });
    await expect(getAdminShipmentSlip(client, 'actor-1', SLIP_ID.toUpperCase())).resolves.toEqual(draftDetail());
  });

  test('FREQ-531-AC-01: 票が無ければ 404 と固定の文', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_SLIP_NOT_FOUND', code: 'P0002' } });
    expect(await failure(() => getAdminShipmentSlip(client, 'actor-1', SLIP_ID)))
      .toMatchObject({ status: 404, code: 'GROUP_G_SLIP_NOT_FOUND', message: '発送票が見つかりません。' });
  });

  test.each([
    ['戻りが null', null],
    ['戻りが配列', [draftDetail()]],
    ['項目が崩れている', { ...draftDetail(), stage: 'unknown' }],
    ['頼んだ票と別の票', draftDetail({ id: SLIP_ID_2 })],
  ])('FREQ-531-AC-01: 戻りが崩れている（%s）と固定の500', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await failure(() => getAdminShipmentSlip(client, 'actor-1', SLIP_ID))).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test('FREQ-531-AC-04: DB が権限で断ると 403', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
    expect(await failure(() => getAdminShipmentSlip(client, 'actor-1', SLIP_ID))).toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
  });
});

describe('listAdminOrderShipmentSlips', () => {
  const link = (overrides: Record<string, unknown> = {}) => ({
    slip_id: SLIP_ID, number: 'SL-20261025-0001', stage: 'confirmed', fulfillment_id: FULFILLMENT_ID, ...overrides,
  });

  test('FREQ-533-AC-01: DB の関数 list_admin_order_shipment_slips を注文の番号と実行者で1回呼び、発送の番号をキーにした表を返す', async () => {
    rpc.mockResolvedValue({
      data: [link(), link({ slip_id: SLIP_ID_2, number: 'SL-20261025-0002', stage: 'cancelled', fulfillment_id: FULFILLMENT_ID_2 })],
      error: null,
    });
    const result = await listAdminOrderShipmentSlips(client, 'actor-1', ORDER_ID);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_admin_order_shipment_slips', { _order_id: ORDER_ID, _actor_id: 'actor-1' });
    expect([...result.entries()]).toEqual([
      [FULFILLMENT_ID, { slipId: SLIP_ID, number: 'SL-20261025-0001', stage: 'confirmed' }],
      [FULFILLMENT_ID_2, { slipId: SLIP_ID_2, number: 'SL-20261025-0002', stage: 'cancelled' }],
    ]);
  });

  test('FREQ-533-AC-01: 票に属する発送が無ければ空の表', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect((await listAdminOrderShipmentSlips(client, 'actor-1', ORDER_ID)).size).toBe(0);
  });

  test.each([
    ['配列でない', null],
    ['行がオブジェクトでない', ['x']],
    ['同じ発送が2つの票に属する', [link(), link({ slip_id: SLIP_ID_2, number: 'SL-20261025-0002' })]],
    ['票の番号の形が違う', [link({ number: 'SL-1' })]],
    ['段階が知らない値', [link({ stage: 'unknown' })]],
    ['発送の番号が無い', [link({ fulfillment_id: null })]],
  ])('FREQ-533-AC-01: 戻りが崩れている（%s）と固定の500', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await failure(() => listAdminOrderShipmentSlips(client, 'actor-1', ORDER_ID))).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test('FREQ-531-AC-04: DB が権限で断ると 403（呼び手が履歴だけを返すための印）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
    expect(await failure(() => listAdminOrderShipmentSlips(client, 'actor-1', ORDER_ID))).toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
  });
});

const REQUEST_KEY = '66666666-6666-4666-8666-666666666661';
const SAVED = { id: SLIP_ID, number: 'SL-20261025-0001', version: 1, replayed: false };
/** 下書きの保存・破棄で、DB の拒否がそのまま表の状態・code・本文になる組（保存と破棄が返しうるもの） */
const DRAFT_REFUSALS = [
  'GROUP_G_ARGUMENT_INVALID', 'GROUP_G_FORBIDDEN', 'GROUP_G_REQUEST_KEY_CONFLICT', 'GROUP_G_SLIP_NOT_FOUND', 'GROUP_G_SLIP_VERSION_CONFLICT',
  'GROUP_G_SLIP_NOT_DRAFT', 'GROUP_G_SLIP_EMPTY', 'GROUP_G_SLIP_CUSTOMER_MISMATCH', 'GROUP_G_SLIP_ADDRESS_MISMATCH', 'GROUP_G_SLIP_ADDRESS_INCOMPLETE',
  'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE', 'GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED', 'GROUP_G_SLIP_EXCHANGE_ON_HOLD', 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY',
] as const;
/** 表に載せない内部の誤り（生の文を出さない固定の500） */
const INTERNAL_ERRORS: Array<[string, string]> = [
  ['GROUP_G_SHIPMENT_CONSUMPTION', '23514'], ['GROUP_G_INVENTORY_LOCK_REQUIRED', '55000'],
  ['GROUP_G_SLIP_NUMBER_EXHAUSTED', '55000'], ['GROUP_G_HISTORY_IMMUTABLE', '55000'], ['PRIVATE-MARKER', '57014'],
];

describe('saveShipmentSlipDraft', () => {
  test('FREQ-531-AC-03: 作成は slipId・expectedVersion を NULL にして admin_save_shipment_slip_draft を実行者つきで1回呼び、行は orderItemId と quantity だけを渡して結果を返す', async () => {
    rpc.mockResolvedValue({ data: SAVED, error: null });
    const result = await saveShipmentSlipDraft(client, 'actor-1', {
      slipId: null, expectedVersion: null, requestKey: REQUEST_KEY,
      lines: [{ orderItemId: ITEM_ID_2, quantity: 2, extra: 'x' } as { orderItemId: string; quantity: number }],
    });
    expect(result).toEqual(SAVED);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_save_shipment_slip_draft', {
      _slip_id: null, _expected_version: null, _lines: [{ orderItemId: ITEM_ID_2, quantity: 2 }], _actor_id: 'actor-1', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-531-AC-03: 入替は票の id と版を渡す。同じ要求番号・同じ内容の再送は replayed: true の同じ結果', async () => {
    rpc.mockResolvedValue({ data: { ...SAVED, version: 3, replayed: true }, error: null });
    const result = await saveShipmentSlipDraft(client, 'actor-1', {
      slipId: SLIP_ID, expectedVersion: 2, requestKey: REQUEST_KEY, lines: [{ orderItemId: ITEM_ID_2, quantity: 1 }],
    });
    expect(result).toEqual({ ...SAVED, version: 3, replayed: true });
    expect(rpc).toHaveBeenCalledWith('admin_save_shipment_slip_draft', {
      _slip_id: SLIP_ID, _expected_version: 2, _lines: [{ orderItemId: ITEM_ID_2, quantity: 1 }], _actor_id: 'actor-1', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-531-AC-03: 戻りは決まった4項目だけにする（知らない項目は落とす）', async () => {
    rpc.mockResolvedValue({ data: { ...SAVED, secret: 'PRIVATE-MARKER' }, error: null });
    const result = await saveShipmentSlipDraft(client, 'actor-1', { slipId: null, expectedVersion: null, requestKey: REQUEST_KEY, lines: [] });
    expect(result).toEqual(SAVED);
    expect(Object.keys(result).sort()).toEqual(['id', 'number', 'replayed', 'version']);
  });

  test.each(DRAFT_REFUSALS)('FREQ-532-AC-01: DB の拒否 %s は message と SQLSTATE がそろった時だけ表の状態・code・本文にする', async (message) => {
    const [sqlstate, status, body] = SHIPMENT_SLIP_ERRORS[message];
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await failure(() => saveShipmentSlipDraft(client, 'actor-1', { slipId: null, expectedVersion: null, requestKey: REQUEST_KEY, lines: [] }));
    expect(result).toMatchObject({ status, code: message, message: body });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test.each(INTERNAL_ERRORS)('FREQ-531-AC-04: 表に載せない誤り %s は生の文を出さない固定の500', async (message, code) => {
    rpc.mockResolvedValue({ data: null, error: { message, code, details: 'PRIVATE-MARKER' } });
    const result = await failure(() => saveShipmentSlipDraft(client, 'actor-1', { slipId: null, expectedVersion: null, requestKey: REQUEST_KEY, lines: [] }));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test.each([
    ['null', null], ['配列', [SAVED]], ['id が無い', { ...SAVED, id: undefined }], ['id が uuid でない', { ...SAVED, id: 'x' }],
    ['番号の形が違う', { ...SAVED, number: 'SL-1' }], ['版が 0', { ...SAVED, version: 0 }], ['版が小数', { ...SAVED, version: 1.5 }],
    ['replayed が文字', { ...SAVED, replayed: 'false' }],
  ])('FREQ-531-AC-04: 戻りが崩れている（%s）と固定の500', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const result = await failure(() => saveShipmentSlipDraft(client, 'actor-1', { slipId: null, expectedVersion: null, requestKey: REQUEST_KEY, lines: [] }));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test('FREQ-531-AC-04: RPC が投げても固定の500で、生の文を持たない', async () => {
    rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await failure(() => saveShipmentSlipDraft(client, 'actor-1', { slipId: null, expectedVersion: null, requestKey: REQUEST_KEY, lines: [] }));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });
});

describe('discardShipmentSlipDraft', () => {
  test('FREQ-531-AC-03: admin_discard_shipment_slip_draft を票の id・版・実行者・要求番号で1回呼び、結果を返す', async () => {
    rpc.mockResolvedValue({ data: { ...SAVED, version: 2 }, error: null });
    const result = await discardShipmentSlipDraft(client, 'actor-1', { slipId: SLIP_ID, expectedVersion: 1, requestKey: REQUEST_KEY });
    expect(result).toEqual({ ...SAVED, version: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_discard_shipment_slip_draft', {
      _slip_id: SLIP_ID, _expected_version: 1, _actor_id: 'actor-1', _request_key: REQUEST_KEY,
    });
  });

  test.each(DRAFT_REFUSALS)('FREQ-531-AC-03: DB の拒否 %s は表の状態・code・本文にする', async (message) => {
    const [sqlstate, status, body] = SHIPMENT_SLIP_ERRORS[message];
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER' } });
    const result = await failure(() => discardShipmentSlipDraft(client, 'actor-1', { slipId: SLIP_ID, expectedVersion: 1, requestKey: REQUEST_KEY }));
    expect(result).toMatchObject({ status, code: message, message: body });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test.each([['null', null], ['版が無い', { ...SAVED, version: undefined }], ['番号が違う形', { ...SAVED, number: 'PO-20261025-0001' }]])(
    'FREQ-531-AC-04: 戻りが崩れている（%s）と固定の500', async (_name, data) => {
      rpc.mockResolvedValue({ data, error: null });
      const result = await failure(() => discardShipmentSlipDraft(client, 'actor-1', { slipId: SLIP_ID, expectedVersion: 1, requestKey: REQUEST_KEY }));
      expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    },
  );

  test('FREQ-531-AC-04: 表に載せない誤りと通信の失敗は生の文を出さない固定の500', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_HISTORY_IMMUTABLE', code: '55000', details: 'PRIVATE-MARKER' } });
    expect(await failure(() => discardShipmentSlipDraft(client, 'actor-1', { slipId: SLIP_ID, expectedVersion: 1, requestKey: REQUEST_KEY })))
      .toMatchObject({ status: 500, code: undefined, message: FAILED });
    rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await failure(() => discardShipmentSlipDraft(client, 'actor-1', { slipId: SLIP_ID, expectedVersion: 1, requestKey: REQUEST_KEY }));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });
});
const CONFIRMED = { ...SAVED, version: 2, shipmentDate: '2026-10-25', fulfillments: [{ orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, number: 1, completesOrder: false }] };
const CONFIRM_INPUT = { slipId: SLIP_ID, expectedVersion: 1, carrier: null, trackingNumber: null, shipmentDate: '2026-10-25', notifyCustomer: true, requestKey: REQUEST_KEY };
describe('confirmShipmentSlip', () => {
  test('FREQ-533-AC-02: 全引数と認可済みactorでRPCを1回呼び、追加項目を捨てた結果を返す', async () => {
    rpc.mockResolvedValue({ data: { ...CONFIRMED, secret: 'discard' }, error: null });
    expect(await confirmShipmentSlip(client, 'actor-1', CONFIRM_INPUT)).toEqual(CONFIRMED);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_confirm_shipment_slip', { _slip_id: SLIP_ID, _expected_version: 1, _carrier: null, _tracking_number: null, _shipment_date: '2026-10-25', _notify_customer: true, _actor_id: 'actor-1', _request_key: REQUEST_KEY });
  });
  test.each(Object.entries(SHIPMENT_SLIP_ERRORS))('FREQ-533-AC-02: %s のmessageとSQLSTATEを完全一致で分類する', async (code, [sqlstate, status, message]) => {
    rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate, details: 'PRIVATE-MARKER' } });
    expect(await failure(() => confirmShipmentSlip(client, 'actor', CONFIRM_INPUT))).toMatchObject({ status, code, message });
    rpc.mockResolvedValue({ data: null, error: { message: code, code: 'XXXXX' } });
    expect(await failure(() => confirmShipmentSlip(client, 'actor', CONFIRM_INPUT))).toMatchObject({ status: 500, message: FAILED });
  });
  test.each([null, { ...CONFIRMED, id: SLIP_ID_2 }, { ...CONFIRMED, shipmentDate: null }, { ...CONFIRMED, fulfillments: [] }, { ...CONFIRMED, fulfillments: [{ ...CONFIRMED.fulfillments[0], completesOrder: 'false' }] }, { ...CONFIRMED, fulfillments: [CONFIRMED.fulfillments[0], CONFIRMED.fulfillments[0]] }])('FREQ-533-AC-02: 崩れた戻りは固定の500 (%j)', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await failure(() => confirmShipmentSlip(client, 'actor', CONFIRM_INPUT))).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });
});

const CANCELLED = { id: SLIP_ID, version: 3, restoredQuantity: 4, replayed: false };
const CANCEL_INPUT = { slipId: SLIP_ID, expectedVersion: 2, requestKey: REQUEST_KEY };
describe('cancelShipmentSlip', () => {
  test('FREQ-533-AC-04: admin_cancel_shipment_slip を票の id・版・実行者・要求番号で1回呼び、追加項目を捨てた結果 { id, version, restoredQuantity, replayed } を返す', async () => {
    rpc.mockResolvedValue({ data: { ...CANCELLED, secret: 'discard' }, error: null });
    expect(await cancelShipmentSlip(client, 'actor-1', CANCEL_INPUT)).toEqual(CANCELLED);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_cancel_shipment_slip', { _slip_id: SLIP_ID, _expected_version: 2, _actor_id: 'actor-1', _request_key: REQUEST_KEY });
  });

  test('FREQ-534-AC-03: 同じ要求番号の再送（replayed: true）はそのまま返す', async () => {
    rpc.mockResolvedValue({ data: { ...CANCELLED, replayed: true }, error: null });
    expect(await cancelShipmentSlip(client, 'actor-1', CANCEL_INPUT)).toEqual({ ...CANCELLED, replayed: true });
  });

  test.each(Object.entries(SHIPMENT_SLIP_ERRORS))('FREQ-534-AC-03: DB の %s は message と SQLSTATE の完全一致で表の状態・code・本文にし、SQLSTATE が違えば固定の500', async (code, [sqlstate, status, message]) => {
    rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate, details: 'PRIVATE-MARKER' } });
    const result = await failure(() => cancelShipmentSlip(client, 'actor', CANCEL_INPUT));
    expect(result).toMatchObject({ status, code, message });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
    rpc.mockResolvedValue({ data: null, error: { message: code, code: 'XXXXX' } });
    expect(await failure(() => cancelShipmentSlip(client, 'actor', CANCEL_INPUT))).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test.each([
    ['返品', 'GROUP_G_SLIP_HAS_RETURN', '返品の対象になっている注文があるため、発送を取り消せません。'],
    ['発送後の返金', 'GROUP_G_SLIP_REFUNDED', '発送後に返金した注文があるため、発送を取り消せません。'],
    ['取り消せない状態', 'GROUP_G_SLIP_CANCEL_NOT_ALLOWED', '取り消せない状態の注文があるため、発送を取り消せません。'],
    ['取消済み', 'GROUP_G_SLIP_CANCELLED', 'この発送票は取り消されています。'],
    ['確定前', 'GROUP_G_SLIP_NOT_CONFIRMED', '発送が確定した発送票だけで行える操作です。'],
  ])('FREQ-534-AC-03: 取消の拒否（%s）は409と固定の本文で、注文番号・氏名・住所を含めない', async (_name, code, body) => {
    rpc.mockResolvedValue({ data: null, error: { message: code, code: SHIPMENT_SLIP_ERRORS[code][0], details: 'ORD-PRIVATE 氏名 住所' } });
    const result = await failure(() => cancelShipmentSlip(client, 'actor', CANCEL_INPUT));
    expect(result).toMatchObject({ status: 409, code, message: body });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toMatch(/PRIVATE|氏名|住所/);
  });

  test.each([
    ['null', null], ['別の票の答え', { ...CANCELLED, id: SLIP_ID_2 }], ['版が無い', { ...CANCELLED, version: undefined }], ['戻した数が0', { ...CANCELLED, restoredQuantity: 0 }],
    ['戻した数が小数', { ...CANCELLED, restoredQuantity: 1.5 }], ['replayedが文字', { ...CANCELLED, replayed: 'false' }], ['idが崩れている', { ...CANCELLED, id: 'PRIVATE-MARKER' }],
  ])('FREQ-534-AC-03: 崩れた戻り（%s）は固定の500で、中身を出さない', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const result = await failure(() => cancelShipmentSlip(client, 'actor', CANCEL_INPUT));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-534-AC-03: 表に載せない誤りと通信の失敗は生の文を出さない固定の500', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_SHIPMENT_CONSUMPTION', code: '23514', details: 'PRIVATE-MARKER' } });
    expect(await failure(() => cancelShipmentSlip(client, 'actor', CANCEL_INPUT))).toMatchObject({ status: 500, code: undefined, message: FAILED });
    rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await failure(() => cancelShipmentSlip(client, 'actor', CANCEL_INPUT));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });
});

const TRACKING_UPDATED = { id: SLIP_ID, version: 3, trackingVersion: 2, replayed: false };
const TRACKING_INPUT = { slipId: SLIP_ID, expectedVersion: 2, carrier: 'sagawa' as const, trackingNumber: 'NEW-456', notifyCustomer: true, requestKey: REQUEST_KEY };
describe('updateShipmentSlipTracking', () => {
  test('FREQ-534-AC-01: admin_update_shipment_slip_tracking を全引数と認可済みの実行者で1回呼び、追加項目を捨てた結果 { id, version, trackingVersion, replayed } を返す', async () => {
    rpc.mockResolvedValue({ data: { ...TRACKING_UPDATED, secret: 'discard' }, error: null });
    expect(await updateShipmentSlipTracking(client, 'actor-1', TRACKING_INPUT)).toEqual(TRACKING_UPDATED);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_update_shipment_slip_tracking', {
      _slip_id: SLIP_ID, _expected_version: 2, _carrier: 'sagawa', _tracking_number: 'NEW-456', _notify_customer: true,
      _actor_id: 'actor-1', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-534-AC-01: 同じ要求番号の再送（replayed: true）はそのまま返し、通知オフもそのまま渡す', async () => {
    rpc.mockResolvedValue({ data: { ...TRACKING_UPDATED, replayed: true }, error: null });
    expect(await updateShipmentSlipTracking(client, 'actor-1', { ...TRACKING_INPUT, notifyCustomer: false })).toEqual({ ...TRACKING_UPDATED, replayed: true });
    expect(rpc).toHaveBeenCalledWith('admin_update_shipment_slip_tracking', expect.objectContaining({ _notify_customer: false }));
  });

  test.each(Object.entries(SHIPMENT_SLIP_ERRORS))('FREQ-534-AC-01: DB の %s は message と SQLSTATE の完全一致で表の状態・code・本文にし、SQLSTATE が違えば固定の500', async (code, [sqlstate, status, message]) => {
    rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate, details: 'PRIVATE-MARKER' } });
    const result = await failure(() => updateShipmentSlipTracking(client, 'actor', TRACKING_INPUT));
    expect(result).toMatchObject({ status, code, message });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
    rpc.mockResolvedValue({ data: null, error: { message: code, code: 'XXXXX' } });
    expect(await failure(() => updateShipmentSlipTracking(client, 'actor', TRACKING_INPUT))).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test.each([
    ['空には戻せない', 'GROUP_G_SLIP_TRACKING_INCOMPLETE', 400, '運送会社と伝票番号は、両方入れるか両方空にしてください。'],
    ['変わっていない', 'GROUP_G_SLIP_TRACKING_UNCHANGED', 409, '運送会社も伝票番号も変わっていません。'],
    ['確定前', 'GROUP_G_SLIP_NOT_CONFIRMED', 409, '発送が確定した発送票だけで行える操作です。'],
    ['取消済み', 'GROUP_G_SLIP_CANCELLED', 409, 'この発送票は取り消されています。'],
  ])('FREQ-534-AC-01: 伝票番号の拒否（%s）は固定の状態と本文で、注文番号・氏名・住所・伝票番号を含めない', async (_name, code, status, body) => {
    rpc.mockResolvedValue({ data: null, error: { message: code, code: SHIPMENT_SLIP_ERRORS[code][0], details: 'ORD-PRIVATE 氏名 住所 NEW-456' } });
    const result = await failure(() => updateShipmentSlipTracking(client, 'actor', TRACKING_INPUT));
    expect(result).toMatchObject({ status, code, message: body });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toMatch(/PRIVATE|氏名|住所|NEW-456/);
  });

  test.each([
    ['null', null], ['別の票の答え', { ...TRACKING_UPDATED, id: SLIP_ID_2 }], ['版が無い', { ...TRACKING_UPDATED, version: undefined }],
    ['追跡の版が1', { ...TRACKING_UPDATED, trackingVersion: 1 }], ['追跡の版が無い', { ...TRACKING_UPDATED, trackingVersion: undefined }],
    ['replayedが文字', { ...TRACKING_UPDATED, replayed: 'false' }], ['idが崩れている', { ...TRACKING_UPDATED, id: 'PRIVATE-MARKER' }],
  ])('FREQ-534-AC-01: 崩れた戻り（%s）は固定の500で、中身を出さない', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const result = await failure(() => updateShipmentSlipTracking(client, 'actor', TRACKING_INPUT));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-534-AC-01: 表に載せない誤りと通信の失敗は生の文を出さない固定の500', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_SHIPMENT_CONSUMPTION', code: '23514', details: 'PRIVATE-MARKER' } });
    expect(await failure(() => updateShipmentSlipTracking(client, 'actor', TRACKING_INPUT))).toMatchObject({ status: 500, code: undefined, message: FAILED });
    rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await failure(() => updateShipmentSlipTracking(client, 'actor', TRACKING_INPUT));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });
});

const DELIVERED = { id: SLIP_ID, version: 3, deliveredAt: '2026-10-25T03:00:00.000Z', replayed: false };
const DELIVERED_INPUT = { slipId: SLIP_ID, expectedVersion: 2, deliveredOn: '2026-10-25', notifyCustomer: true, requestKey: REQUEST_KEY };
describe('markShipmentSlipDelivered', () => {
  test('FREQ-534-AC-02: admin_mark_shipment_slip_delivered を全引数と認可済みの実行者で1回呼び、追加項目を捨てた結果 { id, version, deliveredAt, replayed } を返す', async () => {
    rpc.mockResolvedValue({ data: { ...DELIVERED, secret: 'discard' }, error: null });
    expect(await markShipmentSlipDelivered(client, 'actor-1', DELIVERED_INPUT)).toEqual(DELIVERED);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_mark_shipment_slip_delivered', {
      _slip_id: SLIP_ID, _expected_version: 2, _delivered_on: '2026-10-25', _notify_customer: true, _actor_id: 'actor-1', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-534-AC-02: 同じ要求番号の再送（replayed: true）はそのまま返し、通知オフもそのまま渡す', async () => {
    rpc.mockResolvedValue({ data: { ...DELIVERED, replayed: true }, error: null });
    expect(await markShipmentSlipDelivered(client, 'actor-1', { ...DELIVERED_INPUT, notifyCustomer: false })).toEqual({ ...DELIVERED, replayed: true });
    expect(rpc).toHaveBeenCalledWith('admin_mark_shipment_slip_delivered', expect.objectContaining({ _notify_customer: false }));
  });

  test.each(Object.entries(SHIPMENT_SLIP_ERRORS))('FREQ-534-AC-02: DB の %s は message と SQLSTATE の完全一致で表の状態・code・本文にし、SQLSTATE が違えば固定の500', async (code, [sqlstate, status, message]) => {
    rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate, details: 'PRIVATE-MARKER' } });
    const result = await failure(() => markShipmentSlipDelivered(client, 'actor', DELIVERED_INPUT));
    expect(result).toMatchObject({ status, code, message });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
    rpc.mockResolvedValue({ data: null, error: { message: code, code: 'XXXXX' } });
    expect(await failure(() => markShipmentSlipDelivered(client, 'actor', DELIVERED_INPUT))).toMatchObject({ status: 500, code: undefined, message: FAILED });
  });

  test.each([
    ['すでに配達済み', 'GROUP_G_SLIP_ALREADY_DELIVERED', 409, 'この発送票はすでに配達済みです。'],
    ['届いた日が範囲外', 'GROUP_G_SLIP_DELIVERY_DATE_INVALID', 400, '届いた日は、発送した日から今日までの日付にしてください。'],
    ['確定前', 'GROUP_G_SLIP_NOT_CONFIRMED', 409, '発送が確定した発送票だけで行える操作です。'],
    ['取消済み', 'GROUP_G_SLIP_CANCELLED', 409, 'この発送票は取り消されています。'],
  ])('FREQ-534-AC-02: 配達済みの拒否（%s）は固定の状態と本文で、注文番号・氏名・住所を含めない', async (_name, code, status, body) => {
    rpc.mockResolvedValue({ data: null, error: { message: code, code: SHIPMENT_SLIP_ERRORS[code][0], details: 'ORD-PRIVATE 氏名 住所' } });
    const result = await failure(() => markShipmentSlipDelivered(client, 'actor', DELIVERED_INPUT));
    expect(result).toMatchObject({ status, code, message: body });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toMatch(/PRIVATE|氏名|住所/);
  });

  test.each([
    ['null', null], ['別の票の答え', { ...DELIVERED, id: SLIP_ID_2 }], ['版が無い', { ...DELIVERED, version: undefined }],
    ['届いた時刻が無い', { ...DELIVERED, deliveredAt: undefined }], ['届いた時刻が読めない', { ...DELIVERED, deliveredAt: 'not a date' }],
    ['replayedが文字', { ...DELIVERED, replayed: 'false' }], ['idが崩れている', { ...DELIVERED, id: 'PRIVATE-MARKER' }],
  ])('FREQ-534-AC-02: 崩れた戻り（%s）は固定の500で、中身を出さない', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const result = await failure(() => markShipmentSlipDelivered(client, 'actor', DELIVERED_INPUT));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-534-AC-02: 表に載せない誤りと通信の失敗は生の文を出さない固定の500', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_SHIPMENT_CONSUMPTION', code: '23514', details: 'PRIVATE-MARKER' } });
    expect(await failure(() => markShipmentSlipDelivered(client, 'actor', DELIVERED_INPUT))).toMatchObject({ status: 500, code: undefined, message: FAILED });
    rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await failure(() => markShipmentSlipDelivered(client, 'actor', DELIVERED_INPUT));
    expect(result).toMatchObject({ status: 500, code: undefined, message: FAILED });
    expect(inspect(result.error, { depth: null, showHidden: true })).not.toContain('PRIVATE-MARKER');
  });
});
