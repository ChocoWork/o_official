/** @jest-environment node */
/**
 * G-1 Task 17: E2E の材料の道具が G-1 の取引の約束どおりに SQL を流すかを、偽の DB（本物の接続なし）で確かめる。
 * paid=A・未入金=H、注文と割当が1つの取引（BEGIN → 共通の鍵 → … → COMMIT）、台帳の purchase / restock を直に書かない、
 * 失敗で ROLLBACK、既存の引数と戻りの形、手元以外の拒否、止めた2つの道具の固定の拒否。
 */
jest.mock('pg', () => ({ Client: jest.fn() }));
jest.mock('@playwright/test', () => ({ expect: jest.fn(), test: { extend: jest.fn() } }));
jest.mock('../../../e2e/member-session-helpers', () => ({ createTestMember: jest.fn(), loginAsMember: jest.fn() }));

import {
  allocationKindOf,
  legacyFulfillmentDisabled,
  seedE2eRestock,
} from '../../../e2e/group-g1-test-utils';
import { createFulfillment, createOrderWithLines } from '../../../e2e/order-email-test-utils';
import { addVariant, createShippedOrder } from '../../../e2e/return-test-utils';
import { editTrackingInDb, markDeliveredInDb } from '../../../e2e/delivery-tracking-test-utils';
import type { PgClient } from '../../integration/db/helpers/local-db';

type Row = Record<string, unknown>;

/** SQL を1行の小文字にして記録し、道具が読む行だけを返す偽の DB */
class FakeDb {
  host = '127.0.0.1';
  calls: Array<{ sql: string; params: unknown[] }> = [];
  failOn: RegExp | null = null;
  private inTransaction = false;
  private locked = false;
  private orderItems = 0;
  private allocations = 0;
  orderStatus = 'shipped';
  unshipped = 0;
  paidRemaining = 0;

  constructor(options: { host?: string } = {}) {
    if (options.host) this.host = options.host;
  }

