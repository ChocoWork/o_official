/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { planUnitEvent } from '@/lib/orders/unit-pricing/unit-event-plan';
import { buildOrder } from '../../unit/lib/orders/unit-pricing/fixtures';
import { seedFactSlip, seedUnitOrder } from './helpers/accounting-orders-fixtures';
import { seedPreShipmentCancel, seedRefundFlow } from './helpers/accounting-returns-fixtures';
import { seedHMember, seedHOrderUnits, seedHUnitSlots, type HCatalog } from './helpers/group-h-fixtures';
import { hResult } from './helpers/group-h-refund-fixtures';
import { connectLocalDb, describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, shipFixtureOrder } from './helpers/order-fixtures';
import { createUbReturn, materialsOf, ubReceive } from './helpers/unit-binding-receive';

// 計画3 Task 3（S17）: 出荷前の返金の割り当て・値段の直し・差の行（規則1〜4）と、出荷済みの着の決め方（裁定 P3-6・P3-C1）。
// 仕訳の残高（前受金・売上）は Task 6 の表で確かめ、ここは割り当て・直し・事実だけを確かめる（preflight #20）。
jest.setTimeout(90000);

type Line = { item: string; unit: number; kind: 'returned' | 'kept'; allocation?: number; correction?: number; shipped?: boolean };

