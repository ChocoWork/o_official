/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { seedGroupG4SwapPair } from './helpers/group-g4-fixtures';
import { seedGroupG1Allocation, seedGroupG1Restock, seedGroupG1Shipment, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { insertRestockMovement, insertReturnRecord } from './helpers/order-fixtures';
import { withRolePermissions } from './helpers/group-g3-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';

jest.setTimeout(60000);
type Pair = Awaited<ReturnType<typeof seedGroupG4SwapPair>>;
type Input = { order?: string | null; taker?: string | null; donor?: string | null;
  quantity?: number | null; reason?: string | null; actor?: string | null; key?: string | null };
type Result = { id: string; operationId: string; takerOrderId: string; takerOrderItemId: string;
  donorOrderId: string; donorOrderItemId: string; quantity: number; reason: string; replayed: boolean };

describeLocalDb('G-4 allocation swap', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    actor = await flow.manager();
  });
  afterEach(async () => { await db().query('rollback'); });
  const seed = (input: Parameters<typeof seedGroupG4SwapPair>[1] = {}) => seedGroupG4SwapPair(db(), input);
  const args = (f: Pair, o: Input = {}) => [o.order === undefined ? f.taker.orderId : o.order,
    o.taker === undefined ? f.taker.orderItemId : o.taker, o.donor === undefined ? f.donor.orderItemId : o.donor,
    o.quantity === undefined ? 2 : o.quantity, o.reason === undefined ? 'fixture swap' : o.reason,
    o.actor === undefined ? actor : o.actor, o.key === undefined ? randomUUID() : o.key];
  const swap = async (f: Pair, o: Input = {}): Promise<Result> => (await db().query(
    'select public.admin_swap_order_allocations($1,$2,$3,$4,$5,$6,$7) r', args(f,o))).rows[0].r;
  const candidates = async (f: Pair, by = actor) => (await db().query(
    'select * from public.list_admin_allocation_swap_candidates($1,$2,$3)', [f.taker.orderId,f.taker.orderItemId,by])).rows;
  const orders = (f: Pair) => [f.donor.orderId,f.taker.orderId];
  const states = async (f: Pair) => (await db().query(
    'select order_item_id,status,unit_from,unit_to,blocked_reasons from private.group_g_item_state_ranges($1) order by order_item_id,unit_from',
    [orders(f)])).rows;
  const totals = async (f: Pair) => (await db().query(`select v.stock_quantity::int f,
    coalesce(sum(a.remaining_quantity) filter(where a.kind='paid'),0)::int a,
    coalesce(sum(a.remaining_quantity) filter(where a.kind='payment_hold'),0)::int h,
    (select count(*)::int from public.stock_movements m where m.variant_id=v.id) ledger
    from public.item_variants v left join public.order_item_allocations a on a.variant_id=v.id
    where v.id=$1 group by v.id`,[f.variantId])).rows[0] as { f: number; a: number; h: number; ledger: number };
  // Complete scoped row digests: refusals/replay must preserve content as well as counts. No PII is emitted.
  async function snapshot(f: Pair) {
    const filters: Array<[string,string]> = [
      ['public.orders','t.id=any($1::uuid[])'], ['public.order_items','t.order_id=any($1::uuid[])'],
      ['public.order_item_allocations','t.order_item_id in(select id from public.order_items where order_id=any($1::uuid[]))'],
      ['public.order_item_allocation_events','t.allocation_id in(select a.id from public.order_item_allocations a join public.order_items i on i.id=a.order_item_id where i.order_id=any($1::uuid[]))'],
      ['public.order_item_state_events','t.order_item_id in(select id from public.order_items where order_id=any($1::uuid[]))'],
      ['private.group_g_operations','t.cause_id=any($1::text[]) or t.cause_id in(select id::text from public.order_items where order_id=any($2::uuid[]))'],
    ];
    const hashes = [];
    for (const [table,filter] of filters) hashes.push((await db().query(`select md5(coalesce(string_agg(to_jsonb(t)::text,',' order by to_jsonb(t)::text),'')) d from ${table} t where ${filter}`,
      table === 'private.group_g_operations' ? [orders(f),orders(f)] : [orders(f)])).rows[0].d);
    hashes.push(await totals(f));
    return hashes;
  }
  async function refused(f: Pair, message: string, o: Input = {}, code = '22023') {
    const before = await snapshot(f);
    expect(await flow.rejected(() => swap(f,o))).toEqual({ code,message });
    expect(await snapshot(f)).toEqual(before);
  }

  test('FREQ-523-AC-03: 2点の入替はF/A/H・手元・台帳を保ち、対・数量区間の両履歴・操作結果を残す', async () => {
    const f = await seed(); const before = await totals(f); const key = randomUUID();
    const old = (await db().query('select version::text v from public.order_item_allocations where id=$1',[f.donor.allocations[0]])).rows[0].v;
    const result = await swap(f,{ key,reason: '  fixture swap  ' });
    expect(result).toEqual({ id: f.taker.orderId,operationId: expect.any(String),takerOrderId: f.taker.orderId,
      takerOrderItemId: f.taker.orderItemId,donorOrderId: f.donor.orderId,donorOrderItemId: f.donor.orderItemId,
      quantity: 2,reason: 'fixture swap',replayed: false });
    await flow.flush();
    expect(await totals(f)).toEqual(before);
    expect(before.f+before.a+before.h).toBe(3);
    const ranges = await states(f);
    expect(ranges.filter(r=>r.order_item_id===f.donor.orderItemId).map(r=>[r.status,r.unit_from,r.unit_to]))
      .toEqual([['in_production',0,2],['ready',2,3]]);
    expect(ranges.filter(r=>r.order_item_id===f.taker.orderItemId).map(r=>[r.status,r.unit_from,r.unit_to]))
      .toEqual([['ready',0,2]]);
    const updated = (await db().query('select version::text v,remaining_quantity,updated_at=now() touched from public.order_item_allocations where id=$1',[f.donor.allocations[0]])).rows[0];
    expect(BigInt(updated.v)).toBe(BigInt(old)+BigInt(1));
    expect(updated).toMatchObject({ remaining_quantity: 1,touched: true });
    const events = (await db().query('select * from public.order_item_allocation_events where operation_id=$1 order by sequence',[result.operationId])).rows;
    expect(events).toHaveLength(2);
    for (const [k,e] of events.entries()) {
      expect(e).toMatchObject({ event_type: 'transfer',quantity: 2,sequence: k+1,reason: 'allocation_swap',
        actor_id: actor,stock_movement_id: null,operation_id: result.operationId,
        counterpart_allocation_id: events[1-k].allocation_id });
    }
    const history = (await db().query(`select order_item_id,from_status,to_status,unit_from,unit_to,reason,actor_id
      from public.order_item_state_events where operation_id=$1 order by order_item_id,unit_from`,[result.operationId])).rows;
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([
      { order_item_id: f.donor.orderItemId,from_status: 'ready',to_status: 'in_production',unit_from: 0,unit_to: 2,reason: 'allocation_swap',actor_id: actor },
      { order_item_id: f.taker.orderItemId,from_status: 'in_production',to_status: 'ready',unit_from: 0,unit_to: 2,reason: 'allocation_swap',actor_id: actor },
    ]));
    const operation = (await db().query('select operation,cause_type,cause_id,actor_id,fingerprint,result from private.group_g_operations where id=$1',[result.operationId])).rows[0];
    expect(operation).toEqual({ operation: 'allocation_swap',cause_type: 'order_item',cause_id: f.taker.orderItemId,
      actor_id: actor,fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),result });
  });

  test('FREQ-523-AC-03: donorの古い割当から行ごとに別の受け手とsequence 1/2/3/4を作る', async () => {
    const f=await seed({ donorQuantity: 4,takerQuantity: 3,donorParts: [1,3] });
    const r=await swap(f,{ quantity: 3 }); await flow.flush();
    const e=(await db().query('select allocation_id,counterpart_allocation_id,quantity,sequence from public.order_item_allocation_events where operation_id=$1 order by sequence',[r.operationId])).rows;
    expect(e.map(x=>[x.sequence,x.quantity])).toEqual([[1,1],[2,1],[3,2],[4,2]]);
    expect([e[0].allocation_id,e[2].allocation_id]).toEqual(f.donor.allocations);
    expect(e[1].allocation_id).not.toBe(e[3].allocation_id);
    for (const k of [0,2]) expect([e[k].counterpart_allocation_id,e[k+1].counterpart_allocation_id])
      .toEqual([e[k+1].allocation_id,e[k].allocation_id]);
    expect((await db().query('select quantity,remaining_quantity,kind,variant_id::text variant from public.order_item_allocations where order_item_id=$1 order by quantity',[f.taker.orderItemId])).rows)
      .toEqual([1,2].map(quantity=>({ quantity,remaining_quantity: quantity,kind: 'paid',variant: String(f.variantId) })));
  });

  test.each([
    [{ reason: ' \t\n ' },'GROUP_G_SWAP_REASON_REQUIRED'], [{ reason: 'x'.repeat(201) },'GROUP_G_ARGUMENT_INVALID'],
    [{ reason: null },'GROUP_G_ARGUMENT_INVALID'], [{ quantity: null },'GROUP_G_ARGUMENT_INVALID'],
    [{ quantity: 0 },'GROUP_G_ARGUMENT_INVALID'], [{ quantity: 100000 },'GROUP_G_ARGUMENT_INVALID'],
    [{ actor: null },'GROUP_G_ARGUMENT_INVALID'], [{ key: null },'GROUP_G_ARGUMENT_INVALID'],
    [{ order: null },'GROUP_G_ARGUMENT_INVALID'], [{ taker: null },'GROUP_G_ARGUMENT_INVALID'],
    [{ donor: null },'GROUP_G_ARGUMENT_INVALID'],
  ] as const)('FREQ-523-AC-02: 引数 %j は%s、書込みなし', async (input,message) => {
    await refused(await seed(),message,input);
  });

  test('FREQ-523-AC-02: 存在・所属・同一明細・同一注文を順に拒否し、書込みなし', async () => {
    const f=await seed();
    await refused(f,'GROUP_G_SWAP_ITEM_NOT_FOUND',{ taker: randomUUID() },'P0002');
    await refused(f,'GROUP_G_SWAP_ITEM_NOT_FOUND',{ donor: randomUUID() },'P0002');
    await refused(f,'GROUP_G_SWAP_ITEM_NOT_FOUND',{ order: f.donor.orderId },'P0002');
    await refused(f,'GROUP_G_ARGUMENT_INVALID',{ donor: f.taker.orderItemId });
    await db().query('savepoint same_order');
    const item=(await db().query(`insert into public.order_items(order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type)
      select order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type
      from public.order_items where id=$1 returning id`,[f.taker.orderItemId])).rows[0].id;
    await refused(f,'GROUP_G_SWAP_SAME_ORDER',{ donor: item });
    await db().query('rollback to savepoint same_order');
  });

  test.each([
    [{ differentVariant: true },'GROUP_G_SWAP_VARIANT_MISMATCH'],
    [{ takerVariantMissing: true },'GROUP_G_SWAP_VARIANT_MISMATCH'],
    [{ donorVariantMissing: true },'GROUP_G_SWAP_VARIANT_MISMATCH'],
    [{ takerStatus: 'pending' },'GROUP_G_SWAP_ORDER_NOT_PAID'],
    [{ donorStatus: 'pending' },'GROUP_G_SWAP_ORDER_NOT_PAID'],
    [{ takerStatus: 'failed' },'GROUP_G_SWAP_ORDER_NOT_PAID'],
    [{ donorStatus: 'failed' },'GROUP_G_SWAP_ORDER_NOT_PAID'],
    [{ takerStatus: 'cancelled' },'GROUP_G_SWAP_ORDER_NOT_PAID'],
    [{ donorStatus: 'cancelled' },'GROUP_G_SWAP_ORDER_NOT_PAID'],
    [{ takerFeeWaiting: true },'GROUP_G_SWAP_TAKER_ON_HOLD'],
    [{ takerReview: true },'GROUP_G_SWAP_TAKER_ON_HOLD'],
    [{ donorCancelRequested: 1 },'GROUP_G_SWAP_DONOR_PENDING_REQUEST'],
    [{ donorRefundProcessing: 1 },'GROUP_G_SWAP_DONOR_PENDING_REQUEST'],
    [{ donorReview: true },'GROUP_G_SWAP_DONOR_ON_HOLD'],
    [{ takerQuantity: 1 },'GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER'],
    [{ donorQuantity: 1 },'GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR'],
  ] as const)('FREQ-523-AC-02: 状態 %j は%s、割当・履歴・operations・台帳に書込みなし', async (input,message) => {
    const f=await seed(input);
    await refused(f,message);
    await flow.flush();
  });

  test('FREQ-523-AC-02: takerの取消申請対象を入替可能な数量に含めない', async () => {
    const f=await seed({ takerCancelRequested: 1 });
    await refused(f,'GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER');
    await flow.flush();
  });

  test('FREQ-523-AC-02: donor自身の明細の返品申請中2点を除き、残る発送準備中1点だけを入れ替えられる', async () => {
    const f=await seed({ donorQuantity: 3,takerQuantity: 2 });
    const fulfillmentId=await seedGroupG1Shipment(db(),{ orderId: f.donor.orderId,
      lines: [{ orderItemId: f.donor.orderItemId,quantity: 2 }],shippedAt: '2026-10-21T00:00:00Z' });
    await insertReturnRecord(db(),{ orderId: f.donor.orderId,status: 'requested',
      lines: [{ fulfillmentId,orderItemId: f.donor.orderItemId,quantity: 2,resolution: 'refund' }] });
    expect((await states(f)).filter(r=>r.order_item_id===f.donor.orderItemId).map(r=>[r.status,r.unit_to-r.unit_from]))
      .toEqual([['return_requested',2],['ready',1]]);
    expect((await candidates(f)).map(r=>[r.donor_order_item_id,r.swappable_quantity,r.taker_quantity]))
      .toEqual([[f.donor.orderItemId,1,2]]);
    await refused(f,'GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR');
    expect((await swap(f,{ quantity: 1 })).quantity).toBe(1);
    expect((await states(f)).filter(r=>r.order_item_id===f.donor.orderItemId).map(r=>[r.status,r.unit_to-r.unit_from]))
      .toEqual([['return_requested',2],['in_production',1]]);
    await flow.flush();
  });

  test.each(['taker','donor'] as const)('FREQ-523-AC-02: shipped注文の交換行が%sでも入替できる', async (side) => {
    const f=await seed({ takerExchange: side==='taker',donorExchange: side==='donor' });
    expect((await swap(f)).quantity).toBe(2); await flow.flush();
    expect((await states(f)).filter(r=>r.order_item_id===f.taker.orderItemId).map(r=>[r.status,r.unit_to-r.unit_from])).toEqual([['ready',2]]);
  });

  test.each([
    ['taker','pending'],['taker','cancelled'],['donor','pending'],['donor','cancelled'],
  ] as const)('FREQ-523-AC-02: 交換行を持つ%sの注文が%sならORDER_NOT_PAID、書込みなし', async (side,status) => {
    const f=await seed({ takerExchange: side==='taker',donorExchange: side==='donor' });
    await setOrderStatusForFixture(db(),[f[side].orderId],status);
    expect((await db().query('select line_kind from public.order_items where id=$1',[f[side].orderItemId])).rows[0].line_kind)
      .toBe('exchange');
    await refused(f,'GROUP_G_SWAP_ORDER_NOT_PAID');
    await flow.flush();
  });

  test.each(['pending','failed','cancelled'])('FREQ-523-AC-02: taker注文が%sなら候補とwriterは同じORDER_NOT_PAIDで拒否する', async (status) => {
    const f=await seed();
    // A failed order with a paid snapshot still projects stock-shortage units; status must be checked independently.
    await setOrderStatusForFixture(db(),[f.taker.orderId],status,{ paidAmount: 10000 });
    if (status==='failed') expect((await states(f)).filter(r=>r.order_item_id===f.taker.orderItemId))
      .toMatchObject([{ status: 'in_production',blocked_reasons: ['stock_shortage'] }]);
    const before=await snapshot(f);
    expect(await flow.rejected(()=>candidates(f))).toEqual({ code: '22023',message: 'GROUP_G_SWAP_ORDER_NOT_PAID' });
    expect(await snapshot(f)).toEqual(before);
    await refused(f,'GROUP_G_SWAP_ORDER_NOT_PAID');
    await flow.flush();
  });

  test('FREQ-540-AC-13: 両権限・役割の有効期限・初期サポーター・DBロールをwriterと候補で確認', async () => {
    const f=await seed();
    for (const by of [await flow.createActor(['supporter']),await flow.createActor([]),
      await flow.createActor(['admin'],{ expired: ['admin'] }),await flow.createActor(['admin'],{ inactive: ['admin'] })]) {
      await refused(f,'GROUP_G_FORBIDDEN',{ actor: by },'42501');
      expect(await flow.rejected(()=>candidates(f,by))).toEqual({ code: '42501',message: 'GROUP_G_FORBIDDEN' });
    }
    for (const permission of ['admin.orders.allocate','admin.orders.read']) await withRolePermissions(db(),'admin',[],[permission],async()=>{
      await refused(f,'GROUP_G_FORBIDDEN',{},'42501');
      expect(await flow.rejected(()=>candidates(f))).toEqual({ code: '42501',message: 'GROUP_G_FORBIDDEN' });
    });
    const supporter=await flow.createActor(['supporter']);
    await withRolePermissions(db(),'supporter',['admin.orders.allocate','admin.orders.read'],[],async()=>{
      expect(await candidates(f,supporter)).toHaveLength(1);
      expect((await swap(f,{ actor: supporter })).replayed).toBe(false);
    });
    for (const role of ['anon','authenticated']) for (const name of ['admin_swap_order_allocations','list_admin_allocation_swap_candidates']) {
      const error=await flow.rejected(async()=>{
        await db().query(`set local role ${role}`);
        if (name==='admin_swap_order_allocations') await swap(f); else await candidates(f);
      });
      expect(error.code).toBe('42501');
    }
    await flow.flush();
  });

  test('FREQ-523-AC-04: 再送は同じ結果のみ、入力・actorの変更はconflict、別keyで不足は拒否', async () => {
    const f=await seed({ donorQuantity: 2,takerQuantity: 4 }); const key=randomUUID();
    const r=await swap(f,{ key }); const before=await snapshot(f);
    expect(await swap(f,{ key,reason: ' fixture swap ' })).toEqual({ ...r,replayed: true });
    expect(await snapshot(f)).toEqual(before);
    for (const input of [{ quantity: 1 },{ reason: 'other' },{ actor: await flow.manager() }])
      await refused(f,'GROUP_G_REQUEST_KEY_CONFLICT',{ ...input,key },'23505');
    await refused(f,'GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR',{ quantity: 1 });
    await flow.flush();
  });

  test('FREQ-523-AC-04: 次の入荷のFIFOは元の古いdonorへ割り当て、takerから奪い返さない', async () => {
    const f=await seed(); await swap(f); const takerBefore=(await db().query('select * from public.order_item_allocations where order_item_id=$1',[f.taker.orderItemId])).rows;
    await seedGroupG1Restock(db(),{ itemId: f.itemId,variantId: f.variantId,quantity: 2,actorId: actor,requestKey: randomUUID() });
    expect((await db().query('select * from public.order_item_allocations where order_item_id=$1',[f.taker.orderItemId])).rows).toEqual(takerBefore);
    expect((await states(f)).filter(r=>r.order_item_id===f.donor.orderItemId).map(r=>[r.status,r.unit_to-r.unit_from])).toEqual([['ready',3]]);
    await flow.flush();
  });

  test('FREQ-523-AC-03: 入替で不足したdonorの下書きはissuesと確定の両方で再検証する', async () => {
    const f=await seed();
    const slip=(await db().query('select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) r',
      [JSON.stringify([{ orderItemId: f.donor.orderItemId,quantity: 3 }]),actor,randomUUID()])).rows[0].r;
    await swap(f);
    const read=(await db().query('select public.get_admin_shipment_slip($1,$2) r',[slip.id,actor])).rows[0].r;
    expect(JSON.stringify(read.issues)).toContain('quantity_exceeds_ready');
    expect(await flow.rejected(async()=>db().query('select public.admin_confirm_shipment_slip($1,$2,null,null,$3::date,false,$4,$5)',
      [slip.id,slip.version,await flow.today(),actor,randomUUID()]))).toEqual({ code: '22023',message: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY' });
    await flow.flush();
  });

  test('FREQ-523-AC-05: 候補は同variantの他のpaid/shipped・無阻害・申請/返金なし、T/D一致・安定順・50行', async () => {
    const f=await seed({ takerCreatedAt: '2026-10-26T00:00:00Z' });
    const catalog={ itemId: f.itemId,variantId: f.variantId };
    const expected: Array<{ donor_order_id: string; donor_order_item_id: string; order_created_at: string }> = [];
    for (let k=0;k<52;k++) {
      // Different minutes prove DESC; pairs within a minute also exercise the UUID tie-break.
      const createdAt=new Date(Date.UTC(2026,9,24,0,Math.floor(k/2))).toISOString();
      const p=await seed({ catalog,donorQuantity: 1,takerQuantity: 1,donorCreatedAt: createdAt });
      expected.push({ donor_order_id: p.donor.orderId,donor_order_item_id: p.donor.orderItemId,order_created_at: createdAt });
    }
    const shipped=await seed({ catalog,donorQuantity: 1,donorExchange: true,donorCreatedAt: '2026-10-24T01:00:00Z' });
    expect((await db().query(`select o.status,oi.line_kind from public.orders o join public.order_items oi on oi.order_id=o.id
      where oi.id=$1`,[shipped.donor.orderItemId])).rows[0]).toEqual({ status: 'shipped',line_kind: 'exchange' });
    expected.push({ donor_order_id: shipped.donor.orderId,donor_order_item_id: shipped.donor.orderItemId,
      order_created_at: '2026-10-24T01:00:00.000Z' });
    const excluded: string[]=[];
    // Each negative would precede every valid donor and survive LIMIT 50 if its exclusion were broken.
    // The partial cancel/refund donors still have ready units, so D>0 alone cannot exclude them.
    for (const input of [{ donorReview: true },{ donorCancelRequested: 1 },{ donorRefundProcessing: 1 },
      { donorStatus: 'pending' }]) {
      const p=await seed({ ...input,catalog,donorQuantity: 3,donorCreatedAt: '2026-10-25T00:00:00Z' });
      excluded.push(p.donor.orderItemId);
    }
    const differentVariant=await seed({ donorCreatedAt: '2026-10-25T00:00:00Z' });
    excluded.push(differentVariant.donor.orderItemId);
    await insertRestockMovement(db(),f.variantId,1);
    const ownItem=(await db().query(`insert into public.order_items
      (order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type)
      select order_id,item_id,variant_id,item_name,item_price,color,size,1,item_price,fulfillment_type
      from public.order_items where id=$1 returning id`,[f.taker.orderItemId])).rows[0].id as string;
    await seedGroupG1Allocation(db(),{ orderItemId: ownItem,quantity: 1,kind: 'paid' });
    expect((await states(f)).filter(r=>r.order_item_id===ownItem)).toMatchObject([{ status: 'ready',unit_from: 0,unit_to: 1 }]);
    const rows=await candidates(f);
    expect(rows).toHaveLength(50);
    // Plain code-unit order: lower-case hex UUID text sorts like the uuid type itself (no locale-dependent collation).
    const compare=(a: string,b: string)=>a<b?-1:a>b?1:0;
    const sorted=expected.sort((a,b)=>compare(b.order_created_at,a.order_created_at)
      ||compare(a.donor_order_id,b.donor_order_id)||compare(a.donor_order_item_id,b.donor_order_item_id)).slice(0,50);
    expect(rows.map(({ donor_order_id,donor_order_item_id,order_created_at })=>({
      donor_order_id,donor_order_item_id,order_created_at: new Date(order_created_at).toISOString(),
    }))).toEqual(sorted);
    expect(rows.map(r=>r.donor_order_item_id)).toContain(shipped.donor.orderItemId);
    for (const item of [...excluded,ownItem]) expect(rows.map(r=>r.donor_order_item_id)).not.toContain(item);
    expect(rows.every(r=>r.swappable_quantity===1&&r.taker_quantity===2)).toBe(true);
    const fee=await seed({ takerFeeWaiting: true }); expect(await candidates(fee)).toEqual([]);
    expect(await flow.rejected(()=>db().query('select * from public.list_admin_allocation_swap_candidates($1,$2,$3)',
      [f.donor.orderId,f.taker.orderItemId,actor]))).toEqual({ code: 'P0002',message: 'GROUP_G_SWAP_ITEM_NOT_FOUND' });
  });
});
