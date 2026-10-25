/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

import type { SupabaseClient } from '@supabase/supabase-js';
import { inspect } from 'util';
import {
  classify,
  getAdminShipmentSlip,
  listAdminOrderShipmentSlips,
  listAdminPacking,
  listAdminShipmentSlips,
  ShipmentSlipError,
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
