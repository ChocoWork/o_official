/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { acceptHCheckout, hDiscount, hFailure, seedHCheckout, seedHDiscount, seedHMember, seedHOrderUnits } from './helpers/group-h-fixtures';
import { createCatalogFixture, shipFixtureOrder } from './helpers/order-fixtures';
import { hBegin, hClaims, hReceive, hRefundFixture, hResult, hReturn } from './helpers/group-h-refund-fixtures';

describeLocalDb('H5 refunds / returns (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  test('FREQ-551-AC-01: 20000円の２着で２着目3000円引きなら１着目の返金は17000円で次は20000円', async () => {
    const f = await hRefundFixture(db(), true);
    expect((await hClaims(db(), f.itemId)).map(u => u.paid_amount)).toEqual([17000, 20000]);
    expect((await db().query('select lines from public.load_order_refund_materials($1)', [f.orderId])).rows[0].lines[0].available_unit_amounts).toEqual([17000, 20000]);
    const a = await hBegin(db(), f, 17000); await hResult(db(), a.refund_id, 'succeeded');
    const b = await hBegin(db(), f, 20000); await hResult(db(), b.refund_id, 'succeeded');
    expect((await db().query('select amount from public.order_refund_lines where refund_id=any($1::uuid[]) order by amount', [[a.refund_id, b.refund_id]])).rows).toEqual([{ amount: 17000 }, { amount: 20000 }]);
    expect((await db().query('select refunded_amount from public.orders where id=$1', [f.orderId])).rows[0].refunded_amount).toBe(37000);
    const cancel = await hRefundFixture(db());
    await db().query("select * from public.begin_order_refund($1,'order_cancel',$2,'[]',false,null,null,null,null,'customer_request',false,$3)", [cancel.orderId, randomUUID(), cancel.actor]);
    expect((await db().query('select sum(l.amount)::int n from public.order_refund_lines l join public.order_refunds r on r.id=l.refund_id where r.order_id=$1', [cancel.orderId])).rows[0].n).toBe(37000);
  });
  test('FREQ-551-AC-02: unit記録の無い旧注文は均等式を保ち交換は元の支払額を使う', async () => {
    const old = await seedHOrderUnits(db(), { legacy: true, lines: [{ itemPrice: 20000, quantity: 2, discounts: [], unitAmounts: [] }] });
    expect((await db().query('select private.return_units_amount($1,1) n', [old.orderItemIds[0]])).rows[0].n).toBe(20000);
    const zero = await seedHOrderUnits(db(), { legacy: false, lines: [
      { itemPrice: 0, quantity: 2, discounts: [], unitAmounts: [0, 0] },
      { itemPrice: 20000, quantity: 1, discounts: [], unitAmounts: [20000] },
    ] });
    expect((await db().query('select private.return_units_amount($1,1) n', [zero.orderItemIds[0]])).rows[0].n).toBe(0);
    expect(await hFailure(db(), () => db().query('select private.return_units_amount($1,3)', [zero.orderItemIds[0]]))).toEqual({ code: '23514', message: 'GROUP_H_REFUND_UNIT_MISMATCH' });
    const f = await hRefundFixture(db(), true); const r = await hReturn(db(), f, 1, true);
    const received = await hReceive(db(), f, r, 1, 'none');
    expect((await db().query('select exchange_paid_amount,line_kind from public.order_items where id=$1', [received.exchange_order_item_ids[0]])).rows[0]).toEqual({ exchange_paid_amount: 17000, line_kind: 'exchange' });
    expect((await db().query('select private.return_units_amount($1,1) n', [received.exchange_order_item_ids[0]])).rows[0].n).toBe(17000);
  });
  test('FREQ-551-AC-02: 発送前と発送後を同時に選ぶと発送前から17000円と20000円を保存する', async () => {
    const f = await hRefundFixture(db(), 1);
    const r = (await db().query("select * from public.begin_order_refund($1,'admin',$2,$3,false,0,37000,null,'requested_by_customer',null,false,$4)",
      [f.orderId, randomUUID(), JSON.stringify([{ order_item_id: f.itemId, before_shipment: false, quantity: 1 },
        { order_item_id: f.itemId, before_shipment: true, quantity: 1 }]), f.actor])).rows[0];
    expect((await db().query('select before_shipment,amount from public.order_refund_lines where refund_id=$1 order by before_shipment desc', [r.refund_id])).rows).toEqual([
      { before_shipment: true, amount: 17000 }, { before_shipment: false, amount: 20000 },
    ]);
  });
  test('FREQ-551-AC-02: 無料単位の返品は0円で完了しても数量とclaimを消費する', async () => {
    const f = await hRefundFixture(db(), true, 2, 20000); const r = await hReturn(db(), f);
    expect((await hClaims(db(), f.itemId)).map(u => u.paid_amount)).toEqual([0, 20000]);
    const received = await hReceive(db(), f, r, 1, 'now');
    expect(received).toMatchObject({ refund_id: null, refund_status: 'waived', refund_amount: 0 });
    expect((await hClaims(db(), f.itemId))[0]).toMatchObject({ return_line_id: null, refund_id: null });
    expect((await db().query('select private.return_units_amount($1,1) n', [f.itemId])).rows[0].n).toBe(0);
  });
  test('FREQ-551-AC-01: 相談待ちの後の即返金は新たに受け取った20000円をclaimし先の17000円を待ち額に保つ', async () => {
    const f = await hRefundFixture(db(), true); const r = await hReturn(db(), f, 2); await hReceive(db(), f, r);
    const next = await hReceive(db(), f, r, 1, 'now');
    expect(next.refund_amount).toBe(20000);
    expect((await hClaims(db(), f.itemId)).map(u => u.refund_id)).toEqual([null, next.refund_id]);
    const detail = (await db().query('select private.return_detail_json($1) j', [r.returnId])).rows[0].j;
    expect(detail.lines[0]).toMatchObject({ refund_amounts_by_count: [], refund_waiting_amount: 17000 });
  });
  test('FREQ-551-AC-01: 自動の支払額不一致取消も共通coreの37000円claimを使う', async () => {
    const f = await hRefundFixture(db());
    const r = (await db().query("select * from public.begin_order_refund($1,'auto_amount_mismatch',null,'[]',true,null,null,null,null,null,true,null)", [f.orderId])).rows[0];
    expect(r.amount).toBe(37000);
    expect((await hClaims(db(), f.itemId)).map(u => u.refund_id)).toEqual([r.refund_id, r.refund_id]);
    expect((await db().query('select state from public.discount_redemptions where order_id=$1', [f.orderId])).rows).toEqual([{ state: 'confirmed' }]);
  });
  test('FREQ-551-AC-03: セットの片方を返しても残る服を再計算せず成功した着数だけ次回のAから引く', async () => {
    const catalogs = [await createCatalogFixture(db(), { stock: 1 }), await createCatalogFixture(db(), { stock: 1 })];
    const actor = await seedHMember(db()); const code = `H5-${randomUUID().toUpperCase()}`;
    const discountId = await seedHDiscount(db(), hDiscount({ code, kind: 'set', value: { type: 'amount', value: 6000 },
      targetMode: 'include', itemIds: catalogs.map(c => c.itemId), minimum: { type: 'amount', value: 40000 }, allowGuests: true }));
    // Prior units count only orders a signed-in member placed (owner decision), so the buyer is a member.
    const buyer = await seedHMember(db());
    const f = await seedHCheckout(db(), { discountId, code, userId: buyer, lines: catalogs.map(catalog => ({ catalog, quantity: 1 })) });
    const order = await acceptHCheckout(db(), f);
    await db().query("select * from public.mark_order_paid($1,'payment_in_progress',$2,$3,'jpy',true,'payment_received')", [order.order_id, f.paymentIntentId, f.result.totalAmount]);
    const items = (await db().query('select id,item_id from public.order_items where order_id=$1 order by item_id', [order.order_id])).rows;
    await shipFixtureOrder(db(), { orderId: order.order_id!, actorId: actor, trackingNumber: 'H5-SET', lines: items.map(i => ({ order_item_id: i.id, quantity: 1 })) });
    const prior = async () => (await db().query("select public.get_checkout_discount_context($1,null,'{}',$2,now(),'confirm') j", [buyer, items.map(i => i.item_id)])).rows[0].j.facts.priorUnitsByItem;
    expect(await prior()).toMatchObject({ [items[0].item_id]: 1, [items[1].item_id]: 1 });
    const a = (await db().query("select * from public.begin_order_refund($1,'admin',$2,$3,false,0,17000,null,'requested_by_customer',null,false,$4)",
      [order.order_id, randomUUID(), JSON.stringify([{ order_item_id: items[0].id, before_shipment: false, quantity: 1 }]), actor])).rows[0];
    await db().query("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [a.refund_id]);
    expect(await prior()).toMatchObject({ [items[0].item_id]: 1, [items[1].item_id]: 1 });
    await hResult(db(), a.refund_id, 'pending'); expect(await prior()).toMatchObject({ [items[0].item_id]: 1 });
    await hResult(db(), a.refund_id, 'succeeded'); expect((await prior())[String(items[0].item_id)] ?? 0).toBe(0);
    expect((await prior())[String(items[1].item_id)]).toBe(1);
    expect((await hClaims(db(), items[1].id))[0].paid_amount).toBe(17000);
    expect((await db().query('select state from public.discount_redemptions where order_id=$1', [order.order_id])).rows).toEqual([{ state: 'confirmed' }]);
  });
  test('FREQ-551-AC-02: Stripeの管理画面からの返金も安い着から取り同じ着を二度返さない', async () => {
    const f = await hRefundFixture(db()); const a = await hBegin(db(), f, 17000, true); await hResult(db(), a.refund_id, 'succeeded');
    const stripeId = `re_${randomUUID().replaceAll('-', '')}`;
    const external = async (status: string) => (await db().query("select * from public.record_external_order_refund($1,$2,20000,$3,null,$4,null,'card',null,null,null,now())", [f.orderId, stripeId, status, status === 'failed' ? 'lost_or_stolen_card' : null])).rows[0];
    const b = await external('pending'); expect((await hClaims(db(), f.itemId)).map(u => u.refund_id)).toEqual([a.refund_id, b.refund_id]);
    expect((await external('pending')).created).toBe(false);
    await external('failed'); expect((await hClaims(db(), f.itemId))[1].refund_id).toBeNull();
    const partial = await hRefundFixture(db());
    const p = (await db().query("select * from public.record_external_order_refund($1,$2,100,'succeeded',null,null,null,'card',null,null,null,now())", [partial.orderId, `re_${randomUUID().replaceAll('-', '')}`])).rows[0];
    expect((await db().query('select adjustment_amount from public.order_refunds where id=$1', [p.refund_id])).rows[0].adjustment_amount).toBe(100);
    expect((await hClaims(db(), partial.itemId)).every(u => u.refund_id === null)).toBe(true);
  });
  test('FREQ-551-AC-01: 返品詳細の数量別見込みと入金待ち額と画面とメールは17000円からになる', async () => {
    const f = await hRefundFixture(db(), true); const r = await hReturn(db(), f, 2);
    const detail = async () => (await db().query('select private.return_detail_json($1) j', [r.returnId])).rows[0].j.lines[0];
    expect((await detail()).refund_amounts_by_count).toEqual([17000, 37000]);
    await hReceive(db(), f, r);
    expect(await detail()).toMatchObject({ refund_amounts_by_count: [20000], refund_waiting_amount: 17000 });
    const refund = (await db().query('select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [r.returnId, f.actor, randomUUID()])).rows[0];
    expect(refund.amount).toBe(17000);
    await hResult(db(), refund.refund_id, 'succeeded');
    expect((await detail()).refund_amounts_by_count).toEqual([20000]);
  });
  test.each(['return_units_amount', 'load_order_refund_materials', 'begin_order_refund_core', 'record_external_order_refund', 'return_detail_json', 'group_g_order_item_rows'])('FREQ-551-AC-02: Hの全ての金額読取は単位額を使い旧均等helperをH行へ呼ばない (%s)', async reader => {
    const f = await hRefundFixture(db(), reader !== 'record_external_order_refund'); const r = reader === 'return_detail_json' ? await hReturn(db(), f, 1) : null;
    await db().query(`create function private.h5_test_uniform_forbidden() returns integer language plpgsql as $$begin raise exception 'GROUP_H_UNEXPECTED_EQUAL_SPLIT'; end;$$;
      do $trap$ declare v_fn record; begin
        for v_fn in select p.prosrc,pg_get_functiondef(p.oid) definition,l.lanname from pg_proc p
          join pg_language l on l.oid=p.prolang where p.pronamespace='private'::regnamespace
          and p.proname in ('refund_units_discount','return_refund_amount') loop
          execute replace(v_fn.definition,v_fn.prosrc,case when v_fn.lanname='sql'
            then 'select private.h5_test_uniform_forbidden()' else 'begin return private.h5_test_uniform_forbidden(); end;' end);
        end loop;
      end $trap$`);
    if (reader === 'begin_order_refund_core') {
      const refund = await hBegin(db(), f, 17000);
      expect((await db().query('select amount from public.order_refund_lines where refund_id=$1', [refund.refund_id])).rows).toEqual([{ amount: 17000 }]); return;
    }
    if (reader === 'record_external_order_refund') {
      const refund = (await db().query("select * from public.record_external_order_refund($1,$2,37000,'pending',null,null,null,'card',null,null,null,now())", [f.orderId, `re_${randomUUID().replaceAll('-', '')}`])).rows[0];
      expect((await db().query('select amount from public.order_refund_lines where refund_id=$1', [refund.refund_id])).rows).toEqual([{ amount: 37000 }]); return;
    }
    const queries: Record<string, [string, unknown[]]> = {
      return_units_amount: ['select private.return_units_amount($1,1) n', [f.itemId]],
      load_order_refund_materials: ['select (lines->0->\'available_unit_amounts\'->>0)::int n from public.load_order_refund_materials($1)', [f.orderId]],
      return_detail_json: ["select (private.return_detail_json($1)->'lines'->0->'refund_amounts_by_count'->>0)::int n", [r?.returnId]],
      group_g_order_item_rows: ['select sum(line_amount)::int n from private.group_g_order_item_rows($1)', [[f.orderId]]],
    };
    const [sql, args] = queries[reader]; expect((await db().query(sql, args)).rows[0].n).toBe(reader === 'group_g_order_item_rows' ? 37000 : 17000);
  });
});
