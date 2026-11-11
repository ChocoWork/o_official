/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DiscountDefinition } from '@/lib/discounts/discount-types';
import { planUnitEvent } from '@/lib/orders/unit-pricing/unit-event-plan';
import type { UnitEventChange, UnitPricingMaterials, UnitPricingPlan } from '@/lib/orders/unit-pricing/unit-pricing-types';
import { amount, definition } from '../../unit/lib/discounts/fixtures';
import { buildOrder } from '../../unit/lib/orders/unit-pricing/fixtures';
import { seedFactSlip } from './helpers/accounting-orders-fixtures';
import { hDiscount, seedHDiscount, seedHMember, seedHOrderUnits, seedHUnitSlots, type HCatalog } from './helpers/group-h-fixtures';
import { hBegin, hClaims, hReceive, hRefundFixture, hResult, hReturn } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture } from './helpers/order-fixtures';

const directory = path.join(process.cwd(), 'supabase', 'migrations');
const file = fs.readdirSync(directory).find((name) => name.endsWith('_unit_binding_core.sql'));
const sql = file ? fs.readFileSync(path.join(directory, file), 'utf8') : '';

describe('FREQ-642-AC-18: unit binding migration B source contract', () => {
  test('FREQ-642-AC-18: 移行Bは単一取引・ASCII・LF・末尾の確かめを持つ', () => {
    expect(file).toBeDefined();
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(sql).toContain('UNIT_BINDING_CORE_MIGRATION_ASSERTION_FAILED');
    for (const detail of ['ubc_schema', 'ubc_functions', 'ubc_acl']) expect(sql).toContain(`'${detail}'`);
  });
});

type Failure = { code?: string; message?: string; detail?: string };
type SeededOrder = { orderId: string; itemIds: string[]; built: ReturnType<typeof buildOrder> };

