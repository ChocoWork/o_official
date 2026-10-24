/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import { calcRequiredQuantity, type AdminInventoryRow } from '@/lib/inventory/inventory-list-types';
import { AdminInventoryError, listAdminInventory } from '@/lib/inventory/inventory-list-store';

const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;

// 注文数5・在庫2（空き0・入金済みの割当2・仮確保0）・発注済み1 → 発注必要数2
const dbRow = {
  variant_id: 11, item_id: 7, item_name: 'シャツ', color_name: 'BLACK', size_label: 'M', is_active: true,
  free: 0, paid_allocated: 2, payment_held: 0, on_hand: 2, order_quantity: 5, on_order: 1, required: 2,
};
const mapped: AdminInventoryRow = {
  variantId: 11, itemId: 7, itemName: 'シャツ', colorName: 'BLACK', sizeLabel: 'M', isActive: true,
  free: 0, paidAllocated: 2, paymentHeld: 0, onHand: 2, orderQuantity: 5, onOrder: 1, required: 2,
};

beforeEach(() => rpc.mockReset());

describe('calcRequiredQuantity', () => {
  test('FREQ-525-AC-01: 注文数5・在庫2・発注済み1 の発注必要数は2', () => {
    expect(calcRequiredQuantity(5, 2, 1)).toBe(2);
  });

  test('FREQ-525-AC-01: 在庫と発注済みが注文数を超えても発注必要数は0未満にならない', () => {
    expect(calcRequiredQuantity(5, 4, 3)).toBe(0);
    expect(calcRequiredQuantity(0, 0, 0)).toBe(0);
    expect(calcRequiredQuantity(1, 10, 10)).toBe(0);
  });

  test('FREQ-525-AC-01: 在庫も発注済みも無ければ注文数がそのまま発注必要数になる', () => {
    expect(calcRequiredQuantity(5, 0, 0)).toBe(5);
  });
});

describe('listAdminInventory', () => {
  test('FREQ-525-AC-01: RPC を実行者つきで1回だけ呼び、列を画面の形へ写す（backfill は呼ばない）', async () => {
    rpc.mockResolvedValue({ data: [dbRow], error: null });
    await expect(listAdminInventory(client, 'actor-1')).resolves.toEqual([mapped]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_admin_inventory', { _actor_id: 'actor-1' });
  });

  test('FREQ-525-AC-01: 色・サイズの無い variant は null のまま通し、DB の並びを変えない', async () => {
    const second = { ...dbRow, variant_id: 12, color_name: null, size_label: null, is_active: false };
    rpc.mockResolvedValue({ data: [second, dbRow], error: null });
    const rows = await listAdminInventory(client, 'actor-1');
    expect(rows.map((row) => row.variantId)).toEqual([12, 11]);
    expect(rows[0]).toMatchObject({ colorName: null, sizeLabel: null, isActive: false });
  });

  test('FREQ-525-AC-01: 行が無ければ空の配列', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(listAdminInventory(client, 'actor-1')).resolves.toEqual([]);
  });

  test.each([
    ['onHand が free + paidAllocated + paymentHeld と違う', { on_hand: 3 }],
    ['required が式と違う', { required: 3 }],
    ['required が負', { required: -1, order_quantity: 0, on_order: 5 }],
    ['free が負', { free: -1, on_hand: 1 }],
    ['注文数が小数', { order_quantity: 5.5 }],
    ['発注済みが文字列', { on_order: '1' }],
    ['発注済みが負', { on_order: -1, required: 4 }],
    ['注文数が上限超え', { order_quantity: 2147483648 }],
    ['variant_id が0', { variant_id: 0 }],
    ['variant_id が文字列', { variant_id: '11' }],
    ['item_name が無い', { item_name: undefined }],
    ['color_name が数', { color_name: 1 }],
    ['is_active が真偽でない', { is_active: 'true' }],
  ])('FREQ-525-AC-01: 崩れた行は INVENTORY_READ_FAILED で止める: %s', async (_name, patch) => {
    rpc.mockResolvedValue({ data: [{ ...dbRow, ...patch }], error: null });
    await expect(listAdminInventory(client, 'actor-1')).rejects.toThrow('INVENTORY_READ_FAILED');
  });

  test.each([
    ['null', null], ['オブジェクト', {}], ['null の行', [null]], ['同じ variant の重複', [dbRow, dbRow]],
  ])('FREQ-525-AC-01: 配列でない・行が壊れている・重複する応答は INVENTORY_READ_FAILED: %s', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(listAdminInventory(client, 'actor-1')).rejects.toThrow('INVENTORY_READ_FAILED');
  });

  test('FREQ-540-AC-07: DB の GROUP_G_FORBIDDEN / 42501 の組だけを 403 の AdminInventoryError にする', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER' } });
    const error = await listAdminInventory(client, 'actor-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminInventoryError);
    expect(error).toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN', message: '在庫一覧を見る権限がありません。' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');

    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '23514' } });
    await expect(listAdminInventory(client, 'actor-1')).rejects.toThrow('INVENTORY_READ_FAILED');
    rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '42501' } });
    await expect(listAdminInventory(client, 'actor-1')).rejects.toThrow('INVENTORY_READ_FAILED');
  });

  test('FREQ-525-AC-01: 通信の失敗・DB の他の誤りは固定の文だけで、生の文も cause も持ち出さない', async () => {
    for (const action of ['throw', 'error']) {
      if (action === 'throw') rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
      else rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'PRIVATE-MARKER', details: 'PRIVATE-MARKER' } });
      const error = await listAdminInventory(client, 'actor-1').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AdminInventoryError);
      expect((error as Error).message).toBe('INVENTORY_READ_FAILED');
      expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
      expect(error).not.toHaveProperty('cause');
    }
  });
});
