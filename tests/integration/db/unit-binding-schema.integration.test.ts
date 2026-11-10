/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { acceptHCheckout, hDiscount, hFailure, seedHCheckout, seedHDiscount, seedHMember, seedHOrderUnits } from './helpers/group-h-fixtures';
import { createCatalogFixture } from './helpers/order-fixtures';

const directory = path.join(process.cwd(), 'supabase', 'migrations');
const file = fs.readdirSync(directory).find((name) => name.endsWith('_unit_binding_schema.sql'));
const sql = file ? fs.readFileSync(path.join(directory, file), 'utf8') : '';

const TABLES = ['order_discount_snapshots', 'order_unit_slots', 'order_unit_exchange_links', 'order_unit_events',
  'order_unit_event_lines', 'order_unit_holds', 'order_unit_event_refunds', 'order_return_line_treatments'];

describe('FREQ-642-AC-20: unit binding migration A source contract', () => {
  test('FREQ-642-AC-20: 移行Aは単一取引・ASCII・LF・末尾の確かめを持つ', () => {
    expect(file).toBeDefined();
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(sql).toContain('UNIT_BINDING_SCHEMA_MIGRATION_ASSERTION_FAILED');
    for (const detail of ['ub_tables', 'ub_acl', 'ub_functions', 'ub_settings']) expect(sql).toContain(`'${detail}'`);
  });
});