describeLocalDb('FREQ-642-AC-18: unit binding core (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);

  async function failure(run: () => Promise<unknown>): Promise<Failure> {
    await q('savepoint ubc_expected');
    try { await run(); return {}; }
    catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await q('rollback to savepoint ubc_expected'); await q('release savepoint ubc_expected'); }
  }

  /** An H order with a snapshot and kept slots, priced by the real discount engine; every unit is shipped when `ship` is set. */
  async function seedOrder(spec: {
    userId?: string; lines: { catalog: HCatalog; unitPrice: number; quantity: number }[]; definitions?: DiscountDefinition[];
    codes?: string[]; priorUnitsByItem?: Record<string, number>; createdAt?: string; ship?: boolean;
  }): Promise<SeededOrder> {
    const lineSpecs = (ids: string[]) => spec.lines.map((l, i) => ({ orderItemId: ids[i], itemId: l.catalog.itemId, unitPrice: l.unitPrice, quantity: l.quantity }));
    const priced = buildOrder({ orderId: 'pre', lines: lineSpecs(spec.lines.map((_, i) => `oi-${i}`)), definitions: spec.definitions,
      codes: spec.codes, priorUnitsByItem: spec.priorUnitsByItem });
    const discountId = await seedHDiscount(db(), hDiscount());
    const seeded = await seedHOrderUnits(db(), { legacy: false, buyerUserId: spec.userId, createdAt: spec.createdAt, lines: spec.lines.map((l, i) => {
      const units = priced.slots.filter(s => s.orderItemId === `oi-${i}`).map(s => s.paidAmount);
      const allocated = l.unitPrice * l.quantity - units.reduce((a, b) => a + b, 0);
      return { itemPrice: l.unitPrice, quantity: l.quantity, catalog: l.catalog, unitAmounts: units,
        discounts: allocated > 0 ? [{ discountId, amount: allocated }] : [] };
    }) });
    const built = buildOrder({ orderId: seeded.orderId, lines: lineSpecs(seeded.orderItemIds), definitions: spec.definitions,
      codes: spec.codes, priorUnitsByItem: spec.priorUnitsByItem });
    const facts = Object.fromEntries(Object.entries(built.snapshot.facts).filter(([k]) => k !== 'phase'));
    if (spec.userId) facts.buyer = { kind: 'member', userId: spec.userId };
    await seedHUnitSlots(db(), { orderId: seeded.orderId, snapshot: { engineVersion: 1, definitions: built.snapshot.definitions,
      codes: built.snapshot.codes, facts, lines: built.snapshot.lines } });
    if (spec.ship) for (const [i, id] of seeded.orderItemIds.entries()) await seedFactSlip(db(), { orderItemId: id, quantity: spec.lines[i].quantity });
    return { orderId: seeded.orderId, itemIds: seeded.orderItemIds, built };
  }

  const materialsOf = async (orderId: string) =>
    (await q('select private.order_unit_pricing_materials($1) as j', [orderId])).rows[0].j as UnitPricingMaterials | null;
  const lockedApply = async (plan: unknown, over: { returnId?: string | null; receiptId?: string | null; actorId?: string | null } = {}) =>
    (await q('select private.order_unit_apply_plan($1::jsonb,$2,$3,$4,$5) as id',
      [JSON.stringify(plan), randomUUID(), over.returnId ?? null, over.receiptId ?? null, over.actorId ?? null])).rows[0].id as string;
  const returnOf = (holderOrderItemId: string, side: 'customer' | 'shop' = 'customer', over: Record<string, unknown> = {}): UnitEventChange => ({
    kind: 'return_receive', excludedSlots: [],
    returns: [{ returnLineId: null, holderOrderItemId, quantity: 1, side, part: 'now', feePercent: 0, ...over }] });
  const counts = async () => (await q(`select
    (select count(*)::int from public.order_unit_events) e, (select count(*)::int from public.order_unit_event_lines) l,
    (select count(*)::int from public.order_unit_holds) h,
    (select coalesce(string_agg(state||':'||current_price,',' order by order_item_id,unit_index),'') from public.order_unit_slots) s`)).rows[0];

  /** Example 7: jackets 20000 x2 and pants 10000, a set discount of 4500 (paid 17000/20000 and 8500). */
  async function setOrder() {
    const jacket = await createCatalogFixture(db()); const pants = await createCatalogFixture(db());
    const userId = await seedHMember(db());
    const order = await seedOrder({ userId, ship: true,
      lines: [{ catalog: jacket, unitPrice: 20000, quantity: 2 }, { catalog: pants, unitPrice: 10000, quantity: 1 }],
      definitions: [amount('set', 4500, { kind: 'set', targetMode: 'include', itemIds: [jacket.itemId, pants.itemId] })] });
    return { ...order, userId, jacket, pants };
  }

  test('FREQ-642-AC-18: 写しの無い注文の材料は NULL', async () => {
    const legacy = await seedHOrderUnits(db(), { legacy: true, lines: [{ itemPrice: 1000, quantity: 1, discounts: [], unitAmounts: [] }] });
    expect(await materialsOf(legacy.orderId)).toBeNull();
    expect(await materialsOf(randomUUID())).toBeNull();
  });

  test('FREQ-642-AC-18: 材料は型どおりの形で、版は出来事が無ければ 0・出荷済みの印は会計の道具から', async () => {
    const o = await setOrder();
    const m = (await materialsOf(o.orderId))!;
    expect(m.version).toMatch(/^0:[0-9a-f]{32}$/);
    expect(m.related).toEqual([]);
    expect(m.target).toMatchObject({ orderId: o.orderId, paidTotal: 45500, entitlementPrevious: 0, entitlementMax: 0, feeTotal: 0, holds: [] });
    expect(typeof m.target.placedAt).toBe('string');
    expect(m.target.snapshot).toMatchObject({ engineVersion: 1, codes: [] });
    expect(m.target.snapshot.definitions).toHaveLength(1);
    expect(m.target.snapshot.facts.buyer).toEqual({ kind: 'member', userId: o.userId });
    expect(m.target.slots).toHaveLength(3);
    expect(m.target.slots.every(s => s.shipped && s.state === 'kept' && s.allocatedAmount === 0 && s.currentPrice === s.paidAmount)).toBe(true);
    expect(m.target.slots.find(s => s.orderItemId === o.itemIds[0] && s.unitIndex === 0)).toEqual({ orderItemId: o.itemIds[0], unitIndex: 0, itemId: o.jacket.itemId, paidAmount: 17000, allocatedAmount: 0,
      currentPrice: 17000, state: 'kept', holderOrderItemId: o.itemIds[0], holderUnitIndex: 0, shipped: true, returnedCustomerAt: null,
      returnedFeePercent: null, returnedEventSeq: null, returnedReturnLineId: null, claimedReturnLineId: null, claimedRefundId: null });
    expect(m.target.snapshot.lines).toHaveLength(2);
    // An unshipped order has shipped=false slots.
    const unshipped = await seedOrder({ lines: [{ catalog: o.jacket, unitPrice: 20000, quantity: 1 }] });
    expect((await materialsOf(unshipped.orderId))!.target.slots[0].shipped).toBe(false);
  });

  test('FREQ-642-AC-18: 例7 の計画を記録すると枠と行と式がそろう', async () => {
    const o = await setOrder();
    const m = (await materialsOf(o.orderId))!;
    const plan = planUnitEvent(m, returnOf(o.itemIds[1]));
    const eventId = await lockedApply(plan);
    const event = (await q('select * from public.order_unit_events where id=$1', [eventId])).rows[0];
    expect(event).toMatchObject({ order_id: o.orderId, kind: 'return_receive', entitlement: 5500, standard_refund: 5500, now_refund: 5500,
      consult_refund: 0, fee_amount: 0, hold_total: 0, entitlement_previous: 0, entitlement_max_before: 0, entitlement_gross: 5500 });
    const lines = (await q(`select * from public.order_unit_event_lines where event_id=$1
      order by case line_kind when 'returned' then 0 else 1 end`, [eventId])).rows;
    expect(lines.map(l => [l.line_kind, l.allocation, l.correction])).toEqual([['returned', 8500, 0], ['kept', 0, 3000]]);
    expect(lines[0]).toMatchObject({ order_item_id: o.itemIds[1], state_before: 'kept', state_after: 'returned_customer', price_before: 10000 - 1500, price_after: 8500, shipped: true });
    const jacketInSet = (await q('select * from public.order_unit_slots where order_item_id=$1 and unit_index=0', [o.itemIds[0]])).rows[0];
    expect(jacketInSet).toMatchObject({ current_price: 20000, state: 'kept', last_event_id: eventId });
    const pants = (await q('select * from public.order_unit_slots where order_item_id=$1', [o.itemIds[1]])).rows[0];
    expect(pants).toMatchObject({ state: 'returned_customer', current_price: 8500, last_event_id: eventId });
    // The next read sees the event: version is its seq, previous E and the max follow, the returned slot carries the event.
    const next = (await materialsOf(o.orderId))!;
    expect(next.version).toMatch(new RegExp(`^${event.seq}:[0-9a-f]{32}$`));
    expect(next.target).toMatchObject({ entitlementPrevious: 5500, entitlementMax: 5500, feeTotal: 0 });
    const returned = next.target.slots.find(s => s.orderItemId === o.itemIds[1])!;
    expect(returned).toMatchObject({ state: 'returned_customer', allocatedAmount: 8500, returnedEventSeq: Number(event.seq), returnedFeePercent: null, returnedReturnLineId: null });
    expect(typeof returned.returnedCustomerAt).toBe('string');
  });

  test('FREQ-642-AC-17: 版が違う計画は STALE で何も書かない', async () => {
    const o = await setOrder();
    const plan = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[1]));
    await lockedApply(plan);
    const before = await counts();
    const stale = { ...plan, version: '0' };
    expect(await failure(() => lockedApply(stale))).toMatchObject({ message: 'UNIT_PRICING_STALE', code: '40001' });
    expect(await counts()).toEqual(before);
  });

  test('FREQ-642-AC-18: 共通の鍵が無い呼び出しは断る', async () => {
    const o = await setOrder();
    const plan = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[1]));
    await q('rollback'); await q('begin');
    expect(await failure(() => lockedApply(plan))).toMatchObject({ message: 'GROUP_H_LOCK_REQUIRED', code: '55000' });
  });

  test('FREQ-642-AC-14: E が下がった後も、返す額の累計は払った額を超えない（E の最高は 0 円から）', async () => {
    const catalog = await createCatalogFixture(db()); const userId = await seedHMember(db());
    const o = await seedOrder({ userId, ship: true, lines: [{ catalog, unitPrice: 10000, quantity: 3 }],
      definitions: [definition('tier', { kind: 'product', value: { type: 'percent', value: 50 }, minimum: { type: 'quantity', value: 3 } })] });
    const first = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[0]));
    expect([first.entitlement, first.standardRefund]).toEqual([-5000, 0]);
    await lockedApply(first);
    const next = (await materialsOf(o.orderId))!;
    expect(next.target).toMatchObject({ entitlementPrevious: -5000, entitlementMax: 0, paidTotal: 15000 });
    const second = planUnitEvent(next, returnOf(o.itemIds[0], 'customer', { quantity: 2 }));
    expect([second.entitlement, second.entitlementMaxBefore, second.standardRefund]).toEqual([15000, 0, 15000]);
    await lockedApply(second);
    expect((await q('select sum(standard_refund)::int n from public.order_unit_events where order_id=$1', [o.orderId])).rows[0].n).toBe(15000);
  });

  test('FREQ-642-AC-17: 材料を読んだ後に同じ会員の入金済みの注文が増えたら、古い計画は STALE', async () => {
    const jacket = await createCatalogFixture(db()); const userId = await seedHMember(db());
    const first = await seedOrder({ userId, ship: true, lines: [{ catalog: jacket, unitPrice: 20000, quantity: 1 }] });
    const plan = planUnitEvent((await materialsOf(first.orderId))!, returnOf(first.itemIds[0]));
    await seedOrder({ userId, lines: [{ catalog: jacket, unitPrice: 20000, quantity: 1 }] });
    const before = await counts();
    expect(await failure(() => lockedApply(plan))).toMatchObject({ message: 'UNIT_PRICING_STALE', code: '40001' });
    expect(await counts()).toEqual(before);
    expect((await materialsOf(first.orderId))!.related).toHaveLength(1);
  });

  test('FREQ-642-AC-18: 割り振りが払った額を超える計画は、直しで釣り合わせても断る。金額の取り方も計画どおりでなければ断る', async () => {
    const o = await setOrder();
    const plan = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[1]));
    const over = structuredClone(plan); over.lines[0].allocation = 9000; over.lines[0].priceAfter = 9000; over.lines[0].correction = 500;
    expect(await failure(() => lockedApply(over))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_5' });
    const under = structuredClone(plan); under.lines[0].allocation = 8000; under.lines[0].priceAfter = 8000; under.lines[0].correction = -500;
    expect(await failure(() => lockedApply(under))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_5' });
    const priced = structuredClone(plan); priced.lines[0].priceAfter = 8000; priced.lines[0].correction = -500;
    expect(await failure(() => lockedApply(priced))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_5' });
  });

  test('FREQ-642-AC-18: E の総額（entitlementGross）が払った額 − 残る着 − holds と違う計画は断る', async () => {
    const o = await setOrder();
    const plan = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[1]));
    plan.entitlementGross += 1;
    expect(await failure(() => lockedApply(plan))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_6' });
  });

  test('FREQ-642-AC-18: 関わらない注文の枠を指す hold の行は断る', async () => {
    const o = await setOrder();
    const stranger = await seedOrder({ userId: await seedHMember(db()), lines: [{ catalog: o.jacket, unitPrice: 20000, quantity: 1 }] });
    const plan = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[1]));
    plan.lines.push({ lineKind: 'hold', orderItemId: stranger.itemIds[0], unitIndex: 0, slotOrderId: stranger.orderId,
      holderOrderItemId: stranger.itemIds[0], holderUnitIndex: 0, stateBefore: 'kept', stateAfter: 'kept', priceBefore: 20000, priceAfter: 20000,
      allocation: 0, correction: 0, part: null, returnLineId: null, shipped: false });
    expect(await failure(() => lockedApply(plan))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_3' });
  });

  describe('tampered plans', () => {
    const tampers: Record<string, (p: UnitPricingPlan, o: { itemIds: string[]; orderId: string }) => void> = {
      ub_plan_3: (p) => { p.lines[0].priceBefore += 1; },
      ub_plan_4: (p) => { p.lines[0].stateAfter = 'kept'; },
      ub_plan_5: (p) => { p.lines[1].allocation = 5; },
      ub_plan_6: (p) => { p.entitlement += 1; },
      ub_plan_7: (p) => { p.entitlementMaxBefore = 1; },
      ub_plan_8: (p) => { p.holdTotal = -1; },
      ub_plan_9: (p, o) => { p.holds = [{ heldOrderId: randomUUID(), laterOrderId: o.orderId, itemId: 1, amount: 100 }]; },
    };
    test.each(Object.keys(tampers))('FREQ-642-AC-18: 壊した計画は %s で断る', async (detail) => {
      const o = await setOrder();
      const plan = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[1]));
      tampers[detail](plan, o);
      const before = await counts();
      expect(await failure(() => lockedApply(plan))).toMatchObject({ message: 'UNIT_PRICING_INVALID', code: '22023', detail });
      expect(await counts()).toEqual(before);
    });

    test('FREQ-642-AC-18: 形が崩れた計画と、出荷の印が違う行は断る', async () => {
      const o = await setOrder();
      const plan = planUnitEvent((await materialsOf(o.orderId))!, returnOf(o.itemIds[1]));
      expect(await failure(() => lockedApply({ ...plan, kind: 'bogus' }))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_1' });
      expect(await failure(() => lockedApply({ ...plan, lines: 'x' }))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_1' });
      expect(await failure(() => lockedApply({ ...plan, orderId: randomUUID() }))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_1' });
      const flipped = structuredClone(plan); flipped.lines[0].shipped = false;
      expect(await failure(() => lockedApply(flipped))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_3' });
      const twice = structuredClone(plan); twice.lines.push(structuredClone(twice.lines[0]));
      expect(await failure(() => lockedApply(twice))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_3' });
    });

    test('FREQ-642-AC-18: 一度返した枠をもう一度返す計画は断る（状態は一度だけ変わる）', async () => {
      const o = await setOrder();
      const m = (await materialsOf(o.orderId))!;
      const plan = planUnitEvent(m, returnOf(o.itemIds[1]));
      await lockedApply(plan);
      const again = structuredClone(plan);
      again.version = (await materialsOf(o.orderId))!.version;
      expect(await failure(() => lockedApply(again))).toMatchObject({ message: 'UNIT_PRICING_INVALID', detail: 'ub_plan_3' });
    });
  });

  test('FREQ-642-AC-18: 発送前の取り消しの割り振りは accounting_record_unit_refund が受け付ける', async () => {
    const jacket = await createCatalogFixture(db());
    const o = await seedOrder({ lines: [{ catalog: jacket, unitPrice: 20000, quantity: 2 }],
      definitions: [amount('repeat', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [jacket.itemId], repeatInOrder: true })] });
    const plan = planUnitEvent((await materialsOf(o.orderId))!,
      { kind: 'pre_shipment_cancel', cancels: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    expect(plan.standardRefund).toBe(17000);
    const eventId = await lockedApply(plan);
    const returned = (await q(`select order_item_id,unit_index,allocation from public.order_unit_event_lines
      where event_id=$1 and line_kind='returned' and allocation>0`, [eventId])).rows;
    expect(returned).toHaveLength(1);
    for (const r of returned) {
      await q('select private.accounting_record_unit_refund($1,$2,$3,$4)', ['R-ub-1', r.order_item_id, r.unit_index, r.allocation]);
    }
    expect((await q('select count(*)::int n from public.accounting_unit_refund_allocations where refund_key=$1', ['R-ub-1'])).rows[0].n).toBe(1);
  });

  test('FREQ-642-AC-10: 前の注文の返品は後の注文の着に hold を残し、holds は前の注文の材料にだけ出る', async () => {
    const jacket = await createCatalogFixture(db());
    const userId = await seedHMember(db());
    const repeatPrev = amount('repeatprev', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [jacket.itemId], repeatPrevious: true });
    const first = await seedOrder({ userId, ship: true, createdAt: '2026-11-01T00:00:00Z',
      lines: [{ catalog: jacket, unitPrice: 20000, quantity: 1 }], definitions: [repeatPrev] });
    const second = await seedOrder({ userId, ship: true, createdAt: '2026-11-02T00:00:00Z', lines: [{ catalog: jacket, unitPrice: 20000, quantity: 1 }],
      definitions: [repeatPrev], priorUnitsByItem: { [String(jacket.itemId)]: 1 } });
    for (const id of [first.orderId, second.orderId]) await q("update public.orders set paid_amount=total_amount where id=$1", [id]);
    const m = (await materialsOf(first.orderId))!;
    expect(m.related.map(r => r.orderId)).toEqual([second.orderId]);
    expect(m.related[0].slots[0].paidAmount).toBe(17000);
    const plan = planUnitEvent(m, returnOf(first.itemIds[0]));
    expect(plan).toMatchObject({ standardRefund: 17000, holdTotal: 3000 });
    const eventId = await lockedApply(plan);
    const event = (await q('select seq from public.order_unit_events where id=$1', [eventId])).rows[0];
    const holds = (await q('select * from public.order_unit_holds where event_id=$1', [eventId])).rows;
    expect(holds.map(h => [h.held_order_id, h.later_order_id, h.amount])).toEqual([[first.orderId, second.orderId, 3000]]);
    const lines = (await q('select line_kind,slot_order_id,allocation,correction from public.order_unit_event_lines where event_id=$1 order by line_kind', [eventId])).rows;
    expect(lines).toEqual([
      { line_kind: 'hold', slot_order_id: second.orderId, allocation: 0, correction: 3000 },
      { line_kind: 'returned', slot_order_id: first.orderId, allocation: 20000, correction: 0 },
    ]);
    // The later order's slot price does not move; the hold lives in the held order's materials only.
    const after = (await materialsOf(first.orderId))!;
    expect(after.version).toMatch(new RegExp(`^${event.seq}:`));
    expect(after.target.holds).toEqual([{ heldOrderId: first.orderId, laterOrderId: second.orderId, itemId: jacket.itemId, amount: 3000, seq: Number(event.seq) }]);
    expect(after.related[0].holds).toEqual([]);
    expect(after.related[0].slots[0].currentPrice).toBe(17000);
    const fromSecond = (await materialsOf(second.orderId))!;
    expect(fromSecond.version.split(':')[0]).toBe(after.version.split(':')[0]);
    expect(fromSecond.target.holds).toEqual([]);
    expect(fromSecond.related[0].holds).toHaveLength(1);
    // Example 10-2: the later order's return plans a release of the hold; as its own event it gives the amount back.
    const plan2 = planUnitEvent(fromSecond, returnOf(second.itemIds[0]));
    expect(plan2.standardRefund).toBe(17000);
    expect(plan2.releases).toHaveLength(1);
    await lockedApply(plan2);
    const release = { ...plan2.releases[0], version: (await materialsOf(first.orderId))!.version };
    const releaseId = await lockedApply(release);
    expect((await q('select kind,order_id,standard_refund,entitlement from public.order_unit_events where id=$1', [releaseId])).rows[0])
      .toEqual({ kind: 'hold_release', order_id: first.orderId, standard_refund: 3000, entitlement: 20000 });
    expect((await materialsOf(first.orderId))!.target.holds.reduce((s, h) => s + h.amount, 0)).toBe(0);
    // A release beyond the held amount is refused.
    const tooMuch = structuredClone(release);
    tooMuch.version = (await materialsOf(first.orderId))!.version;
    expect(await failure(() => lockedApply(tooMuch))).toMatchObject({ message: 'UNIT_PRICING_INVALID', code: '22023' });
  });

  describe('claim overloads and refund link', () => {
    /** 通常の返金は、移行 D から返品なしの発送後の着を取り押さえない。取り押さえた返金が要る試験は、H5 の取り押さえ（安い着を1つ）を直に付けて作る */
    const hBeginClaimed = async (f: Awaited<ReturnType<typeof hRefundFixture>>, amount: number) => {
      const refund = await hBegin(db(), f, amount);
      await q('select private.group_h_claim_refund_units($1,$2,1,false,null)', [refund.refund_id, f.itemId]);
      return refund;
    };
    const insertEvent = async (orderId: string, over: Record<string, unknown> = {}) => {
      const e = { kind: 'return_receive', return_id: null, standard_refund: 0, now_refund: 0, consult_refund: 0, ...over };
      return (await q(`insert into public.order_unit_events(order_id,kind,return_id,entitlement_previous,entitlement_max_before,entitlement_gross,
        entitlement_shop_only,fee_amount,hold_total,entitlement,standard_refund,now_refund,consult_refund)
        values($1,$2,$3,0,0,0,0,0,0,0,$4,$5,$6) returning id`, [orderId, e.kind, e.return_id, e.standard_refund, e.now_refund, e.consult_refund])).rows[0].id as string;
    };
    const insertLine = async (eventId: string, orderId: string, itemId: string, unitIndex: number, over: Record<string, unknown> = {}) => {
      const l = { part: 'now', return_line_id: null, shipped: true, ...over };
      await q(`insert into public.order_unit_event_lines(event_id,line_kind,order_item_id,unit_index,slot_order_id,holder_order_item_id,holder_unit_index,
        state_before,state_after,price_before,price_after,allocation,correction,part,return_line_id,shipped)
        values($1,'returned',$2,$3,$4,$2,$3,'kept','returned_customer',1,1,1,0,$5,$6,$7)`, [eventId, itemId, unitIndex, orderId, l.part, l.return_line_id, l.shipped]);
    };

    test('FREQ-642-AC-04: FREQ-641 の取り押さえが付いた元の着でも、交換の品の返金を結べる', async () => {
      const f = await hRefundFixture(db(), true, 2);
      const ret = await hReturn(db(), f, 1);
      const claimed = await hClaims(db(), f.itemId);
      expect(claimed.map(c => [c.paid_amount, c.refund_id, c.return_line_id])).toEqual([[17000, null, ret.lineId], [20000, null, null]]);
      const refund = await hBeginClaimed(f, 3000);
      const refundUnit = (await hClaims(db(), f.itemId)).find(c => c.refund_id === refund.refund_id)!;
      expect(refundUnit.paid_amount).toBe(20000);
      const eventId = await insertEvent(f.orderId);
      await insertLine(eventId, f.orderId, f.itemId, 0, { return_line_id: ret.lineId });
      await q('select private.order_unit_link_refund($1,$2,$3)', [eventId, refund.refund_id, 'now']);
      const unit0 = (await q('select refund_id,return_line_id,refund_before_shipment from public.order_line_unit_amounts where order_item_id=$1 and unit_index=0', [f.itemId])).rows[0];
      expect(unit0).toEqual({ refund_id: refund.refund_id, return_line_id: null, refund_before_shipment: false });
      expect((await q('select part from public.order_unit_event_refunds where event_id=$1 and refund_id=$2', [eventId, refund.refund_id])).rows).toEqual([{ part: 'now' }]);
    });

    test('FREQ-642-AC-04: 同じ返品の返金なら取り押さえをそのまま残し、結びは1行だけ', async () => {
      const f = await hRefundFixture(db(), true, 2);
      const ret = await hReturn(db(), f, 1);
      const received = await hReceive(db(), f, ret, 1, 'now');
      expect(received.refund_id).toBeTruthy();
      const before = await hClaims(db(), f.itemId);
      const claimedUnit = (await q('select unit_index from public.order_line_unit_amounts where order_item_id=$1 and refund_id=$2', [f.itemId, received.refund_id])).rows[0].unit_index as number;
      const eventId = await insertEvent(f.orderId, { return_id: ret.returnId });
      await insertLine(eventId, f.orderId, f.itemId, claimedUnit, { return_line_id: ret.lineId });
      await q('select private.order_unit_link_refund($1,$2,$3)', [eventId, received.refund_id, 'now']);
      await q('select private.order_unit_link_refund($1,$2,$3)', [eventId, received.refund_id, 'now']);
      expect(await hClaims(db(), f.itemId)).toEqual(before);
      expect((await q('select count(*)::int n from public.order_unit_event_refunds where event_id=$1', [eventId])).rows[0].n).toBe(1);
    });

    test('FREQ-642-AC-04: 別の返金が取っている着は結べず、部分の違う二重の結びも断る', async () => {
      const f = await hRefundFixture(db(), true, 2);
      const refundA = await hBeginClaimed(f, 3000);
      const taken = (await hClaims(db(), f.itemId)).find(c => c.refund_id === refundA.refund_id)!;
      const takenIndex = (await q('select unit_index from public.order_line_unit_amounts where order_item_id=$1 and refund_id=$2', [f.itemId, refundA.refund_id])).rows[0].unit_index as number;
      expect(taken.paid_amount).toBe(17000);
      await hResult(db(), refundA.refund_id, 'succeeded');
      const refundB = await hBeginClaimed(f, 2000);
      const eventId = await insertEvent(f.orderId);
      await insertLine(eventId, f.orderId, f.itemId, takenIndex);
      expect(await failure(() => q('select private.order_unit_link_refund($1,$2,$3)', [eventId, refundB.refund_id, 'now'])))
        .toMatchObject({ code: '23514', message: 'GROUP_H_REFUND_UNIT_MISMATCH' });
      await q('select private.order_unit_link_refund($1,$2,$3)', [eventId, refundA.refund_id, 'now']);
      expect(await failure(() => q('select private.order_unit_link_refund($1,$2,$3)', [eventId, refundA.refund_id, 'consult']))).toMatchObject({ message: 'UNIT_PRICING_INVALID' });
    });

    test('FREQ-642-AC-04: 取り押さえの重ね定義は共通の鍵を求め、番号を指定した着に付け外しする', async () => {
      const f = await hRefundFixture(db(), true, 2);
      const refund = await hBeginClaimed(f, 3000);
      await q('rollback'); await q('begin');
      expect(await failure(() => q('select private.group_h_claim_refund_units($1,$2,$3::integer[],false,null)', [refund.refund_id, f.itemId, [0]])))
        .toMatchObject({ message: 'GROUP_H_LOCK_REQUIRED' });
      expect(await failure(() => q('select private.group_h_release_return_units($1,$2::integer[])', [f.itemId, [0]]))).toMatchObject({ message: 'GROUP_H_LOCK_REQUIRED' });
    });

    test('FREQ-642-AC-04: 番号を指定して取ると paid_amount の和を返し、同じ返金でもう一度呼んでも何も変わらない', async () => {
      const f = await hRefundFixture(db(), true, 2);
      const refund = await hBeginClaimed(f, 3000);
      const claimedBefore = (await q('select unit_index from public.order_line_unit_amounts where order_item_id=$1 and refund_id=$2', [f.itemId, refund.refund_id])).rows[0].unit_index as number;
      const other = claimedBefore === 0 ? 1 : 0;
      const sum = async (indexes: number[]) => (await q('select private.group_h_claim_refund_units($1,$2,$3::integer[],false,null) as n', [refund.refund_id, f.itemId, indexes])).rows[0].n as number;
      expect(await sum([claimedBefore])).toBe(17000);
      const snapshot = await hClaims(db(), f.itemId);
      expect(await sum([claimedBefore])).toBe(17000);
      expect(await hClaims(db(), f.itemId)).toEqual(snapshot);
      expect(await sum([claimedBefore, other])).toBe(37000);
      expect((await hClaims(db(), f.itemId)).every(c => c.refund_id === refund.refund_id)).toBe(true);
      expect(await failure(() => q('select private.group_h_claim_refund_units($1,$2,$3::integer[],false,null)', [refund.refund_id, f.itemId, [0, 0]])))
        .toMatchObject({ code: '23514' });
      expect(await failure(() => q('select private.group_h_claim_refund_units($1,$2,$3::integer[],false,null)', [refund.refund_id, f.itemId, [5]])))
        .toMatchObject({ code: '23514' });
    });
  });

  describe('slot guard and event columns', () => {
    test('FREQ-642-AC-18: 枠の鍵の列は変わらず、状態は kept から返した状態へ一度だけ動く', async () => {
      const o = await setOrder();
      const slot = o.itemIds[1];
      expect(await failure(() => q('update public.order_unit_slots set unit_index=9 where order_item_id=$1', [slot]))).toMatchObject({ code: '55000', message: 'UNIT_SLOT_IMMUTABLE' });
      expect(await failure(() => q('update public.order_unit_slots set item_id=item_id+1 where order_item_id=$1', [slot]))).toMatchObject({ code: '55000', message: 'UNIT_SLOT_IMMUTABLE' });
      await q('update public.order_unit_slots set current_price=100 where order_item_id=$1', [slot]);
      await q("update public.order_unit_slots set state='returned_customer' where order_item_id=$1", [slot]);
      for (const to of ['kept', 'returned_shop']) {
        expect(await failure(() => q('update public.order_unit_slots set state=$2 where order_item_id=$1', [slot, to]))).toMatchObject({ code: '55000', message: 'UNIT_SLOT_IMMUTABLE' });
      }
      expect(await failure(() => q('update public.order_unit_slots set current_price=1 where order_item_id=$1', [slot]))).toMatchObject({ code: '55000', message: 'UNIT_SLOT_IMMUTABLE' });
      // The CHECK still answers for an unknown value.
      expect(await failure(() => q("update public.order_unit_slots set state='bogus' where order_item_id=$1", [o.itemIds[0]]))).toMatchObject({ code: '23514' });
    });

    test('FREQ-642-AC-18: 戻せるのは発送前の取り消しで返した枠だけ。取引の印と G の鍵が要り、返した枠の値段は動かない', async () => {
      await q('rollback'); await q('begin'); // no G lock yet
      const jacket = await createCatalogFixture(db());
      const o = await seedOrder({ lines: [{ catalog: jacket, unitPrice: 20000, quantity: 2 }] });
      const slot = o.itemIds[0];
      const insertEvent = async (kind: string) => (await q(`insert into public.order_unit_events(order_id,kind,entitlement_previous,entitlement_max_before,
        entitlement_gross,entitlement_shop_only,fee_amount,hold_total,entitlement,standard_refund,now_refund,consult_refund)
        values($1,$2,0,0,0,0,0,0,0,0,0,0) returning id`, [o.orderId, kind])).rows[0].id as string;
      const cancelEvent = await insertEvent('pre_shipment_cancel'); const returnEvent = await insertEvent('return_receive');
      await q("update public.order_unit_slots set state='returned_shop', last_event_id=$3 where order_item_id=$1 and unit_index=$2", [slot, 0, cancelEvent]);
      await q("update public.order_unit_slots set state='returned_shop', last_event_id=$3 where order_item_id=$1 and unit_index=$2", [slot, 1, returnEvent]);
      const revert = (i: number) => q("update public.order_unit_slots set state='kept' where order_item_id=$1 and unit_index=$2", [slot, i]);
      const flag = () => q("select set_config('app.unit_slot_revert', txid_current()::text, true)");
      expect(await failure(() => revert(0))).toMatchObject({ message: 'UNIT_SLOT_IMMUTABLE' });
      await flag();
      expect(await failure(() => revert(0))).toMatchObject({ message: 'GROUP_H_LOCK_REQUIRED' });
      await q('select pg_advisory_xact_lock(190521,1)');
      expect(await failure(() => revert(1))).toMatchObject({ message: 'UNIT_SLOT_IMMUTABLE' });
      await q("select set_config('app.unit_slot_revert','on',true)");
      expect(await failure(() => revert(0))).toMatchObject({ message: 'UNIT_SLOT_IMMUTABLE' });
      await flag();
      await revert(0);
      expect((await q('select state from public.order_unit_slots where order_item_id=$1 and unit_index=0', [slot])).rows[0].state).toBe('kept');
      expect(await failure(() => q('update public.order_unit_slots set current_price=1 where order_item_id=$1 and unit_index=1', [slot]))).toMatchObject({ message: 'UNIT_SLOT_IMMUTABLE' });
      expect(await failure(() => q('update public.order_unit_slots set holder_unit_index=5 where order_item_id=$1 and unit_index=1', [slot]))).toMatchObject({ message: 'UNIT_SLOT_IMMUTABLE' });
    });

    test('FREQ-642-AC-18: 出来事の金額の列は既定値を持たず、入れ忘れは NOT NULL で断る', async () => {
      const o = await setOrder();
      expect(await failure(() => q("insert into public.order_unit_events(order_id,kind) values($1,'return_receive')", [o.orderId]))).toMatchObject({ code: '23502' });
      const defaults = (await q(`select a.attname from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid='public.order_unit_events'::regclass and a.attname ~ '^(entitlement|fee_|hold_|standard_|now_|consult_)'`)).rows;
      expect(defaults).toEqual([]);
    });
  });

  describe('ACL', () => {
    const can = async (role: string, signature: string) =>
      (await q('select has_function_privilege($1,$2::regprocedure,\'EXECUTE\') as ok', [role, signature])).rows[0].ok as boolean;
    const hidden = [
      'private.order_unit_apply_plan(jsonb,uuid,uuid,uuid,uuid)', 'private.order_unit_link_refund(uuid,uuid,text)', 'private.order_unit_shipped_slots(uuid)',
      'private.group_h_claim_refund_units(uuid,uuid,integer[],boolean,uuid)', 'private.group_h_release_return_units(uuid,integer[])',
    ];

    test('FREQ-642-AC-18: 材料の入口だけ service_role が呼べ、記録・結び・取り押さえの関数は誰にも渡さない', async () => {
      for (const sig of hidden) for (const role of ['anon', 'authenticated', 'service_role']) expect([sig, role, await can(role, sig)]).toEqual([sig, role, false]);
      for (const sig of ['public.order_unit_pricing_materials(uuid)', 'private.order_unit_pricing_materials(uuid)']) {
        expect(await can('service_role', sig)).toBe(true);
        expect(await can('anon', sig)).toBe(false);
        expect(await can('authenticated', sig)).toBe(false);
      }
    });

    test('FREQ-642-AC-18: public の入口は service_role から private の材料を返し、利用者は呼べない', async () => {
      const o = await setOrder();
      await q('set local role service_role');
      const viaPublic = (await q('select public.order_unit_pricing_materials($1) as j', [o.orderId])).rows[0].j as UnitPricingMaterials;
      await q('reset role');
      expect(viaPublic.target.orderId).toBe(o.orderId);
      expect(viaPublic).toEqual(await materialsOf(o.orderId));
      expect(await failure(async () => { await q('set local role authenticated'); await q('select public.order_unit_pricing_materials($1)', [o.orderId]); }))
        .toMatchObject({ code: '42501' });
    });
  });
});

const ubcAssert = sql.split('-- UBC_FINAL_ASSERT_BEGIN\n')[1]?.split('-- UBC_FINAL_ASSERT_END')[0] ?? '';

describeLocalDb('FREQ-642-AC-18: unit binding migration B final assertion (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change = ''): Promise<Failure | null> {
    await db().query('savepoint ubc_assert');
    let failure: Failure | null = null;
    try { if (change) await db().query(change); await db().query(ubcAssert); }
    catch (caught) { const e = caught as Failure; failure = { code: e.code, message: e.message, detail: e.detail }; }
    finally { await db().query('rollback to savepoint ubc_assert'); await db().query('release savepoint ubc_assert'); }
    return failure;
  }
  const replaceBody = (signature: string, from: string, to: string) => `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), '${from}', '${to}'); end $x$`;

  test('FREQ-642-AC-18: 末尾の確かめは改変なしで通る', async () => {
    expect(ubcAssert).not.toBe('');
    expect(await attempt()).toBeNull();
  });

  test.each([
    ['alter table public.order_unit_events alter column fee_amount set default 0', 'ubc_schema'],
    ['drop trigger ub_order_unit_slots_guard on public.order_unit_slots', 'ubc_schema'],
    ['alter table public.order_unit_slots disable trigger ub_order_unit_slots_guard', 'ubc_schema'],
    ['grant execute on function private.order_unit_apply_plan(jsonb,uuid,uuid,uuid,uuid) to service_role', 'ubc_acl'],
    ['grant execute on function private.group_h_claim_refund_units(uuid,uuid,integer[],boolean,uuid) to authenticated', 'ubc_acl'],
    ['revoke execute on function public.order_unit_pricing_materials(uuid) from service_role', 'ubc_acl'],
    [replaceBody('private.order_unit_apply_plan(jsonb,uuid,uuid,uuid,uuid)', 'UNIT_PRICING_STALE', 'UNIT_PRICING_STALX'), 'ubc_functions'],
    [replaceBody('private.order_unit_pricing_materials(uuid)', 'STABLE', 'VOLATILE'), 'ubc_functions'],
    ['drop function private.order_unit_link_refund(uuid,uuid,text)', 'ubc_functions'],
  ])('FREQ-642-AC-18: 改変 %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'UNIT_BINDING_CORE_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