  query = async (text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> => {
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    this.calls.push({ sql, params });
    if (this.failOn?.test(sql)) throw new Error('INJECTED_FAILURE');
    const rows = (value: Row[]) => ({ rows: value, rowCount: value.length });
    if (sql.includes('statement_timestamp() <> pg_catalog.transaction_timestamp()')) return rows([{ in_transaction: this.inTransaction }]);
    if (sql === 'begin') { this.inTransaction = true; return rows([]); }
    if (sql === 'commit' || sql === 'rollback') { this.inTransaction = false; this.locked = false; return rows([]); }
    if (sql.includes('pg_advisory_xact_lock(190521,1)')) { this.locked = true; return rows([]); }
    if (sql.includes('from pg_catalog.pg_locks')) return rows([{ held: this.locked }]);
    if (sql.startsWith('insert into public.items ')) return rows([{ id: 101 }]);
    if (sql.startsWith('insert into public.item_colors')) return rows([{ id: 11 }]);
    if (sql.startsWith('insert into public.item_sizes')) return rows([{ id: 12 }]);
    if (sql.startsWith('insert into public.item_variants')) return rows([{ id: 201 }]);
    if (sql.includes('from public.user_roles as ur')) return rows([]);
    if (sql.startsWith('insert into auth.users')) return rows([{ id: 'actor-1' }]);
    if (sql.startsWith('insert into public.user_roles')) return { rows: [], rowCount: 1 };
    if (sql.includes('public.admin_record_stock_movement(')) return rows([{ result: { movementId: '9001' } }]);
    if (sql.startsWith('insert into public.orders')) return rows([{ id: 'order-1' }]);
    if (sql.startsWith('insert into public.order_items')) return rows([{ id: `item-${++this.orderItems}` }]);
    if (sql.startsWith('select order_id,variant_id from public.order_items')) return rows([{ order_id: 'order-1', variant_id: 201 }]);
    if (sql.startsWith('select order_id from public.order_items')) return rows([{ order_id: 'order-1' }]);
    if (sql.includes('capture_group_g_item_states')) return rows([{ states: {} }]);
    if (sql.startsWith('insert into public.stock_movements')) return rows([{ id: 5001 }]);
    if (sql.startsWith('insert into public.order_item_allocations')) return rows([{ id: `alloc-${++this.allocations}` }]);
    if (sql.includes('release_stock_for_unpaid_order')) return rows([{ released: true, status: params[1] }]);
    if (sql === 'select now() as t') return rows([{ t: new Date('2026-10-24T00:00:00.000Z') }]);
    if (sql.includes('private.order_line_fulfillment')) return rows([{ n: this.unshipped }]);
    if (sql.startsWith('select id,remaining_quantity from public.order_item_allocations')) {
      return rows(this.paidRemaining > 0 ? [{ id: 'alloc-1', remaining_quantity: this.paidRemaining }] : []);
    }
    if (sql.startsWith('insert into public.order_fulfillments')) return rows([{ id: 'fulfillment-1' }]);
    if (sql.startsWith('select f.number, o.status::text as order_status')) return rows([{ number: 1, order_status: this.orderStatus }]);
    if (sql.includes("current_setting('app.order_change_reason', true), '') as reason,")) return rows([{ reason: '', actor: '' }]);
    return rows([]);
  };

  end = async () => undefined;

  get client(): PgClient {
    return this as unknown as PgClient;
  }

  index(pattern: RegExp): number {
    return this.calls.findIndex((call) => pattern.test(call.sql));
  }

  all(pattern: RegExp): Array<{ sql: string; params: unknown[] }> {
    return this.calls.filter((call) => pattern.test(call.sql));
  }
}

const ALLOCATION = /^insert into public\.order_item_allocations/;
const RESTOCK = /public\.admin_record_stock_movement\(/;

/** 台帳への直の書込みは、割当の材料（operation の直後の purchase で、割当の操作の番号つき）だけ */
function expectNoDirectLedgerWrites(db: FakeDb): void {
  const writes = db.all(/^insert into public\.stock_movements/);
  for (const write of writes) {
    expect(write.sql).toContain("'purchase'");
    expect(write.sql).toContain('allocation_operation_id');
  }
  expect(writes).toHaveLength(db.all(ALLOCATION).length);
  expect(db.all(/'restock'/).filter((call) => !RESTOCK.test(call.sql))).toEqual([]);
}

describe('allocationKindOf', () => {
  it('入金済みは A、未入金は H、ほかの状態は断る', () => {
    expect(allocationKindOf('paid')).toBe('paid');
    expect(allocationKindOf('pending')).toBe('payment_hold');
    expect(allocationKindOf('payment_in_progress')).toBe('payment_hold');
    expect(() => allocationKindOf('shipped')).toThrow('GROUP_G_ARGUMENT_INVALID');
  });
});

describe('createOrderWithLines（注文と割当を同じ G-1 の取引で作る）', () => {
  it('入金済みの在庫の明細は A を作り、入荷は本物の入口だけ。受注生産の明細は割り当てない。順序は BEGIN → 鍵 → 入荷 → 押さえ → 注文 → 割当 → COMMIT', async () => {
    const db = new FakeDb();
    const order = await createOrderWithLines(db.client, 'buyer@example.com', [
      { name: '在庫のシャツ', quantity: 2, fulfillmentType: 'stock' },
      { name: '受注生産のコート', quantity: 1, fulfillmentType: 'backorder' },
    ]);

    expect(order).toEqual({ orderId: 'order-1', orderItemIds: ['item-1', 'item-2'], itemId: 101, variantId: 201, totalAmount: 15000 });
    expect(db.calls[1].sql).toBe('begin');
    expect(db.calls[2].sql).toContain('pg_advisory_xact_lock(190521,1)');
    expect(db.all(/^begin$/)).toHaveLength(1);
    expect(db.all(/^commit$/)).toHaveLength(1);
    expect(db.calls[db.calls.length - 1].sql).toBe('commit');
    const restocks = db.all(RESTOCK);
    expect(restocks).toHaveLength(1);
    expect(restocks[0].params.slice(0, 3)).toEqual([101, 201, 2]);
    const lock = db.index(/private\.lock_group_g_inventory/);
    expect(db.calls[lock].params).toEqual([[201], []]);
    expect(db.index(RESTOCK)).toBeLessThan(lock);
    expect(lock).toBeLessThan(db.index(/^insert into public\.orders/));
    const allocations = db.all(ALLOCATION);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].params).toEqual(['item-1', 201, 2, 'paid', expect.any(String)]);
    expect(db.index(/^insert into public\.orders/)).toBeLessThan(db.index(ALLOCATION));
    expect(db.all(/^insert into public\.orders/)[0].params[3]).toBe('paid');
    expectNoDirectLedgerWrites(db);
  });

  it('未入金（pending）の在庫の明細は H を作る', async () => {
    const db = new FakeDb();
    await createOrderWithLines(db.client, 'buyer@example.com', [{ name: 'シャツ', quantity: 3, fulfillmentType: 'stock' }], { status: 'pending' });
    const allocations = db.all(ALLOCATION);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].params.slice(2, 4)).toEqual([3, 'payment_hold']);
    expectNoDirectLedgerWrites(db);
  });

  it('取消の材料は、支払い手続き中で H を作り、同じ取引の本物の解放で取消にしてから COMMIT する', async () => {
    const db = new FakeDb();
    await createOrderWithLines(db.client, 'buyer@example.com', [{ name: 'シャツ', quantity: 1, fulfillmentType: 'stock' }], { status: 'cancelled' });
    expect(db.all(/^insert into public\.orders/)[0].params[3]).toBe('payment_in_progress');
    expect(db.all(ALLOCATION)[0].params[3]).toBe('payment_hold');
    const release = db.index(/release_stock_for_unpaid_order/);
    expect(db.calls[release].params.slice(1, 3)).toEqual(['cancelled', 'admin_cancel']);
    expect(db.index(ALLOCATION)).toBeLessThan(release);
    expect(release).toBeLessThan(db.index(/^commit$/));
    expect(db.all(/^update public\.orders/)).toEqual([]);
  });

  it('在庫を確保し直せなかった注文（stock_not_reserved）は意図した不足: 入荷も割当もしない', async () => {
    const db = new FakeDb();
    await createOrderWithLines(db.client, 'buyer@example.com', [{ name: 'シャツ', quantity: 2, fulfillmentType: 'stock' }],
      { reviewReason: 'stock_not_reserved' });
    expect(db.all(RESTOCK)).toEqual([]);
    expect(db.all(ALLOCATION)).toEqual([]);
  });

  it('割当の途中で失敗すると取引ごと ROLLBACK し、失敗を投げ直す（COMMIT しない）', async () => {
    const db = new FakeDb();
    db.failOn = ALLOCATION;
    await expect(createOrderWithLines(db.client, 'buyer@example.com', [{ name: 'シャツ', quantity: 1, fulfillmentType: 'stock' }]))
      .rejects.toThrow('INJECTED_FAILURE');
    expect(db.all(/^rollback to savepoint/).length).toBeGreaterThan(0);
    expect(db.calls[db.calls.length - 1].sql).toBe('rollback');
    expect(db.all(/^commit$/)).toEqual([]);
  });

  it('手元（localhost / 127.0.0.1）以外の DB では、何も問い合わせずに止める', async () => {
    const db = new FakeDb({ host: 'db.example.com' });
    await expect(createOrderWithLines(db.client, 'buyer@example.com', [{ name: 'シャツ', quantity: 1, fulfillmentType: 'stock' }]))
      .rejects.toThrow('GROUP_G_FIXTURE_LOCAL_DB_REQUIRED');
    await expect(seedE2eRestock(db.client, { itemId: 1, variantId: 1, quantity: 1 })).rejects.toThrow('GROUP_G_FIXTURE_LOCAL_DB_REQUIRED');
    expect(db.calls).toEqual([]);
  });
});

