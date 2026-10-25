/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { createCatalogFixture, insertOrderWithLines } from './helpers/order-fixtures';
import { seedGroupG1Allocation, seedGroupG1Shipment, restoreGroupG1Shipment, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { seedGroupG3ReadyOrder, seedGroupG3Slip, attachGroupG3SlipShipment, withRolePermissions,
  seedGroupG3MissingVariantAllocation } from './helpers/group-g3-fixtures';
import { insertDeliveryRegistration } from './helpers/delivery-tracking-fixtures';

jest.setTimeout(60000);
type Packing = { order_id: string; order_item_id: string; ready_quantity: number; shippable_quantity: number;
  blocked_reasons: string[]; other_slip_numbers: string[]; selected_quantity: number | null; bundle_ok: boolean;
  bundle_key: string | null; total_count: string };

describeLocalDb('G-3 packing and shipment-slip reads', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']);
  });
  afterEach(async () => { await db().query('rollback'); });
  const packing = async (slip: string | null = null, limit?: number, offset = 0): Promise<Packing[]> => {
    const query = async (take: number, skip: number): Promise<Packing[]> => (await db().query(
      'select * from public.list_admin_packing($1,$2,$3,$4)', [slip, take, skip, actor])).rows;
    if (limit !== undefined) return query(limit, offset);
    const rows = await query(100, offset);
    const total = Number(rows[0]?.total_count ?? 0);
    while (rows.length + offset < total) {
      const page = await query(100, offset + rows.length);
      if (page.length === 0) throw new Error('G3_PACKING_PAGE_MISSING');
      rows.push(...page);
    }
    return rows;
  };
  const detail = async (id: string) => (await db().query('select public.get_admin_shipment_slip($1,$2) as d', [id, actor])).rows[0].d;
  const ready = (input: Parameters<typeof seedGroupG3ReadyOrder>[1] = {}) => seedGroupG3ReadyOrder(db(), input);
  const draft = (items: { orderItemId: string; quantity: number }[], expired = false) =>
    seedGroupG3Slip(db(), { actorId: actor, draftLines: items, expired });
  const ownRows = (rows: Packing[], ids: string[]) => rows.filter((r) => ids.includes(r.order_id));

  test('FREQ-531-AC-01: 発送準備中だけを古い注文・注文ID・明細ID順で返し、一部割当は準備数だけ・頁と総数を返す', async () => {
    const old = await ready({ createdAt: '2026-10-01T00:00:00Z', allocated: 2 });
    const a = await ready({ createdAt: '2026-10-02T00:00:00Z' });
    const b = await ready({ createdAt: '2026-10-02T00:00:00Z' });
    const extra = await insertOrderWithLines(db(), { status: 'paid', paidAmount: 5000, lines: [
      { itemId: a.itemId, variantId: a.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }] });
    // A second item on the same order exercises the final tie-breaker without changing an immutable id.
    await db().query(`insert into public.order_items(order_id,item_id,variant_id,item_name,item_price,color,size,
      quantity,line_total,fulfillment_type) values($1,$2,$3,'second',5000,'BLACK','M',1,5000,'stock') returning id`,
    [a.orderId, a.itemId, a.variantId]).then(async (r) => {
      await seedGroupG1Allocation(db(), { orderItemId: r.rows[0].id, quantity: 1, kind: 'paid' });
    });
    const ids = [old.orderId, a.orderId, b.orderId];
    const rs = ownRows(await packing(), ids);
    expect(rs.map((r) => r.order_id)[0]).toBe(old.orderId);
    expect(rs.slice(1).map((r) => `${r.order_id}/${r.order_item_id}`))
      .toEqual(rs.slice(1).map((r) => `${r.order_id}/${r.order_item_id}`).sort());
    expect(rs.find((r) => r.order_id === old.orderId)).toMatchObject({ ready_quantity: 2, shippable_quantity: 2,
      selected_quantity: null, bundle_ok: true, blocked_reasons: [] });
    expect((await packing()).some((r) => r.order_id === extra.orderId)).toBe(false);
    const all = await packing();
    expect(typeof all[0].total_count).toBe('string');
    expect(Number(all[0].total_count)).toBe(all.length);
    expect(await packing(null, 1, 1)).toEqual(all.slice(1, 2));
    expect(await packing(null, 1, 1000000)).toEqual([]);
  });

  test.each(['in_production', 'unpaid', 'shipped', 'cancel_requested', 'refund_processing', 'cancelled'])
  ('FREQ-531-AC-01: %s の行は荷作り表へ出ない', async (state) => {
    if (state === 'unpaid') {
      const c = await createCatalogFixture(db(), { stock: 5 });
      const o = await insertOrderWithLines(db(), { status: 'pending', lines: [
        { itemId: c.itemId, variantId: c.variantId, quantity: 4, fulfillmentType: 'stock' }] });
      expect(ownRows(await packing(), [o.orderId])).toEqual([]);
      return;
    }
    const f = await ready({ allocated: state === 'in_production' ? 0 : 4 });
    if (state === 'cancelled') await setOrderStatusForFixture(db(), [f.orderId], 'cancelled');
    if (state === 'shipped') await seedGroupG1Shipment(db(), { orderId: f.orderId,
      lines: [{ orderItemId: f.orderItemId, quantity: 4 }], shippedAt: '2026-10-21T00:00:00Z' });
    if (state === 'cancel_requested') {
      const id = (await db().query(`insert into public.order_cancel_requests
        (order_id,status,request_key,request_fingerprint,requested_by) values($1,'requested',$2,'fixture',$3) returning id`,
      [f.orderId, randomUUID(), actor])).rows[0].id;
      await db().query('insert into public.order_cancel_request_lines(cancel_request_id,order_item_id,quantity) values($1,$2,4)', [id, f.orderItemId]);
    }
    if (state === 'refund_processing') {
      const id = (await db().query(`insert into public.order_refunds
        (order_id,source,request_key,request_fingerprint,status,amount,notify_customer)
        values($1,'admin',$2,'fixture','pending',20000,false) returning id`, [f.orderId, randomUUID()])).rows[0].id;
      await db().query(`insert into public.order_refund_lines(refund_id,order_item_id,quantity,before_shipment,restock_type,amount)
        values($1,$2,4,true,'no_restock',20000)`, [id, f.orderItemId]);
    }
    expect(ownRows(await packing(), [f.orderId])).toEqual([]);
  });

  test('FREQ-531-AC-02: 支払確認・交換手数料・variant欠落・配送先不足・paid_at欠落の複数理由は指定順、shippable=0', async () => {
    const f = await ready({ paidAt: null, shipping: { phone: ' ' }, variantMissing: true });
    await db().query("select private.ensure_group_g_payment_review_hold($1,'g3-read',null,null,null)", [f.orderId]);
    const r = ownRows(await packing(), [f.orderId])[0];
    expect(r).toMatchObject({ ready_quantity: 4, shippable_quantity: 0,
      blocked_reasons: ['payment_review', 'variant_missing', 'address_incomplete', 'paid_at_missing'] });
    const s = await draft([{ orderItemId: f.orderItemId, quantity: 4 }]);
    const d = await detail(s);
    expect(d.lines[0].readyQuantity).toBe(0);
    for (const code of [...r.blocked_reasons, 'quantity_exceeds_ready'])
      expect(d.issues).toContainEqual({ code, orderItemId: f.orderItemId });
    expect(await flow.rejected(() => db().query('set constraints group_g_allocation_bounds immediate')))
      .toMatchObject({ code: '23514', message: 'GROUP_G_ALLOCATION_BOUNDS', detail: 'variant_mismatch' });
  });

  test('FREQ-531-AC-03: 他の有効な下書きだけを番号で知らせ、選択数と同梱可否を返す', async () => {
    const f = await ready(); const other = await ready({ email: 'another@example.invalid' });
    const lines = [{ orderItemId: f.orderItemId, quantity: 2 }];
    const a = await draft(lines); const b = await draft(lines);
    await draft(lines, true);
    await seedGroupG3Slip(db(), { stage: 'discarded', draftLines: lines });
    await seedGroupG3Slip(db(), { stage: 'confirmed', draftLines: lines });
    const number = async (id: string) => (await db().query('select number from public.shipment_slips where id=$1', [id])).rows[0].number;
    expect(ownRows(await packing(a), [f.orderId])[0]).toMatchObject({ selected_quantity: 2, other_slip_numbers: [await number(b)] });
    expect(ownRows(await packing(b), [f.orderId])[0].other_slip_numbers).toEqual([await number(a)]);
    expect(ownRows(await packing(a), [other.orderId])[0].bundle_ok).toBe(false);
    expect(ownRows(await packing(null), [other.orderId])[0]).toMatchObject({ bundle_ok: true, selected_quantity: null });
  });

  async function returned(orderId: string, itemId: string, fulfillment: string, status = 'open') {
    const id = (await db().query(`insert into public.order_returns
      (order_id,number,source,status,request_key,request_fingerprint,return_method,return_shipping_payer,notify_customer)
      values($1,1,'customer_request',$2,$3,'fixture','customer_ships','customer',false) returning id`,
    [orderId, status, randomUUID()])).rows[0].id;
    const line = (await db().query(`insert into public.order_return_lines
      (return_id,fulfillment_id,order_item_id,quantity,reason,resolution,exchange_variant_id,exchange_method)
      values($1,$2,$3,1,'unknown','exchange',(select variant_id from public.order_items where id=$3),'make') returning id`,
    [id, fulfillment, itemId])).rows[0].id;
    return { id, line };
  }

  test('FREQ-531-AC-02: 交換手数料待ちの準備行と五つの阻害理由の和集合、未割当のvariant欠落も詳細issuesで示す', async () => {
    const f = await ready({ paidAt: null, shipping: { phone: ' ' } });
    const shipment = await seedGroupG1Shipment(db(), { orderId: f.orderId,
      lines: [{ orderItemId: f.orderItemId, quantity: 1 }], shippedAt: '2026-10-21T00:00:00Z' });
    const r = await returned(f.orderId, f.orderItemId, shipment);
    await db().query('update public.order_returns set fee_due_amount=100 where id=$1', [r.id]);
    const exchange = (await db().query(`insert into public.order_items
      (order_id,item_id,variant_id,item_name,item_price,quantity,line_total,fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
      values($1,$2,null,'exchange',0,1,0,'backorder','exchange',$3,5000) returning id`,
    [f.orderId, f.itemId, r.line])).rows[0].id;
    await seedGroupG3MissingVariantAllocation(db(), { orderItemId: exchange, variantId: f.variantId, quantity: 1 });
    expect((await packing()).find((row) => row.order_item_id === exchange)).toMatchObject({ is_exchange: true,
      ready_quantity: 1, shippable_quantity: 0, blocked_reasons: ['exchange_fee_waiting', 'variant_missing', 'address_incomplete', 'paid_at_missing'] });
    await db().query("select private.ensure_group_g_payment_review_hold($1,'g3-exchange',null,null,null)", [f.orderId]);
    expect((await packing()).find((row) => row.order_item_id === exchange)?.blocked_reasons)
      .toEqual(['payment_review', 'exchange_fee_waiting', 'variant_missing', 'address_incomplete', 'paid_at_missing']);
    const s = await draft([{ orderItemId: exchange, quantity: 1 }]);
    expect((await detail(s)).issues).toContainEqual({ code: 'exchange_fee_waiting', orderItemId: exchange });
    const unallocated = await ready({ allocated: 0, variantMissing: true });
    const empty = await draft([{ orderItemId: unallocated.orderItemId, quantity: 1 }]);
    expect((await detail(empty)).issues).toContainEqual({ code: 'variant_missing', orderItemId: unallocated.orderItemId });
    expect(await flow.rejected(() => db().query('set constraints group_g_allocation_bounds immediate')))
      .toMatchObject({ code: '23514', message: 'GROUP_G_ALLOCATION_BOUNDS', detail: 'variant_mismatch' });
  });

  const addressFields = ['shipping_full_name', 'shipping_postal_code', 'shipping_prefecture', 'shipping_city',
    'shipping_address', 'shipping_building', 'shipping_phone'] as const;
  const addressKeys = { shipping_full_name: 'fullName', shipping_postal_code: 'postalCode', shipping_prefecture: 'prefecture',
    shipping_city: 'city', shipping_address: 'address', shipping_building: 'building', shipping_phone: 'phone' } as const;
  const shippingFor = (field: string, value: string): Partial<Record<(typeof addressKeys)[keyof typeof addressKeys], string>> =>
    ({ [addressKeys[field as keyof typeof addressKeys]]: value });
  const bundleCases: Array<[string, string, string, string, string | null]> = [
    ['same member different email', 'member', 'member', 'different', null],
    ['different member same email', 'member', 'otherMember', 'same', 'customer_mismatch'],
    ['guest case and whitespace', 'guest', 'guest', 'normalized', null],
    ['guest different email', 'guest', 'guest', 'different', 'customer_mismatch'],
    ['mixed member and guest', 'member', 'guest', 'same', 'customer_mismatch'],
    ...addressFields.map((field): [string, string, string, string, string | null] => [field, 'guest', 'guest', field, 'address_mismatch']),
    ['both buildings empty', 'guest', 'guest', 'emptyBuildings', null],
    ['incomplete beats customer mismatch', 'member', 'otherMember', 'incomplete', 'address_incomplete'],
    ['empty guest email', 'guest', 'guest', 'emptyEmail', 'address_incomplete'],
  ];
  test.each(bundleCases)('FREQ-532-AC-05: FREQ-532-AC-01〜04 同梱判定とbundle_keyの同値性: %s', async (_label, kindA, kindB, mode, expected) => {
    const a = await ready({ email: mode === 'emptyEmail' ? ' ' : undefined,
      shipping: mode === 'incomplete' ? { phone: ' ' } : undefined });
    const b = await ready({ email: mode === 'different' ? 'different@example.invalid'
      : mode === 'normalized' ? '  FIXTURE@EXAMPLE.COM  ' : undefined,
    shipping: (addressFields as readonly string[]).includes(mode) ? shippingFor(mode, 'different')
      : mode === 'emptyBuildings' ? { building: '  ' } : undefined });
    const member = await flow.createActor([]); const member2 = await flow.createActor([]);
    await db().query('update public.orders set user_id=$2 where id=$1', [a.orderId, kindA === 'member' ? member : null]);
    await db().query('update public.orders set user_id=$2 where id=$1', [b.orderId, kindB === 'member' ? member : kindB === 'otherMember' ? member2 : null]);
    const v = (await db().query('select private.group_g_bundle_verdict($1) as v', [[a.orderId, b.orderId]])).rows[0].v;
    expect(v).toBe(expected);
    const keys = (await db().query('select private.group_g_bundle_key(x) as k from unnest($1::uuid[]) x', [[a.orderId, b.orderId]])).rows.map((r) => r.k);
    expect(keys.every((k) => k !== null && k === keys[0])).toBe(v === null);
    if (expected === 'address_incomplete') expect(keys).toContain(null);
    const rows = ownRows(await packing(), [a.orderId, b.orderId]);
    expect(rows.find((r) => r.order_id === a.orderId)?.bundle_key).toBe(keys[0]);
    expect(rows.find((r) => r.order_id === b.orderId)?.bundle_key).toBe(keys[1]);
    const s = await draft([{ orderItemId: a.orderItemId, quantity: 1 }, { orderItemId: b.orderItemId, quantity: 1 }]);
    const issues = (await detail(s)).issues as Array<{ code: string; orderItemId: string | null }>;
    if (expected) expect(issues).toContainEqual({ code: expected, orderItemId: expected === 'address_incomplete' ? a.orderItemId : null });
    else expect(issues).toEqual([]);
  });

  test.each(['shipping_email', 'shipping_full_name', 'shipping_postal_code', 'shipping_prefecture',
    'shipping_city', 'shipping_address', 'shipping_phone'])
  ('FREQ-532-AC-04: 必須の%sが空白なら住所不足を最優先し鍵もNULL', async (field) => {
    const a = await ready(); const b = await ready(field === 'shipping_email'
      ? { email: '  ' } : { shipping: shippingFor(field, '  ') });
    expect((await db().query('select private.group_g_bundle_verdict($1) as v,private.group_g_bundle_key($2) as k',
      [[a.orderId, b.orderId], b.orderId])).rows[0]).toEqual({ v: 'address_incomplete', k: null });
  });

  test.each(addressFields)('FREQ-532-AC-05: 配送先%sの前後の空白だけなら同じキーと同梱可', async (field) => {
    const a = await ready({ shipping: shippingFor(field, 'Value') });
    const b = await ready({ shipping: shippingFor(field, '  Value  ') });
    const r = (await db().query(`select private.group_g_bundle_key($1) as a,private.group_g_bundle_key($2) as b,
      private.group_g_bundle_verdict($3) as verdict`, [a.orderId, b.orderId, [a.orderId, b.orderId]])).rows[0];
    expect(r.a).not.toBeNull(); expect(r.b).toBe(r.a); expect(r.verdict).toBeNull();
  });

  test.each(['empty', 'null_array', 'missing', 'mixed_missing', 'null_element', 'duplicate'])
  ('FREQ-532-AC-05: 同梱の空集合・不在ID・NULLは拒否し重複する実在IDは同じ鍵: %s', async (kind) => {
    const f = await ready(); const missing = randomUUID();
    const ids = kind === 'empty' ? [] : kind === 'null_array' ? null : kind === 'missing' ? [missing]
      : kind === 'mixed_missing' ? [f.orderId, missing] : kind === 'null_element' ? [f.orderId, null] : [f.orderId, f.orderId];
    const verdict = (await db().query('select private.group_g_bundle_verdict($1) as verdict', [ids])).rows[0].verdict;
    expect(verdict).toBe(kind === 'duplicate' ? null : 'address_incomplete');
    const keys = (await db().query('select private.group_g_bundle_key(x) as key from unnest($1::uuid[]) x', [ids])).rows.map((r) => r.key);
    expect(ids !== null && ids.length > 0 && keys.every((k) => k !== null && k === keys[0])).toBe(verdict === null);
    expect((await db().query('select private.group_g_bundle_key($1) as missing,private.group_g_bundle_key(null) as null_key', [missing])).rows[0])
      .toEqual({ missing: null, null_key: null });
  });

  test('FREQ-531-AC-02: 住所不足は該当する下書き明細ごとに1件だけ示し、正常な明細と票全体には付けない', async () => {
    const a = await ready({ shipping: { phone: ' ' } });
    const b = await ready({ shipping: { city: ' ' } });
    const good = await ready();
    const s = await draft([a, b, good].map((f) => ({ orderItemId: f.orderItemId, quantity: 1 })));
    const issues = (await detail(s)).issues as Array<{ code: string; orderItemId: string | null }>;
    expect(issues.filter((i) => i.code === 'address_incomplete').sort((x, y) => String(x.orderItemId).localeCompare(String(y.orderItemId))))
      .toEqual([a.orderItemId, b.orderItemId].sort().map((orderItemId) => ({ code: 'address_incomplete', orderItemId })));
  });

  test('FREQ-531-AC-03: 荷作り表の票は実在する下書きだけ、権限確認を存在確認より先に行う', async () => {
    expect(await flow.rejected(() => packing(randomUUID())))
      .toMatchObject({ code: 'P0002', message: 'GROUP_G_SLIP_NOT_FOUND' });
    for (const stage of ['confirmed', 'cancelled', 'discarded'] as const) {
      const s = await seedGroupG3Slip(db(), { stage, actorId: actor });
      expect(await flow.rejected(() => packing(s)))
        .toMatchObject({ code: '55000', message: 'GROUP_G_SLIP_NOT_DRAFT' });
    }
    const validActor = actor;
    actor = randomUUID();
    expect(await flow.rejected(() => packing(randomUUID())))
      .toMatchObject({ code: '42501', message: 'GROUP_G_FORBIDDEN' });
    actor = validActor;
  });

  test('FREQ-531-AC-01: 先絞り前のG-1投影と準備数が一致し、paid割当なしのpaid注文も比較の集合へ含める', async () => {
    const partial = await ready({ allocated: 2 });
    const noAllocation = await ready({ allocated: 0 });
    const shipped = await ready();
    await seedGroupG1Shipment(db(), { orderId: shipped.orderId,
      lines: [{ orderItemId: shipped.orderItemId, quantity: 4 }], shippedAt: '2026-10-21T00:00:00Z' });
    const cancelled = await ready();
    await setOrderStatusForFixture(db(), [cancelled.orderId], 'cancelled');
    const c = await createCatalogFixture(db(), { stock: 4 });
    const unpaid = await insertOrderWithLines(db(), { status: 'pending', lines: [
      { itemId: c.itemId, variantId: c.variantId, quantity: 4, fulfillmentType: 'stock' }] });
    const ids = [partial.orderId, noAllocation.orderId, shipped.orderId, cancelled.orderId, unpaid.orderId];
    const reference = (await db().query(`select r.order_id,r.order_item_id,sum(r.unit_to-r.unit_from)::integer as ready
      from private.group_g_item_state_ranges($1) r join public.orders o on o.id=r.order_id
      where o.status='paid' and r.status='ready' group by r.order_id,r.order_item_id order by r.order_id,r.order_item_id`, [ids])).rows;
    const actual = (await db().query(`select order_id,order_item_id,ready from private.group_g_shipment_ready($1)
      order by order_id,order_item_id`, [ids])).rows;
    expect(actual).toEqual(reference);
    expect(reference).toEqual([{ order_id: partial.orderId, order_item_id: partial.orderItemId, ready: 2 }]);
    expect((await db().query(`select status,sum(unit_to-unit_from)::integer as quantity
      from private.group_g_item_state_ranges($1) where order_item_id=$2 group by status`, [ids, noAllocation.orderItemId])).rows)
      .toEqual([{ status: 'in_production', quantity: 4 }]);
  });

  test('FREQ-531-AC-01: 票の不正stageは22023、NULLは全段階、確定票の注文数と数量は確定行から読む', async () => {
    expect(await flow.rejected(() => db().query('select * from public.list_admin_shipment_slips($1,100,0,$2)', ['invalid', actor])))
      .toMatchObject({ code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' });
    const a = await ready(); const b = await ready();
    const confirmed = await seedGroupG3Slip(db(), { stage: 'confirmed', actorId: actor,
      draftLines: [{ orderItemId: a.orderItemId, quantity: 99 }] });
    for (const [f, quantity] of [[a, 1], [b, 2]] as const) {
      const fulfillment = await seedGroupG1Shipment(db(), { orderId: f.orderId,
        lines: [{ orderItemId: f.orderItemId, quantity }], shippedAt: '2026-10-21T00:00:00Z' });
      await attachGroupG3SlipShipment(db(), { slipId: confirmed, orderId: f.orderId, orderItemId: f.orderItemId,
        fulfillmentId: fulfillment, quantity, actorId: actor });
    }
    const draftId = await draft([{ orderItemId: a.orderItemId, quantity: 1 }]);
    const cancelledId = await seedGroupG3Slip(db(), { stage: 'cancelled', actorId: actor });
    const discardedId = await seedGroupG3Slip(db(), { stage: 'discarded', actorId: actor });
    const rows = (await db().query('select * from public.list_admin_shipment_slips(null,100,0,$1)', [actor])).rows;
    expect(rows.filter((r) => [confirmed, draftId, cancelledId, discardedId].includes(r.id)).map((r) => r.stage).sort())
      .toEqual(['cancelled', 'confirmed', 'discarded', 'draft']);
    expect(rows.find((r) => r.id === confirmed)).toMatchObject({ order_count: 2, item_quantity: 3 });
    await db().query('set constraints all immediate'); await db().query('set constraints all deferred');
  });

  test.each([['shipping_city', 'shipping_address'], ['shipping_full_name', 'shipping_postal_code']])
  ('FREQ-532-AC-05: bundle_keyは%sと%sの文字境界を曖昧にしない', async (left, right) => {
    const a = await ready({ shipping: { ...shippingFor(left, 'AB'), ...shippingFor(right, 'C') } });
    const b = await ready({ shipping: { ...shippingFor(left, 'A'), ...shippingFor(right, 'BC') } });
    const r = (await db().query('select private.group_g_bundle_key($1) as a,private.group_g_bundle_key($2) as b', [a.orderId, b.orderId])).rows[0];
    expect(r.a).not.toBeNull(); expect(r.b).not.toBeNull(); expect(r.a).not.toBe(r.b);
  });

  test('FREQ-532-AC-03: 同じメールの別会員を介して会員とゲストを連鎖しない', async () => {
    const fs = [await ready(), await ready(), await ready()];
    const u = await flow.createActor([]); const v = await flow.createActor([]);
    await db().query('update public.orders set user_id=$2 where id=$1', [fs[0].orderId, u]);
    await db().query('update public.orders set user_id=$2 where id=$1', [fs[1].orderId, v]);
    expect((await db().query('select private.group_g_bundle_verdict($1) as v', [fs.map((f) => f.orderId)])).rows[0].v).toBe('customer_mismatch');
  });

  const actorReads = (id: string, who: string | null) => [
    () => db().query('select * from public.list_admin_packing(null,20,0,$1)', [who]),
    () => db().query('select * from public.list_admin_shipment_slips(null,20,0,$1)', [who]),
    () => db().query('select public.get_admin_shipment_slip($1,$2)', [id, who]),
    () => db().query('select * from public.list_admin_order_shipment_slips($1,$2)', [id, who]),
  ];
  test('FREQ-531-AC-04: supporter初期値と有効な全役割の和集合、どちらかの権限取消・無効・期限切れ・NULLをDBで検査', async () => {
    const s = await draft([]);
    for (const read of actorReads(s, actor)) await expect(read()).resolves.toBeDefined();
    for (const permission of ['admin.shipping.read', 'admin.orders.read']) {
      await withRolePermissions(db(), 'supporter', [], [permission], async () => {
        for (const read of actorReads(s, actor)) expect(await flow.rejected(read)).toMatchObject({ code: '42501', message: 'GROUP_G_FORBIDDEN' });
      });
    }
    const invalid = [null, randomUUID(), await flow.createActor(['supporter'], { inactive: ['supporter'] }),
      await flow.createActor(['supporter'], { expired: ['supporter'] })];
    for (const who of invalid) for (const read of actorReads(s, who))
      expect(await flow.rejected(read)).toMatchObject({ code: '42501', message: 'GROUP_G_FORBIDDEN' });
    const union = await flow.createActor(['admin', 'supporter']);
    await withRolePermissions(db(), 'admin', ['admin.orders.read'], ['admin.shipping.read'], async () =>
      withRolePermissions(db(), 'supporter', ['admin.shipping.read'], ['admin.orders.read'], async () => {
        for (const read of actorReads(s, union)) await expect(read()).resolves.toBeDefined();
      }));
  });

  test('FREQ-531-AC-01: 一覧の段階・期限・順序・数量・不正な頁と存在しない詳細', async () => {
    const f = await ready();
    const s = await draft([{ orderItemId: f.orderItemId, quantity: 2 }], true);
    const d = await detail(s);
    expect(d).toMatchObject({ id: s, stage: 'draft', expired: true, version: 1,
      orders: [], versions: [], dateHistory: [], cancelBlockers: [],
      registration: { enabled: false, state: null, everRegistered: null, leaderOrderId: null } });
    expect(d.issues).toContainEqual({ code: 'expired', orderItemId: null });
    expect(d.lines[0]).toMatchObject({ orderId: f.orderId, orderItemId: f.orderItemId, quantity: 2, readyQuantity: 4, unitPrice: 5000, isExchange: false });
    const rows = (await db().query('select * from public.list_admin_shipment_slips($1,100,0,$2)', ['draft', actor])).rows;
    expect(rows.find((r) => r.id === s)).toMatchObject({ order_count: 1, item_quantity: 2, expired: true });
    expect(rows.map((r) => [new Date(r.updated_at).getTime(), r.id]))
      .toEqual([...rows].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime() || a.id.localeCompare(b.id)).map((r) => [new Date(r.updated_at).getTime(), r.id]));
    for (const [limit, offset] of [[0, 0], [101, 0], [1, -1], [null, 0]])
      expect(await flow.rejected(() => db().query('select * from public.list_admin_packing(null,$1,$2,$3)', [limit, offset, actor])))
        .toMatchObject({ code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' });
    expect(await flow.rejected(() => detail(randomUUID()))).toMatchObject({ code: 'P0002', message: 'GROUP_G_SLIP_NOT_FOUND' });
  });

  test('FREQ-531-AC-03: 在庫減・割当入替・受取の次の読取で準備数とquantity_exceeds_readyが変わる', async () => {
    const f = await ready(); const manager = await flow.manager();
    const s = await draft([{ orderItemId: f.orderItemId, quantity: 4 }]);
    expect((await detail(s)).issues).toEqual([]);
    await db().query(`select public.admin_record_stock_movement($1,$2,-48,'adjustment','fixture',$3,$4,2)`,
      [f.itemId, f.variantId, manager, randomUUID()]);
    expect(ownRows(await packing(), [f.orderId])[0]).toMatchObject({ ready_quantity: 2, shippable_quantity: 2 });
    expect((await detail(s)).lines[0].readyQuantity).toBe(2);
    expect((await detail(s)).issues).toContainEqual({ code: 'quantity_exceeds_ready', orderItemId: f.orderItemId });
    // Receipt uses the real purchase-order path and FIFO, rather than manually changing remaining quantities.
    const po = await flow.create(manager, [{ variantId: f.variantId, quantity: 2 }]);
    const version = await flow.confirmQuantities(manager, po.id, await flow.linesOf(po.id), [2]);
    await flow.receive({ actor: manager, orderId: po.id, version, lines: [{ lineId: (await flow.linesOf(po.id))[0].id, quantity: 2 }] });
    expect(ownRows(await packing(), [f.orderId])[0]).toMatchObject({ ready_quantity: 4, shippable_quantity: 4 });
    expect((await detail(s)).issues).toEqual([]);
  });

  test('FREQ-531-AC-03: 同じvariantの割当入替だけでも次の準備数と下書きの数量超過に反映する', async () => {
    const f = await ready(); const s = await draft([{ orderItemId: f.orderItemId, quantity: 4 }]);
    const target = await insertOrderWithLines(db(), { status: 'paid', paidAmount: 5000, lines: [
      { itemId: f.itemId, variantId: f.variantId, quantity: 1, fulfillmentType: 'backorder', reserved: false }] });
    const op = randomUUID();
    await db().query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values($1,'fixture_transfer',$2,repeat('a',64),'order',$3,'{}')`, [op, randomUUID(), f.orderId]);
    await db().query('update public.order_item_allocations set remaining_quantity=remaining_quantity-1,version=version+1 where id=$1', [f.allocationId]);
    const allocation = (await db().query(`insert into public.order_item_allocations
      (order_item_id,variant_id,quantity,remaining_quantity,kind,operation_id) values($1,$2,1,1,'paid',$3) returning id`,
    [target.orderItemIds[0], f.variantId, op])).rows[0].id;
    await db().query(`insert into public.order_item_allocation_events
      (allocation_id,event_type,quantity,operation_id,sequence,counterpart_allocation_id)
      values($1,'transfer',1,$3,1,$2),($2,'transfer',1,$3,1,$1)`, [f.allocationId, allocation, op]);
    await db().query('set constraints all immediate'); await db().query('set constraints all deferred');
    expect(ownRows(await packing(), [f.orderId])[0]).toMatchObject({ ready_quantity: 3, shippable_quantity: 3 });
    expect((await detail(s)).lines[0].readyQuantity).toBe(3);
    expect((await detail(s)).issues).toContainEqual({ code: 'quantity_exceeds_ready', orderItemId: f.orderItemId });
  });

  test('FREQ-535-AC-05: 確定票の7列会計入力・最新日付履歴・取消時刻と詳細の履歴・発送を返す', async () => {
    const f = await ready();
    const shipment = await seedGroupG1Shipment(db(), { orderId: f.orderId, actorId: actor,
      lines: [{ orderItemId: f.orderItemId, quantity: 2 }], shippedAt: '2026-10-21T00:00:00Z' });
    const s = await seedGroupG3Slip(db(), { stage: 'confirmed', actorId: actor, shipmentDate: '2026-10-21' });
    await attachGroupG3SlipShipment(db(), { slipId: s, orderId: f.orderId,
      orderItemId: f.orderItemId, fulfillmentId: shipment, quantity: 2, actorId: actor });
    const dateOperation = randomUUID();
    await db().query(`insert into private.group_g_operations
      (id,operation,request_key,fingerprint,cause_type,cause_id,actor_id,result)
      values($1,'shipment_date_correct',$2,repeat('b',64),'shipment_slip',$3,$4,'{}')`,
    [dateOperation, randomUUID(), s, actor]);
    const revision = (await db().query(`insert into public.shipment_date_history
      (slip_id,version,kind,previous_date,new_date,reason,actor_id,operation_id,created_at)
      select id,2,'correction',shipment_date,'2026-10-22','fixture',$2,$3,now()-interval '1 day'
      from public.shipment_slips where id=$1 returning id`, [s, actor, dateOperation])).rows[0].id;
    await db().query(`insert into public.shipment_slip_versions
      (slip_id,version,kind,tracking_version,shipment_date,reason,actor_id,operation_id)
      values($1,2,'date_correction',1,'2026-10-22','fixture',$2,$3)`, [s, actor, dateOperation]);
    const priorFulfillmentChange = (await db().query("select coalesce(current_setting('app.fulfillment_change',true),'') as mark")).rows[0].mark;
    await db().query("select set_config('app.group_g_slip_change','date',true),set_config('app.fulfillment_change','shipment_date',true)");
    await db().query("update public.shipment_slips set shipment_date='2026-10-22',version=version+1 where id=$1", [s]);
    await db().query("update public.order_fulfillments set shipment_date='2026-10-22' where id=$1", [shipment]);
    await db().query("select set_config('app.fulfillment_change',$1,true)", [priorFulfillmentChange]);
    await db().query('set constraints all immediate'); await db().query('set constraints all deferred');
    const d = await detail(s);
    expect(d.orders).toHaveLength(1); expect(d.versions).toHaveLength(2); expect(d.dateHistory).toHaveLength(2);
    expect(d.versions[1]).toMatchObject({ version: 2, kind: 'date_correction', shipmentDate: '2026-10-22', reason: 'fixture' });
    expect(d.dateHistory.map((h: { version: number }) => h.version)).toEqual([1, 2]);
    expect(d.versions[0]).toMatchObject({ version: 1, kind: 'confirm', carrier: null, trackingNumber: null,
      trackingVersion: 1, shipmentDate: '2026-10-21', reason: null, actorEmail: null });
    expect(Object.keys(d).sort()).toEqual(['id','number','stage','version','expired','customerKind','shipTo','carrier',
      'trackingNumber','notifyCustomer','shipmentDate','trackingVersion','confirmedAt','cancelledAt','expiresAt',
      'updatedAt','lines','orders','issues','cancelBlockers','versions','dateHistory','registration'].sort());
    expect(d.lines[0]).toMatchObject({ quantity: 2, readyQuantity: 2 });
    expect(d.cancelBlockers).toEqual([]);
    expect((await db().query('select * from public.list_admin_order_shipment_slips($1,$2)', [f.orderId, actor])).rows)
      .toEqual([{ slip_id: s, number: d.number, stage: 'confirmed', fulfillment_id: shipment }]);
    const accounting = async () => (await db().query(`select * from public.list_shipment_accounting_inputs('2026-10-22','2026-10-22',100)`)).rows.find((r) => r.slip_id === s);
    const row = await accounting();
    expect(Object.keys(row).sort()).toEqual(['slip_id', 'fulfillment_id', 'order_item_id', 'quantity', 'shipment_date', 'revision_id', 'cancelled_at'].sort());
    expect(row).toMatchObject({ slip_id: s, fulfillment_id: shipment, order_item_id: f.orderItemId, quantity: 2, revision_id: revision, cancelled_at: null });
    await restoreGroupG1Shipment(db(), shipment, actor);
    await db().query("select set_config('app.group_g_slip_change','cancel',true)");
    await db().query("update public.shipment_slips set stage='cancelled',cancelled_at=now(),cancelled_by=$2,version=version+1 where id=$1", [s, actor]);
    expect((await accounting()).cancelled_at).toBeInstanceOf(Date);
    expect((await db().query(`select * from public.list_shipment_accounting_inputs('2026-10-21','2026-10-21',100)`)).rows.some((r) => r.slip_id === s)).toBe(false);
  });

  test('FREQ-540-AC-10: 会計入力はactorなしでservice_roleだけが呼べる、内部3本はservice_roleも拒む', async () => {
    await db().query('set local role service_role');
    await expect(db().query("select * from public.list_shipment_accounting_inputs('2026-10-01','2026-10-31',1)")).resolves.toBeDefined();
    await db().query('reset role');
    for (const role of ['anon', 'authenticated']) {
      expect(await flow.rejected(async () => {
        await db().query(`set local role ${role}`);
        await db().query("select * from public.list_shipment_accounting_inputs('2026-10-01','2026-10-31',1)");
      })).toMatchObject({ code: '42501' });
    }
    for (const call of ['private.group_g_shipment_ready(null::uuid[])', 'private.group_g_bundle_verdict(array[]::uuid[])',
      'private.group_g_bundle_key(null::uuid)']) {
      expect(await flow.rejected(async () => { await db().query('set local role service_role');
        await db().query(`select ${call}`); })).toMatchObject({ code: '42501' });
    }
  });

  test('FREQ-531-AC-03: 下書きの注文が取消になるとorder_not_shippableと今の準備数0を示す', async () => {
    const f = await ready({ paidAt: null }); const s = await draft([{ orderItemId: f.orderItemId, quantity: 2 }]);
    expect((await detail(s)).issues).toContainEqual({ code: 'paid_at_missing', orderItemId: f.orderItemId });
    await setOrderStatusForFixture(db(), [f.orderId], 'cancelled');
    const d = await detail(s);
    expect(d.lines[0].readyQuantity).toBe(0);
    expect(d.issues).toContainEqual({ code: 'order_not_shippable', orderItemId: f.orderItemId });
    expect(d.issues).toContainEqual({ code: 'quantity_exceeds_ready', orderItemId: f.orderItemId });
    expect(d.issues.some((issue: { code: string }) => issue.code === 'paid_at_missing')).toBe(false);
  });

  test('FREQ-531-AC-03: 追跡オンは代表登録の状態・登録済み・代表注文を返し、オフはfalseとnullへ戻る', async () => {
    const f = await ready();
    const shipment = await seedGroupG1Shipment(db(), { orderId: f.orderId,
      lines: [{ orderItemId: f.orderItemId, quantity: 2 }], shippedAt: '2026-10-21T00:00:00Z', trackingNumber: 'G3-READ' });
    const s = await seedGroupG3Slip(db(), { stage: 'confirmed', actorId: actor, shippingCarrier: 'yamato', trackingNumber: 'G3-READ' });
    await attachGroupG3SlipShipment(db(), { slipId: s, orderId: f.orderId, orderItemId: f.orderItemId,
      fulfillmentId: shipment, quantity: 2, actorId: actor });
    await insertDeliveryRegistration(db(), shipment, { state: 'registered', everRegistered: true });
    await db().query(`insert into private.shipment_tracking_registrations
      (slip_id,tracking_version,leader_fulfillment_id,carrier,tracking_number,operation_id)
      select id,1,$2,'yamato','G3-READ',confirm_operation_id from public.shipment_slips where id=$1`, [s, shipment]);
    // Change only the setting through its allowed mark; avoid E-4 backfill side effects in this read fixture.
    await db().query("select set_config('app.delivery_tracking_setting','toggle',true)");
    await db().query('update public.shop_settings set delivery_tracking_enabled=true where id=1');
    expect((await detail(s)).registration).toEqual({ enabled: true, state: 'registered', everRegistered: true, leaderOrderId: f.orderId });
    await db().query('update public.shop_settings set delivery_tracking_enabled=false where id=1');
    expect((await detail(s)).registration).toEqual({ enabled: false, state: null, everRegistered: null, leaderOrderId: null });
  });

  test('FREQ-540-AC-10: G3B末尾assertを再実行でき、ACL・STABLE・search_path・入口委譲の改変を検出する', async () => {
    const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261025070821_group_g3_shipping_reads.sql'), 'utf8');
    const body = migration.split('-- G3B_FINAL_ASSERT_BEGIN')[1].split('-- G3B_FINAL_ASSERT_END')[0];
    await db().query(body);
    const probes = [
      ['grant execute on function private.group_g_bundle_key(uuid) to service_role', 'shipping_internal_functions'],
      ['alter function private.group_g_shipment_ready(uuid[]) volatile', 'shipping_internal_functions'],
      ["alter function private.list_admin_packing(uuid,integer,integer,uuid) set search_path='public'", 'shipping_read_functions'],
      ['grant execute on function public.list_admin_shipment_slips(text,integer,integer,uuid) to anon', 'shipping_read_functions'],
      ["create or replace function public.get_admin_shipment_slip(_slip_id uuid,_actor_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select '{}'::jsonb $$", 'shipping_read_functions'],
    ];
    for (const [sql, expected] of probes) {
      await db().query('savepoint final_assert_probe');
      await db().query(sql);
      expect(await flow.rejected(() => db().query(body))).toMatchObject({ code: '55000',
        message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail: expected });
      await db().query('rollback to savepoint final_assert_probe');
    }
    await db().query(body);
    const source = (await db().query("select prosrc from pg_proc where oid='private.group_g_shipment_ready(uuid[])'::regprocedure")).rows[0].prosrc;
    expect(source).toMatch(/candidates AS MATERIALIZED/);
    expect(source.indexOf("a.kind = 'paid' AND a.remaining_quantity > 0")).toBeLessThan(source.indexOf('private.group_g_item_state_ranges'));
    expect((await db().query('select * from private.group_g_shipment_ready(array[]::uuid[])')).rows).toEqual([]);
    const detailSource = (await db().query("select prosrc from pg_proc where oid='private.get_admin_shipment_slip(uuid,uuid)'::regprocedure")).rows[0].prosrc as string;
    expect(detailSource.match(/private\.group_g_shipment_ready\(/g)).toHaveLength(1);
  });

  test.each(['requested', 'open', 'closed', 'refunded', 'not_cancellable'])
  ('FREQ-531-AC-03: 確定票のcancelBlockersを発送ごとに計算: %s', async (kind) => {
    const f = await ready();
    const shipment = await seedGroupG1Shipment(db(), { orderId: f.orderId,
      lines: [{ orderItemId: f.orderItemId, quantity: 2 }], shippedAt: '2026-10-21T00:00:00Z' });
    const s = await seedGroupG3Slip(db(), { stage: 'confirmed', actorId: actor });
    await attachGroupG3SlipShipment(db(), { slipId: s, orderId: f.orderId, orderItemId: f.orderItemId,
      fulfillmentId: shipment, quantity: 2, actorId: actor });
    if (['requested', 'open', 'closed'].includes(kind)) await returned(f.orderId, f.orderItemId, shipment, kind);
    if (kind === 'not_cancellable') await setOrderStatusForFixture(db(), [f.orderId], 'cancelled');
    if (kind === 'refunded') {
      const id = (await db().query(`insert into public.order_refunds
        (order_id,source,request_key,request_fingerprint,status,amount,notify_customer)
        values($1,'admin',$2,'fixture','pending',5000,false) returning id`, [f.orderId, randomUUID()])).rows[0].id;
      await db().query(`insert into public.order_refund_lines(refund_id,order_item_id,quantity,before_shipment,restock_type,amount)
        values($1,$2,1,false,'no_restock',5000)`, [id, f.orderItemId]);
    }
    expect((await detail(s)).cancelBlockers).toEqual([{ orderId: f.orderId,
      reason: ['requested', 'open', 'closed'].includes(kind) ? 'has_return' : kind }]);
  });
});