describeLocalDb('FREQ-642-AC-20: unit binding schema (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  type Context = { facts: { priorUnitsByItem: Record<string, number> } };
  const priorUnits = async (userId: string, itemId: number): Promise<number> => {
    const row = (await db().query("select public.get_checkout_discount_context($1,null,'{}',$2,now(),'confirm') j", [userId, [itemId]])).rows[0].j as Context;
    return row.facts.priorUnitsByItem[String(itemId)] ?? 0;
  };

  /** A member buys `quantity` units of one jacket through the real acceptance entry (the copy function writes the slots). */
  async function buyJacket(userId: string, catalog: Awaited<ReturnType<typeof createCatalogFixture>>, quantity: number, discountId?: string, code?: string) {
    const f = await seedHCheckout(db(), { discountId, code, userId, lines: [{ catalog, quantity }] });
    const row = await acceptHCheckout(db(), f);
    expect(row).toMatchObject({ created: true, rejection: null });
    // The prior-units count reads the member's paid orders.
    await db().query("select * from public.mark_order_paid($1,'payment_in_progress',$3,$2,'jpy',true,'payment_received')", [row.order_id, f.result.totalAmount, f.paymentIntentId]);
    const items = (await db().query("select id from public.order_items where order_id=$1 and line_kind='order'", [row.order_id])).rows;
    return { f, orderId: row.order_id as string, orderItemId: items[0].id as string };
  }

  test('FREQ-642-AC-20: 写しはHの注文に1行、枠は着の数だけ作られる', async () => {
    const userId = await seedHMember(db()); const catalog = await createCatalogFixture(db()); const code = `UB-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, kind: 'repeat', targetMode: 'include', itemIds: [catalog.itemId], repeatInOrder: true, value: { type: 'amount', value: 3000 }, minimum: { type: 'amount', value: 4000 } }));
    const order = await buyJacket(userId, catalog, 2, id, code);
    const snapshots = (await db().query('select * from public.order_discount_snapshots where order_id=$1', [order.orderId])).rows;
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    expect(snapshot.engine_version).toBe(1);
    expect(snapshot.definitions.map((d: { kind: string }) => d.kind)).toEqual(['repeat']);
    expect(snapshot.codes).toEqual([code]);
    expect(snapshot.facts.priorUnitsByItem).toEqual({});
    expect(snapshot.lines).toEqual([expect.objectContaining({ orderItemId: order.orderItemId, itemId: catalog.itemId, unitPrice: 20000, quantity: 2 })]);
    const slots = (await db().query('select * from public.order_unit_slots where order_id=$1 order by unit_index', [order.orderId])).rows;
    expect(slots.map(s => [s.unit_index, s.state, s.current_price])).toEqual([[0, 'kept', 20000], [1, 'kept', 17000]]);
    const units = (await db().query('select unit_index,paid_amount from public.order_line_unit_amounts where order_id=$1 order by unit_index', [order.orderId])).rows;
    expect(slots.map(s => s.current_price)).toEqual(units.map(u => u.paid_amount));
    expect(slots.every(s => s.holder_order_item_id === order.orderItemId && s.holder_unit_index === s.unit_index && s.last_event_id === null && Number(s.item_id) === catalog.itemId)).toBe(true);
  });

  test('FREQ-642-AC-20: 割引なしの注文も写しは1行（definitions と codes は空）で枠は作られる', async () => {
    const userId = await seedHMember(db()); const catalog = await createCatalogFixture(db());
    const order = await buyJacket(userId, catalog, 2);
    const snapshot = (await db().query('select * from public.order_discount_snapshots where order_id=$1', [order.orderId])).rows[0];
    expect(snapshot.definitions).toEqual([]);
    expect(snapshot.codes).toEqual([]);
    expect((await db().query('select count(*)::int n from public.order_unit_slots where order_id=$1', [order.orderId])).rows[0].n).toBe(2);
  });

  test('FREQ-642-AC-20: 写しと枠が無い古い注文は今の数え方のまま', async () => {
    const userId = await seedHMember(db());
    const old = await seedHOrderUnits(db(), { legacy: true, buyerUserId: userId, lines: [{ itemPrice: 1000, quantity: 3, discounts: [], unitAmounts: [] }] });
    const itemId = Number((await db().query('select item_id from public.order_items where id=$1', [old.orderItemIds[0]])).rows[0].item_id);
    expect(await priorUnits(userId, itemId)).toBe(3);
  });

  test('FREQ-642-AC-16: 前の注文の着数は手元にある（kept）枠の数。交換の品を全部返金した後は0', async () => {
    const userId = await seedHMember(db()); const catalog = await createCatalogFixture(db());
    const order = await buyJacket(userId, catalog, 1);
    expect(await priorUnits(userId, catalog.itemId)).toBe(1);
    // The slot tool: the receive/refund functions (later tasks) move a slot out of 'kept'; here the owner of the table does it.
    await db().query("update public.order_unit_slots set state='returned_customer' where order_item_id=$1", [order.orderItemId]);
    expect(await priorUnits(userId, catalog.itemId)).toBe(0);
  });

  test('FREQ-642-AC-16: お店の側で返した枠も数えず、枠の無い古い注文は今の式で足す', async () => {
    const userId = await seedHMember(db()); const catalog = await createCatalogFixture(db());
    const order = await buyJacket(userId, catalog, 2);
    await db().query("update public.order_unit_slots set state='returned_shop' where order_item_id=$1 and unit_index=0", [order.orderItemId]);
    expect(await priorUnits(userId, catalog.itemId)).toBe(1);
    const old = await seedHOrderUnits(db(), { legacy: true, buyerUserId: userId, lines: [{ itemPrice: 20000, quantity: 2, discounts: [], unitAmounts: [], catalog }] });
    expect(old.orderItemIds).toHaveLength(1);
    expect(await priorUnits(userId, catalog.itemId)).toBe(3);
  });

  test('FREQ-642-AC-30: 初期不良と誤送のご希望は交換だけ', async () => {
    const rows = (await db().query("select reason,resolutions from public.shop_return_reason_settings where reason in ('defective','wrong_item') order by reason")).rows;
    expect(rows).toEqual([{ reason: 'defective', resolutions: 'exchange_only' }, { reason: 'wrong_item', resolutions: 'exchange_only' }]);
    const others = (await db().query("select reason,resolutions from public.shop_return_reason_settings where reason in ('size_too_small','size_too_large') order by reason")).rows;
    expect(others.every(r => r.resolutions === 'exchange_only')).toBe(true);
  });

  test('FREQ-642-AC-20: 新しい8つの表はRLS・service_roleはSELECTだけ・利用者から読めない', async () => {
    const acl = (await db().query(`select c.relname, c.relrowsecurity rls,
        has_table_privilege('service_role',c.oid,'SELECT') s, has_table_privilege('service_role',c.oid,'INSERT') i,
        has_table_privilege('service_role',c.oid,'UPDATE') u, has_table_privilege('service_role',c.oid,'DELETE') d,
        has_table_privilege('anon',c.oid,'SELECT') a, has_table_privilege('authenticated',c.oid,'SELECT') au
      from pg_class c where c.relnamespace='public'::regnamespace and c.relname = any($1) order by c.relname`, [TABLES])).rows;
    expect(acl.map(r => r.relname)).toEqual([...TABLES].sort());
    for (const r of acl) expect(r).toMatchObject({ rls: true, s: true, i: false, u: false, d: false, a: false, au: false });
  });

  test('FREQ-642-AC-20: 枠の更新は利用者に断られ、追記だけの表は更新・削除・全消しを断る', async () => {
    const userId = await seedHMember(db()); const catalog = await createCatalogFixture(db());
    const order = await buyJacket(userId, catalog, 1);
    expect(await hFailure(db(), async () => {
      await db().query('set local role authenticated');
      await db().query("update public.order_unit_slots set state='returned_shop' where order_id=$1", [order.orderId]);
    })).toMatchObject({ code: '42501' });
    const eventId = (await db().query("insert into public.order_unit_events(order_id,kind) values($1,'return_receive') returning id", [order.orderId])).rows[0].id as string;
    expect(await hFailure(db(), () => db().query("update public.order_unit_events set fee_amount=1 where id=$1", [eventId])))
      .toEqual({ code: '55000', message: 'GROUP_H_IMMUTABLE' });
    expect(await hFailure(db(), () => db().query('delete from public.order_unit_events where id=$1', [eventId])))
      .toEqual({ code: '55000', message: 'GROUP_H_IMMUTABLE' });
    expect(await hFailure(db(), () => db().query('truncate public.order_unit_events cascade'))).toEqual({ code: '55000', message: 'GROUP_H_IMMUTABLE' });
    expect(await hFailure(db(), () => db().query('delete from public.order_discount_snapshots where order_id=$1', [order.orderId])))
      .toEqual({ code: '55000', message: 'GROUP_H_IMMUTABLE' });
    expect(await hFailure(db(), () => db().query('delete from public.order_unit_slots where order_id=$1', [order.orderId])))
      .toEqual({ code: '55000', message: 'GROUP_H_IMMUTABLE' });
  });

  test('FREQ-642-AC-20: 出来事の合計の式と状態の値はCHECKで守られる', async () => {
    const userId = await seedHMember(db()); const catalog = await createCatalogFixture(db());
    const order = await buyJacket(userId, catalog, 1);
    expect(await hFailure(db(), () => db().query(`insert into public.order_unit_events(order_id,kind,standard_refund,now_refund,consult_refund)
      values($1,'return_receive',100,60,30)`, [order.orderId]))).toMatchObject({ code: '23514' });
    expect(await hFailure(db(), () => db().query("insert into public.order_unit_events(order_id,kind) values($1,'bogus')", [order.orderId])))
      .toMatchObject({ code: '23514' });
    expect(await hFailure(db(), () => db().query("update public.order_unit_slots set state='bogus' where order_id=$1", [order.orderId])))
      .toMatchObject({ code: '23514' });
    expect(await hFailure(db(), () => db().query("update public.order_unit_slots set current_price=-1 where order_id=$1", [order.orderId])))
      .toMatchObject({ code: '23514' });
  });
});

const ubAssert = sql.split('-- UB_FINAL_ASSERT_BEGIN\n')[1]?.split('-- UB_FINAL_ASSERT_END')[0] ?? '';

describeLocalDb('FREQ-642-AC-20: unit binding migration A final assertion (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  type Failure = { code?: string; message?: string; detail?: string };
  async function attempt(change = ''): Promise<Failure | null> {
    await db().query('savepoint ub_assert');
    let failure: Failure | null = null;
    try { if (change) await db().query(change); await db().query(ubAssert); }
    catch (caught) { const e = caught as Failure; failure = { code: e.code, message: e.message, detail: e.detail }; }
    finally { await db().query('rollback to savepoint ub_assert'); await db().query('release savepoint ub_assert'); }
    return failure;
  }
  const replaceBody = (signature: string, from: string, to: string) => `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), '${from}', '${to}'); end $x$`;

  test('FREQ-642-AC-20: 末尾の確かめは改変なしで通る', async () => {
    expect(ubAssert).not.toBe('');
    expect(await attempt()).toBeNull();
  });

  test.each([
    ['alter table public.order_unit_events disable trigger ub_order_unit_events_immutable', 'ub_tables'],
    ['alter table public.order_unit_slots add column extra integer', 'ub_tables'],
    ['create trigger ub_x before update on public.order_unit_slots for each row execute function private.group_h_immutable()', 'ub_tables'],
    ['alter table public.order_unit_events drop constraint order_unit_events_refund_split_check', 'ub_tables'],
    ['grant insert on public.order_unit_slots to service_role', 'ub_acl'],
    ['grant select on public.order_unit_events to authenticated', 'ub_acl'],
    ['alter table public.order_unit_holds disable row level security', 'ub_acl'],
    ['grant execute on function private.group_h_copy_order_discounts(uuid,uuid,jsonb) to service_role', 'ub_acl'],
    [replaceBody('private.group_h_copy_order_discounts(uuid,uuid,jsonb)', 'order_unit_slots', 'order_unit_slotz'), 'ub_functions'],
    [replaceBody('private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text)', "s.state=''kept''", "s.state=''kept'' OR true"), 'ub_functions'],
    ["update public.shop_return_reason_settings set resolutions='refund_and_exchange' where reason='defective'", 'ub_settings'],
    ["update public.shop_return_reason_settings set resolutions='refund_only' where reason='wrong_item'", 'ub_settings'],
  ])('FREQ-642-AC-20: 改変 %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'UNIT_BINDING_SCHEMA_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