describeLocalDb('FREQ-577-AC-03: S17 refund allocations', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  const num = async (text: string, params?: unknown[]) => Number((await q(text, params)).rows[0].n);
  const allocs = async (key: string) => (await q(`select order_item_id, unit_index, amount from public.accounting_unit_refund_allocations
    where refund_key=$1 order by order_item_id, unit_index`, [key])).rows;
  const priceAdjusts = async (key: string) => (await q(`select order_item_id, unit_index, amount from public.accounting_unit_price_adjusts
    where adjust_key=$1 order by order_item_id, unit_index`, [key])).rows;
  const transfers = async (eventId: string) => (await q(`select order_item_id, unit_index, amount, fact_seq from public.accounting_refund_transfer_adjusts
    where event_id=$1 and adjust_key=$1::text order by order_item_id, unit_index`, [eventId])).rows;
  const values = async (orderId: string, asOf: number | null = null) => (await q(
    'select order_item_id, unit_index, shipped, value from private.accounting_unit_values($1,$2) order by order_item_id, unit_index', [orderId, asOf])).rows;
  const facts = async (refundId: string) => (await q('select * from public.accounting_refund_facts where refund_id=$1', [refundId])).rows[0];
  const pending = async (sourceId: string) => (await q(`select reason, detail from public.accounting_pending_events where source_id=$1`, [sourceId])).rows;
  const immediate = async () => { await q('set constraints all immediate'); await q('set constraints all deferred'); };

  /** 着の行と枠（order_unit_slots）だけを持つ注文。値段の計画を通さない出来事を fixture で入れる時に使う。 */
  async function slotOrder(lines: number[][]) {
    const o = await seedUnitOrder(db(), lines);
    await q(`insert into public.order_unit_slots(order_item_id, unit_index, order_id, item_id, state, current_price, holder_order_item_id, holder_unit_index)
      select u.order_item_id, u.unit_index, oi.order_id, oi.item_id, 'kept', u.paid_amount, u.order_item_id, u.unit_index
      from public.order_line_unit_amounts u join public.order_items oi on oi.id=u.order_item_id where oi.order_id=$1`, [o.orderId]);
    return o;
  }
  /** 発送前の取り消しの出来事を fixture で直接入れる（交換の設計の関数では作れない値の組を試す時。試験ごとに理由を書く）。 */
  async function fixtureEvent(orderId: string, lines: Line[], standard = 0) {
    const eventId = (await q(`insert into public.order_unit_events(order_id, kind, entitlement_previous, entitlement_max_before, entitlement_gross,
      entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund)
      values($1,'pre_shipment_cancel',0,0,0,0,0,0,0,$2,$2,0) returning id`,
      [orderId, standard])).rows[0].id as string;
    for (const l of lines) {
      await q(`insert into public.order_unit_event_lines(event_id, line_kind, order_item_id, unit_index, slot_order_id, holder_order_item_id, holder_unit_index,
        state_before, state_after, price_before, price_after, allocation, correction, part, shipped)
        values($1,$2,$3,$4,$5,$3,$4,'kept',$6,0,0,$7,$8,$9,$10)`,
      [eventId, l.kind, l.item, l.unit, orderId, l.kind === 'returned' ? 'returned_shop' : 'kept', l.allocation ?? 0, l.correction ?? 0,
        l.kind === 'returned' ? 'now' : null, l.shipped ?? false]);
      if (l.kind === 'returned') await q("update public.order_unit_slots set state='returned_shop', last_event_id=$3 where order_item_id=$1 and unit_index=$2", [l.item, l.unit, eventId]);
    }
    return eventId;
  }
  /** fixture の出来事に返金を1本結び、コアと同じ順（状態の行 → 事実 → 出来事の割り当て）で書く。 */
  async function fixtureRefund(orderId: string, eventId: string | null, amount: number, lines: Array<{ item: string; before: boolean; amount: number }> = []) {
    const linesAmount = lines.reduce((s, l) => s + l.amount, 0);
    const refundId = (await q(`insert into public.order_refunds(order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, adjustment_amount, notify_customer)
      values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',$2,0,$3,false) returning id`, [orderId, amount, amount - linesAmount])).rows[0].id as string;
    for (const l of lines) {
      await q(`insert into public.order_refund_lines(refund_id, order_item_id, quantity, before_shipment, restock_type, amount) values($1,$2,1,$3,'no_restock',$4)`,
        [refundId, l.item, l.before, l.amount]);
    }
    if (eventId) await q("insert into public.order_unit_event_refunds(event_id, refund_id, part) values($1,$2,'now')", [eventId, refundId]);
    await q("select private.accounting_record_refund_event($1,'requested')", [refundId]);
    await q('select private.accounting_record_refund_facts($1)', [refundId]);
    if (eventId) await q('select private.accounting_record_event_allocations($1)', [eventId]);
    else await q('select private.accounting_write_refund_allocations($1)', [refundId]);
    return refundId;
  }
  /** 同じ値段の2着（写しあり、払い済み）。交換の印の作業の R33 の試験と同じ作り。 */
  async function equalOrder(price = 20000) {
    const catalog = await createCatalogFixture(db(), { stock: 2 });
    const userId = await seedHMember(db());
    const seeded = await seedHOrderUnits(db(), { legacy: false, buyerUserId: userId, createdAt: '2026-11-01T00:00:00Z',
      lines: [{ itemPrice: price, quantity: 2, catalog: catalog as HCatalog, unitAmounts: [price, price], discounts: [] }] });
    const itemId = seeded.orderItemIds[0];
    const built = buildOrder({ orderId: seeded.orderId, lines: [{ orderItemId: itemId, itemId: catalog.itemId, unitPrice: price, quantity: 2 }] });
    const facts = Object.fromEntries(Object.entries(built.snapshot.facts).filter(([k]) => k !== 'phase'));
    facts.buyer = { kind: 'member', userId };
    await seedHUnitSlots(db(), { orderId: seeded.orderId, snapshot: { engineVersion: 1, definitions: built.snapshot.definitions, codes: built.snapshot.codes, facts, lines: built.snapshot.lines } });
    await q('update public.orders set paid_amount=total_amount, payment_intent_id=$2 where id=$1', [seeded.orderId, `pi_s17_${randomUUID().replaceAll('-', '')}`]);
    return { orderId: seeded.orderId, itemId, actor: userId, catalog };
  }
  const bothShipped = async (itemId: string) => {
    const a = (await q('select unit_index from private.accounting_shipped_units($1,null) order by unit_index', [itemId])).rows;
    const b = (await q('select unit_index from private.order_unit_shipped_slots($1)', [itemId])).rows;
    expect(b).toEqual(a);
    return a.map((r) => r.unit_index as number);
  };

  describe('pre-shipment cancel events (rules 2 and 3)', () => {
    test('FREQ-577-AC-03: 発送前に1着を取り消すと、交換の設計の割り振りのとおりその着に全額の割り当てが入り、キーは出来事の id', async () => {
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      const line = (await q("select order_item_id, unit_index, allocation from public.order_unit_event_lines where event_id=$1 and line_kind='returned'", [c.eventId])).rows[0];
      expect(await allocs(c.eventId)).toEqual([{ order_item_id: line.order_item_id, unit_index: line.unit_index, amount: line.allocation }]);
      expect((await values(f.orderId)).find((v) => v.unit_index === line.unit_index)!.value).toBe(0);
      await immediate();
    });

    test('FREQ-577-AC-03: 交換の品だけを発送前に取り消す（元の着は出荷済み）と、割り当ても値段の直しも書かず、計上待ちも置かず、返金の事実は出荷後の額（Q）で event_kind が pre_shipment_cancel', async () => {
      const f = await seedRefundFlow(db(), true);
      const ex = await createUbReturn(db(), f, [{ quantity: 1, exchange: true }]);
      const received = await ubReceive(db(), { returnId: ex.returnId, actorId: f.actor, choice: 'none',
        units: [{ return_line_id: ex.lineIds[0], disposition: 'not_restocked', quantity: 1 }] });
      const exchangeItemId = received.exchange_order_item_ids[0] as string;
      const c = await seedPreShipmentCancel(db(), f, { itemId: exchangeItemId, quantity: 1 });
      expect(await allocs(c.eventId)).toEqual([]);
      expect(await priceAdjusts(c.eventId)).toEqual([]);
      expect(await transfers(c.eventId)).toEqual([]);
      expect(await pending(`allocation:${c.eventId}`)).toEqual([]);
      expect(await facts(c.refundId)).toMatchObject({ event_id: c.eventId, event_kind: 'pre_shipment_cancel', pre_shipment_amount: 0,
        post_shipment_amount: c.amount, shipping_amount: 0 });
    });

    test('FREQ-577-AC-03: 通常の着と交換の品を一緒に発送前に取り消すと、通常の着の分だけに割り当てが入り、写す値段の直しの合計が V_P − P になる', async () => {
      // 3着のうち2着を送り、1着を交換で返す。交換の品（結びの元の着は出荷済み）とまだ送っていない通常の着を、1つの値段の計画で
      // 一緒に取り消す。どの元の着に結ばれるかは交換の印の作業が決めるので、出来事の行（元の着と shipped）を読んで確かめる。
      const f = await seedRefundFlow(db(), 2, 3);
      const ex = await createUbReturn(db(), f, [{ quantity: 1, exchange: true }]);
      const received = await ubReceive(db(), { returnId: ex.returnId, actorId: f.actor, choice: 'none',
        units: [{ return_line_id: ex.lineIds[0], disposition: 'not_restocked', quantity: 1 }] });
      const exchangeItemId = received.exchange_order_item_ids[0] as string;
      const before = await values(f.orderId);
      const plan = planUnitEvent((await materialsOf(db(), f.orderId))!, { kind: 'pre_shipment_cancel',
        cancels: [{ orderItemId: f.itemId, quantity: 1 }, { orderItemId: exchangeItemId, quantity: 1 }] });
      const lines = [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }, { order_item_id: exchangeItemId, before_shipment: true, quantity: 1 }];
      const row = (await q(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,$4,null,'requested_by_customer',null,false,$5,null,$6::jsonb)`,
        [f.orderId, randomUUID(), JSON.stringify(lines), plan.standardRefund, f.actor, JSON.stringify(plan)])).rows[0] as { refund_id: string };
      const eventId = (await q('select event_id from public.order_unit_event_refunds where refund_id=$1', [row.refund_id])).rows[0].event_id as string;
      const returned = (await q(`select order_item_id, unit_index, holder_order_item_id, allocation, shipped from public.order_unit_event_lines
        where event_id=$1 and line_kind='returned' order by order_item_id, unit_index`, [eventId])).rows;
      // 場面の前提: 交換の品の行は出荷済みの元の着、通常の着の行はまだ送っていない着
      expect(returned.find((l) => l.holder_order_item_id === exchangeItemId)).toMatchObject({ shipped: true });
      const normal = returned.filter((l) => !l.shipped);
      expect(normal).toHaveLength(1);
      expect(await allocs(eventId)).toEqual(normal.map((l) => ({ order_item_id: l.order_item_id, unit_index: l.unit_index, amount: l.allocation })));
      const fact = await facts(row.refund_id);
      expect(fact.post_shipment_amount).toBeGreaterThan(0);
      const vp = normal.reduce((sum, l) => sum + before.find((v) => v.order_item_id === l.order_item_id && v.unit_index === l.unit_index)!.value, 0);
      const written = [...await priceAdjusts(eventId), ...await transfers(eventId)].reduce((sum, x) => sum + x.amount, 0);
      expect(written).toBe(vp - fact.pre_shipment_amount);
      expect(await pending(`allocation:${eventId}`)).toEqual([]);
      await immediate();
    });

    test('FREQ-577-AC-10: 出荷済みの着が残る取り消し（20,000円と17,000円、17,000円の着を出荷済み）で、残る着の +3,000円の直しが差の表に出来事の id と番号つきで残る', async () => {
      // fixture: 出荷済みの着は番号の若い着から決まる（裁定 P3-6）ので、同じ品の2着では 17,000円の着だけを先に送れない。
      // 2つの品（20,000円・17,000円）に分け、交換の設計の記録（割り振り 20,000円・残る着の直し +3,000円・返す額 17,000円）を直接入れる。
      const o = await slotOrder([[20000], [17000]]);
      const [dear, cheap] = o.orderItemIds;
      await seedFactSlip(db(), { orderItemId: cheap, quantity: 1 });
      const eventId = await fixtureEvent(o.orderId, [{ item: dear, unit: 0, kind: 'returned', allocation: 20000 },
        { item: cheap, unit: 0, kind: 'kept', correction: 3000, shipped: true }], 17000);
      const refundId = await fixtureRefund(o.orderId, eventId, 17000);
      expect(await facts(refundId)).toMatchObject({ pre_shipment_amount: 17000, post_shipment_amount: 0 });
      const t = await transfers(eventId);
      expect(t).toMatchObject([{ order_item_id: cheap, unit_index: 0, amount: 3000 }]);
      expect(Number(t[0].fact_seq)).toBeGreaterThan(0);
      expect(await priceAdjusts(eventId)).toEqual([]);
      await immediate();
    });

    test('FREQ-577-AC-10: まだ送っていない着が残る取り消しで、残る着の値段の直しが値段の直しの表に残り、その着の出荷の額が支払額＋直しになる', async () => {
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      const fact = await facts(c.refundId);
      const returned = (await q("select unit_index, allocation from public.order_unit_event_lines where event_id=$1 and line_kind='returned'", [c.eventId])).rows[0];
      const keptAdj = (await priceAdjusts(c.eventId)).filter((a) => a.unit_index !== returned.unit_index);
      const vp = returned.allocation; // 取り消す前の値打ち = 支払額（割り当ても直しも無い）
      expect(keptAdj.reduce((s, a) => s + a.amount, 0)).toBe(vp - fact.pre_shipment_amount);
      const kept = (await values(f.orderId)).find((v) => v.unit_index !== returned.unit_index)!;
      const paid = (await q('select paid_amount from public.order_line_unit_amounts where order_item_id=$1 and unit_index=$2', [f.itemId, kept.unit_index])).rows[0].paid_amount;
      expect(kept.value).toBe(paid + keptAdj.reduce((s, a) => s + a.amount, 0));
      await immediate();
    });

    test('FREQ-577-AC-10: 引かれた時（W）の値打ちは、時刻を番号に直した後の値段の直しを含む', async () => {
      const o = await slotOrder([[10000], [6000], [4000]]);
      const [a, b, c] = o.orderItemIds;
      // fixture: 交換の設計の関数では r を作れないので出来事を直接入れる
      const eventId = await fixtureEvent(o.orderId, [{ item: a, unit: 0, kind: 'returned', allocation: 10000 }, { item: b, unit: 0, kind: 'kept' }, { item: c, unit: 0, kind: 'kept' }]);
      await fixtureRefund(o.orderId, eventId, 9000);
      const seq = await num('select private.accounting_g_fact_seq_at(clock_timestamp()) n');
      const maxAdj = await num('select max(fact_seq) n from public.accounting_unit_price_adjusts where event_id=$1', [eventId]);
      expect(seq).toBeGreaterThanOrEqual(maxAdj);
      const byItem = Object.fromEntries((await values(o.orderId, seq)).map((v) => [v.order_item_id, v.value]));
      expect([byItem[a], byItem[b], byItem[c]]).toEqual([0, 6600, 4400]);
    });

    test('FREQ-577-AC-10: 発送後の返品と前の注文から差し引いた分の直しは、差の表にも値段の直しの表にも写らない', async () => {
      const f = await seedRefundFlow(db(), true);
      const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
      await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [{ return_line_id: ret.lineIds[0], disposition: 'not_restocked', quantity: 1 }] });
      const eventId = (await q("select id from public.order_unit_events where order_id=$1 and kind='return_receive'", [f.orderId])).rows[0].id;
      await q('select private.accounting_record_event_allocations($1)', [eventId]);
      expect(await num('select count(*) n from public.accounting_unit_price_adjusts where event_id=$1', [eventId])).toBe(0);
      expect(await num('select count(*) n from public.accounting_refund_transfer_adjusts where event_id=$1', [eventId])).toBe(0);
      expect(await num('select count(*) n from public.accounting_unit_refund_allocations where refund_key=$1', [eventId])).toBe(0);
    });

    test('FREQ-577-AC-10: 受け取りで残る着の値段が上がった後（帳簿には写さない）にその着を発送前に取り消すと、P は会計の値打ち V_P で止まり、超えた分は Q、写す直しは0で、着の値打ちは0で終わり負にならず、計上待ちは0', async () => {
      // fixture: 受け取りで上がった記録の値段（12,000円）を交換の設計の関数で作る代わりに、出来事の割り振りを直接入れる
      const o = await slotOrder([[10000, 10000]]);
      const item = o.orderItemIds[0];
      const eventId = await fixtureEvent(o.orderId, [{ item, unit: 0, kind: 'returned', allocation: 12000 }]);
      const refundId = await fixtureRefund(o.orderId, eventId, 12000);
      expect(await facts(refundId)).toMatchObject({ pre_shipment_amount: 10000, post_shipment_amount: 2000 });
      expect(await allocs(eventId)).toEqual([{ order_item_id: item, unit_index: 0, amount: 12000 }]);
      expect(await priceAdjusts(eventId)).toEqual([{ order_item_id: item, unit_index: 0, amount: 2000 }]);
      expect((await values(o.orderId)).map((v) => v.value)).toEqual([0, 10000]);
      expect(await pending(`allocation:${eventId}`)).toEqual([]);
      await immediate();
    });

    test('FREQ-577-AC-10: 前の出来事で E が最高より下がった後の発送前の取り消しでも、残る着へ写す直しの合計は V_P − P で、r ＝ E_max_before − E_prev が値打ちの比で分かれる', async () => {
      // fixture（裁定 B4 と同じ）: 公開の関数で E を下げてから直しの無い取り消しを作る道が無いので、出来事の行を直接入れる。
      // 返す額 9,000円（= 割り振り 10,000円 − (E_max_before − E_prev) 1,000円）。
      const o = await slotOrder([[10000], [6000], [4000]]);
      const [a, b, c] = o.orderItemIds;
      const eventId = await fixtureEvent(o.orderId, [{ item: a, unit: 0, kind: 'returned', allocation: 10000 }, { item: b, unit: 0, kind: 'kept' }, { item: c, unit: 0, kind: 'kept' }]);
      await fixtureRefund(o.orderId, eventId, 9000);
      const adj = Object.fromEntries((await priceAdjusts(eventId)).map((x) => [x.order_item_id, x.amount]));
      expect([adj[b], adj[c]]).toEqual([600, 400]);
      expect(adj[a]).toBeUndefined();
      await immediate();
    });

    test('FREQ-577-AC-10: 残る着の重みの合計が0で r が0でない出来事は、r の分を書かずに unit_value_left の計上待ちに置き、取り消しは落ちず、どの着の値打ちも0未満にならない', async () => {
      // fixture: 公開の関数では作れないので出来事の行を直接入れる。残る着は前の割り当てで値打ち0。
      const o = await slotOrder([[10000], [5000]]);
      const [a, b] = o.orderItemIds;
      await q("select private.accounting_record_unit_refund('fixture-prior', $1, 0, 5000)", [b]);
      const eventId = await fixtureEvent(o.orderId, [{ item: a, unit: 0, kind: 'returned', allocation: 10000 }, { item: b, unit: 0, kind: 'kept' }]);
      await fixtureRefund(o.orderId, eventId, 9000);
      expect(await pending(`allocation:${eventId}`)).toEqual([{ reason: 'amount_mismatch', detail: { mismatch: 'unit_value_left' } }]);
      expect((await priceAdjusts(eventId)).filter((x) => x.order_item_id === b)).toEqual([]);
      expect((await values(o.orderId)).every((v) => v.value >= 0)).toBe(true);
      await immediate();
    });

    test('FREQ-577-AC-10: 同じ取り消しの出来事で値段が下がる残る着と上がる残る着がある時（Σc ≥ 0）、どちらにも記録の直しがそのまま当たり（r ＝ 0）、accounting_allocate_amount は呼ばれず、取り消しは落ちない', async () => {
      // fixture: 公開の関数でこの組を作れないので出来事の行を直接入れる。V_P − P = 1,000円 = Σc（−500 + 1,500）。
      const o = await slotOrder([[10000], [6000], [4000]]);
      const [a, b, c] = o.orderItemIds;
      const eventId = await fixtureEvent(o.orderId, [{ item: a, unit: 0, kind: 'returned', allocation: 10000 },
        { item: b, unit: 0, kind: 'kept', correction: -500 }, { item: c, unit: 0, kind: 'kept', correction: 1500 }]);
      await fixtureRefund(o.orderId, eventId, 9000);
      const adj = Object.fromEntries((await priceAdjusts(eventId)).map((x) => [x.order_item_id, x.amount]));
      expect([adj[b], adj[c]]).toEqual([-500, 1500]);
      expect(await pending(`allocation:${eventId}`)).toEqual([]);
      await immediate();
    });

    test('FREQ-577-AC-10: r < 0 で、まだ送っていない残る着の値打ちを超えて引く時は、r の分を書かずに unit_value_left に置き、値打ちは0未満にならない', async () => {
      // fixture: 出荷済みの0円の着に +5,000円の記録の直し（重み0）、まだ送っていない100円の着（重み100）。r = −5,000円。
      const o = await slotOrder([[0], [100], [10000]]);
      const [a, b, c] = o.orderItemIds;
      await seedFactSlip(db(), { orderItemId: a, quantity: 1 });
      const eventId = await fixtureEvent(o.orderId, [{ item: c, unit: 0, kind: 'returned', allocation: 10000 },
        { item: a, unit: 0, kind: 'kept', correction: 5000, shipped: true }, { item: b, unit: 0, kind: 'kept' }]);
      await fixtureRefund(o.orderId, eventId, 10000);
      expect(await pending(`allocation:${eventId}`)).toEqual([{ reason: 'amount_mismatch', detail: { mismatch: 'unit_value_left' } }]);
      expect(await transfers(eventId)).toMatchObject([{ order_item_id: a, unit_index: 0, amount: 5000 }]);
      expect((await priceAdjusts(eventId)).filter((p) => p.order_item_id === b)).toEqual([]);
      expect((await values(o.orderId)).every((v) => v.value >= 0)).toBe(true);
      await immediate();
    });

    test('FREQ-577-AC-10: 記録の割り当てが会計の値打ちより大きい返す着は、値打ちを0にする直しと一緒に書くので allocation_overflow にならない', async () => {
      // fixture: 前の出来事の −2,000円の直しで値打ち 8,000円になった着に、記録の割り当て 10,000円。
      const o = await slotOrder([[10000, 10000]]);
      const item = o.orderItemIds[0];
      const prior = await fixtureEvent(o.orderId, []);
      await q(`insert into public.accounting_unit_price_adjusts(order_item_id, unit_index, adjust_key, event_id, amount, fact_seq, locked_at)
        select $1, 0, 'fixture-prior', $2, -2000, t.fact_seq, t.locked_at from private.accounting_take_g_fact_seq() t`, [item, prior]);
      const eventId = await fixtureEvent(o.orderId, [{ item, unit: 0, kind: 'returned', allocation: 10000 }]);
      await fixtureRefund(o.orderId, eventId, 8000);
      expect(await allocs(eventId)).toEqual([{ order_item_id: item, unit_index: 0, amount: 10000 }]);
      expect(await priceAdjusts(eventId)).toEqual([{ order_item_id: item, unit_index: 0, amount: 2000 }]);
      expect(await pending(`allocation:${eventId}`)).toEqual([]);
      expect((await values(o.orderId))[0].value).toBe(0);
      await immediate();
    });

    test('FREQ-577-AC-10: 同じ注文で2回発送前に取り消し、1回目でまだ送っていない着に値段の直しが付き、2回目でその着を取り消すと、割り当ての上限は支払額でなく値打ちで、取り消した着の値打ちが0で終わり、COMMIT で落ちない', async () => {
      const f = await seedRefundFlow(db(), false);
      const first = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      await hResult(db(), first.refundId, 'succeeded');
      const second = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      expect(second.eventId).not.toBe(first.eventId);
      expect((await values(f.orderId)).map((v) => v.value)).toEqual([0, 0]);
      await immediate();
    });

    test('FREQ-577-AC-10: 値段の直しがマイナスの着に品を指定しない返金を割り振っても、値打ちを超えて書かず、出荷の額がマイナスにならない', async () => {
      const o = await slotOrder([[1000, 1000]]);
      const item = o.orderItemIds[0];
      const prior = await fixtureEvent(o.orderId, []);
      await q(`insert into public.accounting_unit_price_adjusts(order_item_id, unit_index, adjust_key, event_id, amount, fact_seq, locked_at)
        select $1, 0, 'fixture-prior', $2, -800, t.fact_seq, t.locked_at from private.accounting_take_g_fact_seq() t`, [item, prior]);
      const refundId = await fixtureRefund(o.orderId, null, 1200);
      const a = await allocs(refundId);
      expect(a.reduce((s, x) => s + x.amount, 0)).toBe(1200);
      for (const v of await values(o.orderId)) expect(v.value).toBeGreaterThanOrEqual(0);
      await immediate();
    });

    test('FREQ-577-AC-10: セットで組の中の安いジャケットを発送前に取り消すと、出荷済みの組の外のジャケットにマイナスの直しが付き、d がマイナス', async () => {
      // fixture: セットの割引の計画は交換の設計の関数の受け持ちなので、記録の直し（出荷済みの組の外の着に −1,500円）を直接入れる。
      const o = await slotOrder([[8000], [10000], [12000]]);
      const [cheap, inSet, other] = o.orderItemIds;
      await seedFactSlip(db(), { orderItemId: other, quantity: 1 });
      const eventId = await fixtureEvent(o.orderId, [{ item: cheap, unit: 0, kind: 'returned', allocation: 8000 },
        { item: inSet, unit: 0, kind: 'kept', correction: 3000 }, { item: other, unit: 0, kind: 'kept', correction: -1500, shipped: true }]);
      await fixtureRefund(o.orderId, eventId, 6500);
      const t = await transfers(eventId);
      expect(t).toMatchObject([{ order_item_id: other, amount: -1500 }]);
      expect(await priceAdjusts(eventId)).toEqual([{ order_item_id: inSet, unit_index: 0, amount: 3000 }]);
      await immediate();
    });
  });

  describe('refunds not tied to an event (rule 2, P and Q)', () => {
    test('FREQ-577-AC-03: 明細なしの出荷前のお詫び1,000円は、設計 5-g の比（出荷済み18,750・未出荷11,250）で出荷前の額375円と出荷後の額625円に分かれ、375円がまだ送っていないパンツの割り当てになる', async () => {
      const o = await seedUnitOrder(db(), [[18750], [5625, 5625]]);
      await seedFactSlip(db(), { orderItemId: o.orderItemIds[0], quantity: 1 });
      const refundId = await fixtureRefund(o.orderId, null, 1000);
      expect(await facts(refundId)).toMatchObject({ pre_shipment_amount: 375, post_shipment_amount: 625, event_kind: 'none' });
      const a = await allocs(refundId);
      expect(a.map((x) => x.order_item_id)).toEqual([o.orderItemIds[1], o.orderItemIds[1]]);
      expect(a.map((x) => x.amount)).toEqual([188, 187]);
      await immediate();
    });

    test('FREQ-577-AC-04: 品を決めない額は、出荷した分とまだの分の値打ちの比で出荷前の額と出荷後の額に分かれ、出荷前の額はまだ送っていない着へ残りの値打ちの比で割り振られ、端数は番号の若い着から足される', async () => {
      const o = await seedUnitOrder(db(), [[3000], [1000, 1000, 1000]]);
      await seedFactSlip(db(), { orderItemId: o.orderItemIds[0], quantity: 1 });
      const refundId = await fixtureRefund(o.orderId, null, 1000);
      expect(await facts(refundId)).toMatchObject({ pre_shipment_amount: 500, post_shipment_amount: 500 });
      expect((await allocs(refundId)).map((x) => [x.unit_index, x.amount])).toEqual([[0, 167], [1, 167], [2, 166]]);
      await immediate();
    });

    test('FREQ-577-AC-04: 重みの合計が0の品を決めない額は全部出荷後の額になる', async () => {
      const o = await seedUnitOrder(db(), [[1000]]);
      await q("select private.accounting_record_unit_refund('fixture-full', $1, 0, 1000)", [o.orderItemIds[0]]);
      const refundId = await fixtureRefund(o.orderId, null, 500);
      expect(await facts(refundId)).toMatchObject({ pre_shipment_amount: 0, post_shipment_amount: 500 });
      expect(await allocs(refundId)).toEqual([]);
    });

    test('FREQ-577-AC-04: シャツ18,750円出荷済み、パンツ2着5,625円ずつ未出荷で、パンツ1着の返金（P₀ = 5,625円）と品を決めない1,000円なら、重みは[5,625, 18,750]で P_adj は231円', async () => {
      const o = await seedUnitOrder(db(), [[18750], [5625, 5625]]);
      const [shirt, pants] = o.orderItemIds;
      await seedFactSlip(db(), { orderItemId: shirt, quantity: 1 });
      // パンツ1着は前の出来事で全額の割り当てを受けている（値打ち0）
      await q("select private.accounting_record_unit_refund('fixture-pant', $1, 0, 5625)", [pants]);
      const refundId = await fixtureRefund(o.orderId, null, 6625, [{ item: pants, before: true, amount: 5625 }]);
      expect(await facts(refundId)).toMatchObject({ pre_shipment_amount: 5625 + 231, post_shipment_amount: 769 });
      expect(await allocs(refundId)).toEqual([{ order_item_id: pants, unit_index: 1, amount: 231 }]);
      await immediate();
    });

    test('FREQ-577-AC-04: 規約の手数料などで明細より少ない返金（マイナスの調整）、明細の片方が0のマイナスの調整でも、PとQが0未満にならず返金が落ちない', async () => {
      // 2着を出荷済み・1着が未発送（発送後の行を2本書くため）
      const f = await seedRefundFlow(db(), 2, 3);
      const r1 = await fixtureRefund(f.orderId, null, 7000, [{ item: f.itemId, before: true, amount: 5000 }, { item: f.itemId, before: false, amount: 3000 }]);
      expect(await facts(r1)).toMatchObject({ pre_shipment_amount: 4375, post_shipment_amount: 2625 });
      const r2 = await fixtureRefund(f.orderId, null, 2500, [{ item: f.itemId, before: false, amount: 3000 }]);
      expect(await facts(r2)).toMatchObject({ pre_shipment_amount: 0, post_shipment_amount: 2500 });
      expect(await pending(r1)).toEqual([]);
      expect(await pending(r2)).toEqual([]);
    });

    test('FREQ-577-AC-04: 割り当ての計算が合わない入力でも返金を始める関数は落ちず、計上待ち（allocation_overflow）が置かれる', async () => {
      const o = await seedUnitOrder(db(), [[1000]]);
      const refundId = (await q(`insert into public.order_refunds(order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, adjustment_amount, notify_customer)
        values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',5000,0,5000,false) returning id`, [o.orderId])).rows[0].id as string;
      // 事実の P が値打ちの合計を超える入力（事実を直接入れる）
      await q(`insert into public.accounting_refund_facts(refund_id, order_id, source, pre_shipment_amount, post_shipment_amount, shipping_amount)
        values($1,$2,'admin',5000,0,0)`, [refundId, o.orderId]);
      await q('select private.accounting_write_refund_allocations($1)', [refundId]);
      expect(await allocs(refundId)).toEqual([]);
      expect(await pending(`allocation:${refundId}`)).toEqual([{ reason: 'amount_mismatch', detail: { mismatch: 'allocation_overflow' } }]);
    });

    test('FREQ-577-AC-04: 一部だけ出荷した注文の出荷後の分は割り当てにならず、出荷後の額として事実に残る', async () => {
      const o = await seedUnitOrder(db(), [[4000], [1000]]);
      await seedFactSlip(db(), { orderItemId: o.orderItemIds[0], quantity: 1 });
      const refundId = await fixtureRefund(o.orderId, null, 500);
      expect(await facts(refundId)).toMatchObject({ pre_shipment_amount: 100, post_shipment_amount: 400 });
      expect(await allocs(refundId)).toEqual([{ order_item_id: o.orderItemIds[1], unit_index: 0, amount: 100 }]);
    });
  });

  describe('idempotence and the refund outcome (FREQ-577-AC-05/06/08)', () => {
    test('FREQ-577-AC-05: 全額の割り当てを受けた着は、同じ出来事の返金を2回始めても、2回目で割り当てが重ならない', async () => {
      const f = await seedRefundFlow(db(), false);
      const key = randomUUID();
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1, key });
      const before = await allocs(c.eventId);
      const plan = planUnitEvent((await materialsOf(db(), f.orderId))!, { kind: 'pre_shipment_cancel', cancels: [{ orderItemId: f.itemId, quantity: 1 }] });
      const again = (await q(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,$4,null,'requested_by_customer',null,false,$5,null,$6::jsonb)`,
        [f.orderId, key, JSON.stringify([{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }]), c.amount, f.actor, JSON.stringify(plan)])).rows[0];
      expect(again.replayed).toBe(true);
      expect(await allocs(c.eventId)).toEqual(before);
      await immediate();
    });

    test('FREQ-577-AC-06: 同じ出来事の割り当ての道具を2回呼んでも行が増えず、主キーがぶつからない', async () => {
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      const snapshot = [await allocs(c.eventId), await priceAdjusts(c.eventId), await transfers(c.eventId)];
      await q('select private.accounting_record_event_allocations($1)', [c.eventId]);
      await q('select private.accounting_record_event_allocations($1)', [c.eventId]);
      expect([await allocs(c.eventId), await priceAdjusts(c.eventId), await transfers(c.eventId)]).toEqual(snapshot);
    });

    test('FREQ-577-AC-06: 返金が error になっても、error から pending・succeeded・failed へ抜けても、割り当てと直しの行は増えも減りもしない', async () => {
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      const snap = async () => [await allocs(c.eventId), await priceAdjusts(c.eventId), await num('select count(*) n from public.accounting_unit_refund_allocations')];
      const before = await snap();
      await q("select * from private.mark_order_refund_error($1,'timeout',false)", [c.refundId]);
      expect(await snap()).toEqual(before);
      await hResult(db(), c.refundId, 'pending');
      expect(await snap()).toEqual(before);
      await hResult(db(), c.refundId, 'succeeded');
      expect(await snap()).toEqual(before);
      await hResult(db(), c.refundId, 'failed');
      expect(await snap()).toEqual(before);
    });

    test('FREQ-577-AC-06: Stripeが失敗にした返金のやり直しは同じ出来事を指し、割り当ては1回分だけで、着の支払額を超えない', async () => {
      // 出来事の割り当ては出来事の id の鍵で1回だけ書く。やり直し（同じ出来事を指す）で道具がまた呼ばれても増えない。
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      await hResult(db(), c.refundId, 'failed');
      await q('select private.accounting_record_event_allocations($1)', [c.eventId]);
      const rows = await allocs(c.eventId);
      expect(rows).toHaveLength(1);
      const paid = (await q('select paid_amount from public.order_line_unit_amounts where order_item_id=$1 and unit_index=$2', [rows[0].order_item_id, rows[0].unit_index])).rows[0].paid_amount;
      expect(rows[0].amount).toBeLessThanOrEqual(paid);
      await immediate();
    });

    test('FREQ-577-AC-08: 割り振りの先の着が今出荷済みか、支払額−割り当てを超えると、書かずに allocation_overflow の計上待ちに置き、取り消しは落ちない', async () => {
      // fixture: 交換の設計の選び方が規則1とずれた場面（出来事の行は出荷前だが、今は出荷済み）を出来事の行で作る。
      // 支払額−割り当てを超える割り当ては、値打ちを0にする直しと一緒に書くので起きない（fix round 2 の N2）。
      const o = await slotOrder([[10000, 10000]]);
      const item = o.orderItemIds[0];
      await seedFactSlip(db(), { orderItemId: item, quantity: 2 });
      const eventId = await fixtureEvent(o.orderId, [{ item, unit: 0, kind: 'returned', allocation: 10000 }]);
      await fixtureRefund(o.orderId, eventId, 10000);
      expect(await allocs(eventId)).toEqual([]);
      expect(await pending(`allocation:${eventId}`)).toEqual([{ reason: 'amount_mismatch', detail: { mismatch: 'allocation_overflow' } }]);
      await immediate();
    });
  });

  describe('which units are shipped (ruling P3-6 / P3-C1)', () => {
    test('FREQ-577-AC-03: 規則1の道具は、出荷の仕訳が入る前でも後でも、G の鍵の中で取った番号から同じ着を出荷済みとする', async () => {
      const o = await seedUnitOrder(db(), [[1000, 1000]]);
      const item = o.orderItemIds[0];
      await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
      const n = await num('select max(fact_seq) n from public.accounting_g_slip_facts');
      const before = (await q('select unit_index, slip_id from private.accounting_shipped_units($1,$2)', [item, n])).rows;
      await q("select private.accounting_record_unit_refund('later', $1, 1, 1000)", [item]);
      expect((await q('select unit_index, slip_id from private.accounting_shipped_units($1,$2)', [item, n])).rows).toEqual(before);
    });

    test.each([{ claimed: [0] }, { claimed: [0, 1] }])('FREQ-563-AC-02: 出荷前の返金で確保した着まで発送した時（確保していない着が数より少ない）も、出荷済みの着は発送票の数ちょうどで、確保していない着が先、足りない分は確保した着を番号の若い順に足す $claimed', async ({ claimed }) => {
      const o = await seedUnitOrder(db(), [[1000, 1000, 1000]]);
      const item = o.orderItemIds[0];
      const refundId = (await q(`insert into public.order_refunds(order_id,source,stripe_refund_id,status,amount,notify_customer) values($1,'stripe_dashboard','re_'||replace(gen_random_uuid()::text,'-',''),'succeeded',1,false) returning id`, [o.orderId])).rows[0].id;
      await q('select private.group_h_claim_refund_units($1,$2,$3::integer[],true,null)', [refundId, item, claimed]);
      await seedFactSlip(db(), { orderItemId: item, quantity: 3 - claimed.length + 1 });
      const free = [0, 1, 2].filter((i) => !claimed.includes(i));
      expect(await bothShipped(item)).toEqual([...free, claimed[0]].sort());
    });

    test('FREQ-563-AC-02: 2着のうち1着を出荷前に取り消し、発送の数が1の時は、確保していない着が出荷済みになる', async () => {
      const o = await equalOrder();
      const c = await seedPreShipmentCancel(db(), o, { itemId: o.itemId, quantity: 1 });
      const cancelled = (await q("select unit_index from public.order_unit_event_lines where event_id=$1 and line_kind='returned'", [c.eventId])).rows[0].unit_index;
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await bothShipped(o.itemId)).toEqual([1 - cancelled]);
    });

    test('FREQ-563-AC-02: 2着をどちらも出荷前の返金で確保し、返した額が 5,000円と1円でも、出荷済みの着は番号の若い着で、額では決めない', async () => {
      const o = await seedUnitOrder(db(), [[20000, 20000]]);
      const item = o.orderItemIds[0];
      for (const [unitIndex, amount] of [[0, 5000], [1, 1]]) {
        const refundId = (await q(`insert into public.order_refunds(order_id,source,stripe_refund_id,status,amount,notify_customer) values($1,'stripe_dashboard','re_'||replace(gen_random_uuid()::text,'-',''),'succeeded',$2,false) returning id`, [o.orderId, amount])).rows[0].id;
        await q('select private.group_h_claim_refund_units($1,$2,array[$3::integer],true,null)', [refundId, item, unitIndex]);
      }
      await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
      expect(await bothShipped(item)).toEqual([0]);
    });

    test('FREQ-563-AC-02: 同じ値段の2着で、番号0の着を出荷前に取り消し、番号1の着を発送すると、出荷済みの着は番号1で、番号1の着の返品は unit_not_available で断られない（交換の印の作業の R33 の場面）', async () => {
      const o = await equalOrder();
      const c = await seedPreShipmentCancel(db(), o, { itemId: o.itemId, quantity: 1 });
      await hResult(db(), c.refundId, 'succeeded');
      const fulfillment = await shipFixtureOrder(db(), { orderId: o.orderId, actorId: o.actor, trackingNumber: 'S17-R33', lines: [{ order_item_id: o.itemId, quantity: 1 }] });
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await bothShipped(o.itemId)).toEqual([1]);
      const ret = await createUbReturn(db(), { ...o, fulfillment }, [{ quantity: 1 }]);
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: o.actor, choice: 'now', units: [{ return_line_id: ret.lineIds[0], disposition: 'not_restocked', quantity: 1 }] });
      expect(received.refund_amount).toBe(20000);
    });

    test('FREQ-563-AC-02: 写しのある注文で発送前の取り消しの返金が失敗して H の確保が外れた後に残りを発送しても、取り消した着はどちらの関数でも出荷済みにならない', async () => {
      const o = await equalOrder();
      const c = await seedPreShipmentCancel(db(), o, { itemId: o.itemId, quantity: 1 });
      await hResult(db(), c.refundId, 'failed');
      expect(await num('select count(*) n from public.order_line_unit_amounts where refund_id=$1', [c.refundId])).toBe(0);
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await bothShipped(o.itemId)).toEqual([1]);
    });

    test('FREQ-563-AC-02: 発送前の取り消しを店がやめて cancel_reverted の出来事が入ると、その着は kept に戻り確保に数えない', async () => {
      const o = await equalOrder();
      const c = await seedPreShipmentCancel(db(), o, { itemId: o.itemId, quantity: 1 });
      await hResult(db(), c.refundId, 'failed');
      await q('select private.order_unit_revert_cancel($1,$2)', [c.refundId, o.actor]);
      expect((await q('select state from public.order_unit_slots where order_id=$1 order by unit_index', [o.orderId])).rows.map((r) => r.state)).toEqual(['kept', 'kept']);
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await bothShipped(o.itemId)).toEqual([0]);
    });

    test('FREQ-563-AC-02: 交換の品だけを発送前に取り消した元の着（出荷済み）は確保にならず、同じ品のまだ送っていない着は出荷済みにならない（どちらの関数も）', async () => {
      const f = await seedRefundFlow(db(), 2, 3);
      expect(await bothShipped(f.itemId)).toEqual([0, 1]);
      const ex = await createUbReturn(db(), f, [{ quantity: 1, exchange: true }]);
      const received = await ubReceive(db(), { returnId: ex.returnId, actorId: f.actor, choice: 'none',
        units: [{ return_line_id: ex.lineIds[0], disposition: 'not_restocked', quantity: 1 }] });
      await seedPreShipmentCancel(db(), f, { itemId: received.exchange_order_item_ids[0] as string, quantity: 1 });
      expect(await bothShipped(f.itemId)).toEqual([0, 1]);
    });

    test('FREQ-563-AC-02: 発送前の取り消しの返金が error の間に残りを発送しても、取り消した着はどちらの関数でも出荷済みにならない', async () => {
      const o = await equalOrder();
      const c = await seedPreShipmentCancel(db(), o, { itemId: o.itemId, quantity: 1 });
      await q("select * from private.mark_order_refund_error($1,'timeout',false)", [c.refundId]);
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await bothShipped(o.itemId)).toEqual([1]);
    });

    test('FREQ-563-AC-02: order_unit_shipped_slots は G の鍵の外で呼んでも断られず、accounting_shipped_units(品, NULL) と同じ着の組を返す', async () => {
      // 試験の取引（G の鍵を持つ）で注文と発送票を作ってコミットし、鍵を持たない別の接続から読む。
      const o = await seedUnitOrder(db(), [[1000, 1000]]);
      await seedFactSlip(db(), { orderItemId: o.orderItemIds[0], quantity: 1 });
      await q('commit');
      await q('begin');
      const other = await connectLocalDb();
      try {
        const held = (await other.query("select count(*)::int n from pg_locks where locktype='advisory' and classid=190521 and pid=pg_backend_pid()")).rows[0].n;
        expect(held).toBe(0);
        const b2 = (await other.query('select unit_index from private.order_unit_shipped_slots($1)', [o.orderItemIds[0]])).rows;
        const c2 = (await other.query('select unit_index from private.accounting_shipped_units($1,null) order by unit_index', [o.orderItemIds[0]])).rows;
        expect(b2).toEqual(c2);
        expect(b2).toEqual([{ unit_index: 0 }]);
      } finally { await other.end(); }
    });
  });

  describe('Stripe dashboard refund claims by index (ruling P3-C7)', () => {
    /** 繰り返しの割引の写しのある2着（H の受け付けの注文。[999, 1000] の代わりの実際の額）と、1着ごとの支払額。 */
    async function snapshotOrder999() {
      const f = await seedRefundFlow(db(), false, 2);
      const units = (await q('select unit_index, paid_amount from public.order_line_unit_amounts where order_item_id=$1 order by unit_index', [f.itemId])).rows;
      return { ...f, units };
    }

    test('FREQ-577-AC-10: 割引の写しのある注文で1着ごとの額 [999（番号0）, 1000（番号1）] の品の1着を送り、出来事の道で発送前の取り消しをすると、出荷の仕訳を取り消しの前に作る順と後に作る順のどちらでも、残りを送った後の売上は同じで、前受金（2150）は0', async () => {
      // H の受け付けの注文では 1円の割引の着を作れないので、実際の2着の額で確かめる。仕訳は Task 6 の物なので、
      // 売上の代わりに出荷済みの着の値打ちの合計、前受金の代わりに「支払額 − 出荷済みの値打ち − 事実の P」を比べる。
      const run = async (slipFirst: boolean) => {
        const o = await snapshotOrder999();
        await shipFixtureOrder(db(), { orderId: o.orderId, actorId: o.actor, trackingNumber: `S17-C6-${slipFirst}`, lines: [{ order_item_id: o.itemId, quantity: 1 }] });
        if (slipFirst) await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
        const c = await seedPreShipmentCancel(db(), o, { itemId: o.itemId, quantity: 1 });
        if (!slipFirst) await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
        // 出来事の道を通った: 返金は出来事に結ばれ、H が確保した着の番号は出来事の返す行の番号と同じ
        const line = (await q("select unit_index from public.order_unit_event_lines where event_id=$1 and line_kind='returned'", [c.eventId])).rows;
        const claimed = (await q('select unit_index from public.order_line_unit_amounts where refund_id=$1', [c.refundId])).rows;
        expect(claimed).toEqual(line);
        const shipped = await bothShipped(o.itemId);
        expect(shipped).toHaveLength(1);
        expect(shipped).not.toContain(line[0].unit_index);
        const paid = Number((await q('select paid_amount from public.orders where id=$1', [o.orderId])).rows[0].paid_amount);
        const revenue = (await values(o.orderId)).filter((v) => v.shipped).reduce((sum, v) => sum + v.value, 0);
        return { revenue, advance: paid - revenue - (await facts(c.refundId)).pre_shipment_amount };
      };
      const before = await run(true);
      const after = await run(false);
      expect(after.revenue).toBe(before.revenue);
      expect(before.advance).toBe(0);
      expect(after.advance).toBe(0);
      await immediate();
    });

    test('FREQ-577-AC-10: 割引の写しのある注文で [999（番号0）, 1000（番号1）] の品の1着を送り（番号0を名指す）、全額に届く Stripe の画面の返金（`record_external_order_refund`。H :1152 の枝）を記録すると、まだ送っていない番号1を出荷前の行の額 1000 で確保し、名指した組は {0} のままで、出荷の仕訳を返金の前に作る順と後に作る順のどちらでも、残りの後の売上は同じで前受金（2150）は0', async () => {
      // H の受け付けの注文では 1円の割引の着の番号が決まっているので、[999, 1000] の代わりに実際の2着の額で確かめる。
      const o = await snapshotOrder999();
      await shipFixtureOrder(db(), { orderId: o.orderId, actorId: o.actor, trackingNumber: 'S17-C7', lines: [{ order_item_id: o.itemId, quantity: 1 }] });
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await bothShipped(o.itemId)).toEqual([0]);
      const paid = Number((await q('select paid_amount from public.orders where id=$1', [o.orderId])).rows[0].paid_amount);
      const ext = (await q(`select * from public.record_external_order_refund($1,$2,$3,'succeeded',null,null,null,'card',null,null,'requested_by_customer',now())`,
        [o.orderId, `re_${randomUUID().replaceAll('-', '')}`, paid])).rows[0];
      expect((await q('select unit_index from public.order_line_unit_amounts where refund_id=$1', [ext.refund_id])).rows).toEqual([{ unit_index: 1 }]);
      expect((await q('select amount, before_shipment from public.order_refund_lines where refund_id=$1', [ext.refund_id])).rows)
        .toEqual([{ amount: o.units[1].paid_amount, before_shipment: true }]);
      expect(await bothShipped(o.itemId)).toEqual([0]);
      // 前受金の代わりの確かめ（Task 6 の仕訳が来るまで）: 支払額 − 出荷した着の値打ち − 事実の P = 0
      const fact = await facts(ext.refund_id);
      const shippedValue = (await values(o.orderId)).filter((v) => v.shipped).reduce((sum, v) => sum + v.value, 0);
      expect(paid - shippedValue - fact.pre_shipment_amount).toBe(0);
    });

    test('FREQ-577-AC-10: 前の出荷後の返金の位置の確保が名指した組の外の着を取っていて、組の外の空きの着が足りない時も、全額に届く Stripe の画面の返金は記録され、GROUP_H_REFUND_UNIT_MISMATCH にならず、足りない分は名指した組の中の空きの着から安い順に確保する', async () => {
      // この場面は写しの無い注文でだけ起きるので、道具で注文を作った後に order_discount_snapshots の行を消して写しの無い着の行の注文にし、
      // 前の出荷後の返金は公開の begin_order_refund（発送後の行。H の位置の確保 before_shipment が偽）で作る。
      const o = await snapshotOrder999();
      await q('alter table public.order_discount_snapshots disable trigger user');
      await q('delete from public.order_discount_snapshots where order_id=$1', [o.orderId]);
      await q('alter table public.order_discount_snapshots enable trigger user');
      await shipFixtureOrder(db(), { orderId: o.orderId, actorId: o.actor, trackingNumber: 'S17-C7A', lines: [{ order_item_id: o.itemId, quantity: 1 }] });
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      const post = (await q(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,500,null,'requested_by_customer',null,false,$4,null,null)`,
        [o.orderId, randomUUID(), JSON.stringify([{ order_item_id: o.itemId, before_shipment: false, quantity: 1 }]), o.actor])).rows[0];
      await hResult(db(), post.refund_id, 'succeeded');
      const paid = Number((await q('select paid_amount from public.orders where id=$1', [o.orderId])).rows[0].paid_amount);
      const ext = (await q(`select * from public.record_external_order_refund($1,$2,$3,'succeeded',null,null,null,'card',null,null,'requested_by_customer',now())`,
        [o.orderId, `re_${randomUUID().replaceAll('-', '')}`, paid - 500])).rows[0];
      expect(ext.refund_id).toBeTruthy();
      expect((await q('select count(*)::int n from public.order_line_unit_amounts where refund_id=$1', [ext.refund_id])).rows[0].n).toBe(1);
    });
  });
});