describe('createFulfillment（旧の発送の関数を呼ばず、A を消費する合成の発送）', () => {
  it('既存の引数のまま E2eFulfillment の形を返し、最後の1点なら注文を発送済みの写しにする', async () => {
    const db = new FakeDb();
    db.unshipped = 2;
    db.paidRemaining = 2;
    const shipment = await createFulfillment(db.client, 'order-1', 'actor-1', {
      lines: [{ orderItemId: 'item-1', quantity: 2 }], trackingNumber: 'E2E-1', notify: false,
    });
    expect(shipment).toEqual({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false });
    expect(db.all(/admin_create_fulfillment\(/)).toEqual([]);
    expect(db.calls[db.index(/private\.lock_group_g_inventory/)].params).toEqual([[], ['order-1']]);
    expect(db.index(/private\.lock_group_g_inventory/)).toBeLessThan(db.index(/^update public\.order_item_allocations/));
    expect(db.all(/^insert into public\.order_item_allocation_events/)[0].sql).toContain("'consume'");
    const shipped = db.index(/^update public\.orders set status = 'shipped'/);
    expect(shipped).toBeGreaterThan(-1);
    expect(db.calls[shipped - 1].sql).toContain("'app.order_actor_id'");
    expect(db.calls[shipped - 2].sql).toContain("'app.order_change_reason', 'admin_create_fulfillment'");
    expect(db.all(/enqueue_order_email/)).toEqual([]);
    expectNoDirectLedgerWrites(db);
  });

  it('A が足りなければ材料の失敗にし、入荷や purchase で補わない', async () => {
    const db = new FakeDb();
    db.unshipped = 1;
    await expect(createFulfillment(db.client, 'order-1', 'actor-1', { lines: [{ orderItemId: 'item-1', quantity: 1 }], trackingNumber: 'E2E-1' }))
      .rejects.toThrow('GROUP_G_FIXTURE_ALLOCATION_REQUIRED');
    expect(db.all(RESTOCK)).toEqual([]);
    expect(db.all(/^insert into public\.stock_movements/)).toEqual([]);
    expect(db.calls[db.calls.length - 1].sql).toBe('rollback');
  });
});

describe('上位の道具も同じ取引を使う', () => {
  it('createShippedOrder は注文・割当・発送を1つの取引で作る（注文だけ先に COMMIT しない）', async () => {
    const db = new FakeDb();
    db.unshipped = 1;
    db.paidRemaining = 1;
    const fixture = await createShippedOrder(db.client, 'label', [{ name: 'シャツ', quantity: 1, fulfillmentType: 'stock' }]);
    expect(fixture).toEqual(expect.objectContaining({
      orderId: 'order-1', actorId: 'actor-1', itemId: 101, variantId: 201, orderItemIds: ['item-1'],
      fulfillmentId: 'fulfillment-1', fulfillmentIds: ['fulfillment-1'],
    }));
    expect(db.all(/^begin$/)).toHaveLength(1);
    expect(db.all(/^commit$/)).toHaveLength(1);
    expect(db.index(/^insert into public\.order_fulfillments/)).toBeLessThan(db.index(/^commit$/));
    expect(db.index(/^update public\.shop_return_settings/)).toBeLessThan(db.index(/^begin$/));
    expectNoDirectLedgerWrites(db);
  });

  it('addVariant の在庫は本物の入荷の入口で入れ、台帳に直に restock を書かない', async () => {
    const db = new FakeDb();
    expect(await addVariant(db.client, 101, { color: 'ネイビー', size: 'L', stock: 3 })).toBe(201);
    const restocks = db.all(RESTOCK);
    expect(restocks).toHaveLength(1);
    expect(restocks[0].params.slice(0, 3)).toEqual([101, 201, 3]);
    expect(db.index(/^insert into public\.item_variants/)).toBeLessThan(db.index(RESTOCK));
    expectNoDirectLedgerWrites(db);
  });
});

describe('止めた旧の発送の操作', () => {
  it('markDeliveredInDb と editTrackingInDb は DB に触れずに LEGACY_FULFILLMENT_DISABLED で断る', async () => {
    const db = new FakeDb();
    const target = { orderId: 'order-1', fulfillmentId: 'fulfillment-1', actorId: 'actor-1' };
    await expect(markDeliveredInDb(db.client, { ...target, deliveredOn: '2026-10-24', notify: false }))
      .rejects.toMatchObject({ message: 'LEGACY_FULFILLMENT_DISABLED', code: '55000' });
    await expect(editTrackingInDb(db.client, { ...target, carrier: 'yamato', trackingNumber: 'E2E-2', notify: false }))
      .rejects.toMatchObject({ message: 'LEGACY_FULFILLMENT_DISABLED', code: '55000' });
    expect(() => legacyFulfillmentDisabled()).toThrow('LEGACY_FULFILLMENT_DISABLED');
    expect(db.calls).toEqual([]);
  });
});
