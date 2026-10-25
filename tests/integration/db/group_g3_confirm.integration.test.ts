/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb, connectLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { seedGroupG3ReadyOrder, seedGroupG3Slip, withRolePermissions } from './helpers/group-g3-fixtures';
import { seedGroupG1Allocation, seedGroupG1Shipment, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { setDeliveryTracking } from './helpers/delivery-tracking-fixtures';
import { G3C_ALLOWLIST } from './helpers/group-g-allowlist';

jest.setTimeout(90000);
type Confirmed = { id: string; number: string; version: number; shipmentDate: string; replayed: boolean; fulfillments: { orderId: string; fulfillmentId: string; number: number; completesOrder: boolean }[] };
const signature = 'admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)';
const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261025100130_group_g3_shipping_slips.sql'), 'utf8');

describe('G-3 confirm migration (no database)', () => {
  test('FREQ-533-AC-02: 各明細を消費してから発送行を書き、即時G-1境界と遅延消費ガードの両方を保つ', () => {
    const from = sql.indexOf('CREATE FUNCTION private.admin_confirm_shipment_slip(');
    const to = sql.indexOf('ALTER FUNCTION private.admin_confirm_shipment_slip(', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const body = sql.slice(from, to);
    const positions = [
      'v_before := private.capture_group_g_item_states(',
      "PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);",
      'FOREACH v_order IN ARRAY v_orders LOOP',
      'INSERT INTO public.order_fulfillments(',
      'FOR v_line IN SELECT',
      'PERFORM private.consume_group_g_allocations(v_line.order_item_id, v_line.quantity,',
      'INSERT INTO public.order_fulfillment_lines(',
      'INSERT INTO public.order_fulfillment_events(',
      'INSERT INTO public.shipment_slip_fulfillments(',
      'IF v_completes THEN',
      "PERFORM private.enqueue_order_email(v_order, 'shipped', NULL, v_fulfillment);",
      'PERFORM private.register_group_g_slip_tracking(',
      "UPDATE public.shipment_slips SET stage = 'confirmed'",
      'INSERT INTO public.shipment_slip_lines(',
      'INSERT INTO public.shipment_slip_versions(',
      'INSERT INTO public.shipment_date_history(',
      'PERFORM private.record_group_g_item_state_changes(',
      'INSERT INTO private.group_g_operations(',
    ].map((statement) => {
      const position = body.indexOf(statement);
      expect({ statement, present: position >= 0 }).toEqual({ statement, present: true });
      return position;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const lineLoop = body.slice(positions[4], body.indexOf('END LOOP;', positions[4]));
    expect(lineLoop).toContain('PERFORM private.consume_group_g_allocations(');
    expect(lineLoop).toContain('INSERT INTO public.order_fulfillment_lines(');
    expect(lineLoop).toContain('VALUES(v_fulfillment, v_line.order_item_id, v_line.quantity)');
  });
  test('FREQ-540-AC-11: consume・register・confirm を含む閉集合は（Task 6 の restore・cancel を足して）72本で、末尾assertにも新関数を含む', () => {
    expect(G3C_ALLOWLIST).toHaveLength(72);
    expect(new Set(G3C_ALLOWLIST).size).toBe(72);
    for (const name of ['consume_group_g_allocations', 'register_group_g_slip_tracking', 'admin_confirm_shipment_slip']) {
      expect(sql).toContain(`CREATE FUNCTION private.${name}(`);
      expect(sql.slice(sql.indexOf('-- G3C_FINAL_ASSERT_BEGIN'))).toContain(name);
    }
  });
});

describeLocalDb('G-3 shipment slip confirm', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string; let today: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']); today = await flow.today();
  });
  afterEach(async () => { await db().query('rollback'); });
  const ready = (input: Parameters<typeof seedGroupG3ReadyOrder>[1] = {}) => seedGroupG3ReadyOrder(db(), input);
  const draft = async (lines: { orderItemId: string; quantity: number }[]) => (await db().query(
    'select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r', [JSON.stringify(lines), actor, randomUUID()],
  )).rows[0].r as { id: string; number: string; version: number };
  type Options = { version?: number | null; carrier?: string | null; tracking?: string | null; date?: string | null; notify?: boolean | null; by?: string | null; key?: string | null; schema?: 'public' | 'private' };
  const confirm = async (id: string | null, o: Options = {}): Promise<Confirmed> => (await db().query(
    `select ${o.schema ?? 'public'}.admin_confirm_shipment_slip($1,$2,$3,$4,$5::date,$6,$7,$8) as r`,
    [id, o.version === undefined ? 1 : o.version, o.carrier === undefined ? 'yamato' : o.carrier,
      o.tracking === undefined ? 'ab-123' : o.tracking, o.date === undefined ? today : o.date, o.notify === undefined ? true : o.notify,
      o.by === undefined ? actor : o.by, o.key === undefined ? randomUUID() : o.key],
  )).rows[0].r;
  const tables = ['public.orders','public.item_variants','public.stock_movements','public.order_item_allocations',
    'public.order_item_allocation_events','public.order_item_state_events','public.order_fulfillments','public.order_fulfillment_lines',
    'public.order_fulfillment_events','public.shipment_slips','public.shipment_slip_lines','public.shipment_slip_fulfillments',
    'public.shipment_slip_versions','public.shipment_date_history','private.group_g_operations','private.order_email_outbox',
    'private.shipment_tracking_registrations','private.fulfillment_tracking_registrations'];
  // Digests verify complete row content without exposing addresses or bodies in failed assertions.
  const snapshot = async () => Promise.all(tables.map(async (table) => (await db().query(
    `select md5(coalesce(string_agg(v, ',' order by v),'')) as digest from (select to_jsonb(t)::text as v from ${table} t) x`,
  )).rows[0].digest as string));
  const refused = async (id: string, message: string, options: Options = {}, code = '22023') => {
    const before = await snapshot();
    expect(await flow.rejected(() => confirm(id, options))).toEqual({ message, code });
    expect(await snapshot()).toEqual(before);
  };

  test('FREQ-533-AC-02: 会員の別日の2注文を原子的に確定し、各注文の発送・行・出来事・outbox・消費・状態履歴を作る。Fと台帳は不変、Aと手元が発送分減る', async () => {
    const member = await flow.createActor([]);
    const a = await ready({ createdAt: '2026-10-18T00:00:00Z' });
    const b = await ready({ createdAt: '2026-10-19T00:00:00Z' });
    for (const f of [a,b]) await db().query('update public.orders set user_id=$2 where id=$1', [f.orderId, member]);
    await seedGroupG1Shipment(db(), { orderId: a.orderId, lines: [{ orderItemId: a.orderItemId, quantity: 1 }], shippedAt: '2026-10-21T00:00:00Z' });
    const slip = await draft([{ orderItemId: b.orderItemId, quantity: 4 }, { orderItemId: a.orderItemId, quantity: 2 }]);
    const before = (await db().query(`select (select sum(stock_quantity) from public.item_variants)::int f,
      (select sum(remaining_quantity) from public.order_item_allocations)::int a,
      (select count(*) from public.stock_movements)::int ledger`)).rows[0];
    const key = randomUUID(); const result = await confirm(slip.id, { key });
    expect(result).toEqual({ id: slip.id, number: slip.number, version: 2, shipmentDate: today, replayed: false,
      fulfillments: expect.any(Array) });
    expect(result.fulfillments.map(f => f.orderId)).toEqual([a.orderId,b.orderId].sort());
    expect(result.fulfillments).toHaveLength(2);
    const after = (await db().query(`select (select sum(stock_quantity) from public.item_variants)::int f,
      (select sum(remaining_quantity) from public.order_item_allocations)::int a,
      (select count(*) from public.stock_movements)::int ledger`)).rows[0];
    expect(after).toEqual({ ...before, a: before.a - 6 });
    expect(after.f + after.a).toBe(before.f + before.a - 6);
    for (const f of result.fulfillments) {
      const full = (await db().query(`select *, request_key=md5('slip_fulfillment:' || $2::text || ':' || order_id::text)::uuid as derived,
        request_fingerprint=private.fulfillment_create_fingerprint(order_id,shipping_carrier,tracking_number,notify_customer,
          (select jsonb_agg(jsonb_build_object('order_item_id',l.order_item_id,'quantity',l.quantity) order by l.order_item_id)
           from public.order_fulfillment_lines l where l.fulfillment_id=order_fulfillments.id)) as fingerprint_ok
        from public.order_fulfillments where id=$1`, [f.fulfillmentId,key])).rows[0];
      expect(full).toMatchObject({ order_id: f.orderId, number: f.orderId === a.orderId ? 2 : 1,
        shipping_carrier: 'yamato', tracking_number: 'ab-123', notify_customer: true, completes_order: f.orderId === b.orderId,
        created_by: actor, derived: true, fingerprint_ok: true });
      expect((await db().query('select * from public.order_fulfillment_events where fulfillment_id=$1', [f.fulfillmentId])).rows)
        .toEqual([expect.objectContaining({ tracking_version: 1, status: 'confirmed', source: 'shipment', happened_at: full.shipped_at })]);
      expect((await db().query("select order_id,fulfillment_id from private.order_email_outbox where fulfillment_id=$1 and kind='shipped' and origin='auto'",[f.fulfillmentId])).rows)
        .toEqual([{ order_id: f.orderId, fulfillment_id: f.fulfillmentId }]);
    }
    const op = (await db().query('select * from private.group_g_operations where request_key=$1 and operation=$2', [key,'shipment_slip_confirm'])).rows[0];
    expect(op).toMatchObject({ cause_type: 'shipment_slip', cause_id: slip.id, actor_id: actor, result });
    expect(op.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await db().query('select event_type,quantity,sequence,reason,actor_id from public.order_item_allocation_events where operation_id=$1 order by quantity',[op.id])).rows)
      .toEqual([2,4].map(quantity => ({ event_type: 'consume', quantity, sequence: 1, reason: 'shipment_confirm', actor_id: actor })));
    expect((await db().query('select from_status,to_status,unit_to-unit_from as n,reason from public.order_item_state_events where operation_id=$1 order by n',[op.id])).rows)
      .toEqual([2,4].map(n => ({ from_status:'ready',to_status:'shipped',n,reason:'shipment_slip_confirm' })));
    expect((await db().query('select status from public.orders where id=$1',[a.orderId])).rows[0].status).toBe('paid');
    expect((await db().query('select status,shipped_at is not null as stamped,shipping_carrier,tracking_number from public.orders where id=$1',[b.orderId])).rows[0])
      .toEqual({status:'shipped',stamped:true,shipping_carrier:'yamato',tracking_number:'ab-123'});
    expect((await db().query('select count(*)::int n from public.shipment_slip_fulfillments where slip_id=$1',[slip.id])).rows[0].n).toBe(2);
    expect((await db().query('select count(*)::int n from public.shipment_slip_lines where slip_id=$1',[slip.id])).rows[0].n).toBe(2);
    await db().query('set constraints all immediate');
  });

  test.each(['created_at優先', '同時刻はid順'] as const)('FREQ-533-AC-02: 複数の割当はcreated_at,idのFIFO順に必要量だけ消費する（%s）', async (mode) => {
    const f = await ready({ quantity: 8, allocated: 0 });
    const highId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
    const lowId = '00000000-0000-4000-8000-000000000001';
    const untouchedId = '00000000-0000-4000-8000-000000000002';
    const day = (n: number) => `2026-10-${n}T00:00:00Z`;
    // The oldest allocation has the greatest id in the date case; the tie case must instead use the smaller id.
    await seedGroupG1Allocation(db(), { orderItemId: f.orderItemId, quantity: 2, kind: 'paid', id: highId, createdAt: day(18) });
    await seedGroupG1Allocation(db(), { orderItemId: f.orderItemId, quantity: 3, kind: 'paid', id: lowId, createdAt: day(mode === 'created_at優先' ? 19 : 18) });
    await seedGroupG1Allocation(db(), { orderItemId: f.orderItemId, quantity: 3, kind: 'paid', id: untouchedId, createdAt: day(20) });
    type Allocation = { id: string; remaining_quantity: number; version: string; created_at: Date; updated_at: Date };
    const read = async (): Promise<Allocation[]> => (await db().query(`select id,remaining_quantity,version::text,created_at,updated_at
      from public.order_item_allocations where order_item_id=$1 order by created_at,id`, [f.orderItemId])).rows;
    const before = await read();
    const oldest = mode === 'created_at優先' ? [highId, lowId, untouchedId] : [lowId, highId, untouchedId];
    expect(before.map((row) => row.id)).toEqual(oldest);
    expect(before.map((row) => row.version)).toEqual(['0', '0', '0']);
    expect(before.map((row) => row.remaining_quantity)).toEqual(mode === 'created_at優先' ? [2, 3, 3] : [3, 2, 3]);
    const slip = await draft([{ orderItemId: f.orderItemId, quantity: 4 }]);
    await confirm(slip.id);
    const after = await read();
    expect(after.map((row) => row.id)).toEqual(oldest);
    expect(after.map((row) => row.remaining_quantity)).toEqual([0, 1, 3]);
    for (let index = 0; index < 2; index += 1) {
      expect(BigInt(after[index].version)).toBe(BigInt(before[index].version) + BigInt(1));
    }
    expect(after[2]).toEqual(before[2]); // Stop at the requested quantity: the later eligible paid allocation stays untouched.
    const consumed = (await db().query(`select e.allocation_id,e.quantity,e.reason,e.sequence from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id=e.allocation_id
      where a.order_item_id=$1 and e.event_type='consume' order by a.created_at,a.id`, [f.orderItemId])).rows;
    expect(consumed).toEqual([
      { allocation_id: oldest[0], quantity: before[0].remaining_quantity, reason: 'shipment_confirm', sequence: 1 },
      { allocation_id: oldest[1], quantity: 4 - before[0].remaining_quantity, reason: 'shipment_confirm', sequence: 1 },
    ]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-533-AC-02: 2番目の注文の発送行INSERTの故障は全注文・消費・outbox・票・操作を原状へ戻す', async () => {
    const a=await ready(); const b=await ready();
    const slip=await draft([a,b].map(f=>({orderItemId:f.orderItemId,quantity:2})));
    const last=[a,b].sort((x,y)=>x.orderId.localeCompare(y.orderId))[1];
    await db().query(`create function public.g3_confirm_fault() returns trigger language plpgsql as $f$ begin
      if new.order_item_id='${last.orderItemId}'::uuid then
        if (select count(*) from public.order_fulfillments where order_id in ('${a.orderId}'::uuid,'${b.orderId}'::uuid)) <> 2
          or (select count(*) from public.order_fulfillment_lines l join public.order_fulfillments f on f.id=l.fulfillment_id where f.order_id in ('${a.orderId}'::uuid,'${b.orderId}'::uuid)) <> 1
          or (select count(*) from private.order_email_outbox where order_id in ('${a.orderId}'::uuid,'${b.orderId}'::uuid) and kind='shipped') <> 1
          or (select count(*) from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
            where a.order_item_id in ('${a.orderItemId}'::uuid,'${b.orderItemId}'::uuid) and e.event_type='consume') <> 2 then
          raise exception 'G3_FAULT_PROGRESS_MISSING' using errcode='P0001';
        end if;
        raise exception 'G3_INJECTED' using errcode='P0001';
      end if; return new; end $f$`);
    await db().query('create trigger g3_confirm_fault before insert on public.order_fulfillment_lines for each row execute function public.g3_confirm_fault()');
    await refused(slip.id,'G3_INJECTED',{},'P0001');
  });

  test('FREQ-533-AC-03: 再送は全記録増加0、異内容・actorは衝突、別キーで確定済みはNOT_DRAFT', async () => {
    const f=await ready(); const slip=await draft([{orderItemId:f.orderItemId,quantity:2}]); const key=randomUUID();
    const first=await confirm(slip.id,{key}); const before=await snapshot();
    expect(await confirm(slip.id,{key,version:999})).toEqual({...first,replayed:true}); expect(await snapshot()).toEqual(before);
    for (const o of [{notify:false},{tracking:'other'},{carrier:'sagawa'},{date:await flow.today(-1)},{by:await flow.createActor(['supporter'])}])
      await refused(slip.id,'GROUP_G_REQUEST_KEY_CONFLICT',{key,...o},'23505');
    await refused(slip.id,'GROUP_G_SLIP_NOT_DRAFT',{},'55000');
  });
  test.each([2,3])('FREQ-533-AC-03: 同じ明細の別下書きは先に確定した分を超えられない（残り不足=%s）',async quantity=>{
    const f=await ready();const a=await draft([{orderItemId:f.orderItemId,quantity:3}]);const b=await draft([{orderItemId:f.orderItemId,quantity}]);
    await confirm(a.id);await refused(b.id,'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY');
  });
  test.each([
    ['会社のみ',{tracking:null},'GROUP_G_SLIP_TRACKING_INCOMPLETE'],['番号のみ',{carrier:null},'GROUP_G_SLIP_TRACKING_INCOMPLETE'],
    ['記号',{tracking:'a?'},'GROUP_G_ARGUMENT_INVALID'],['65字',{tracking:'a'.repeat(65)},'GROUP_G_ARGUMENT_INVALID'],
    ['版0',{version:0},'GROUP_G_ARGUMENT_INVALID'],['版NULL',{version:null},'GROUP_G_ARGUMENT_INVALID'],
    ['日付NULL',{date:null},'GROUP_G_ARGUMENT_INVALID'],['通知NULL',{notify:null},'GROUP_G_ARGUMENT_INVALID'],
    ['actorNULL',{by:null},'GROUP_G_ARGUMENT_INVALID'],['keyNULL',{key:null},'GROUP_G_ARGUMENT_INVALID'],
  ] as const)('FREQ-533-AC-05: 引数 %s は拒否し不変',async(_label,o,message)=>{
    const f=await ready();const s=await draft([{orderItemId:f.orderItemId,quantity:2}]);await refused(s.id,message,o);
  });
  test.each([false,true])('FREQ-533-AC-05: 番号なしでも確定・shippedメール可、親と外部登録は0（notify=%s）',async notify=>{
    const f=await ready();const s=await draft([{orderItemId:f.orderItemId,quantity:4}]);
    const r=await confirm(s.id,{carrier:null,tracking:null,notify});const id=r.fulfillments[0].fulfillmentId;
    expect((await db().query('select shipping_carrier,tracking_number from public.order_fulfillments where id=$1',[id])).rows[0]).toEqual({shipping_carrier:null,tracking_number:null});
    expect((await db().query('select shipping_carrier,tracking_number from public.orders where id=$1',[f.orderId])).rows[0]).toEqual({shipping_carrier:null,tracking_number:null});
    expect((await db().query('select count(*)::int n from private.shipment_tracking_registrations where slip_id=$1',[s.id])).rows[0].n).toBe(0);
    expect((await db().query('select count(*)::int n from private.fulfillment_tracking_registrations where fulfillment_id=$1',[id])).rows[0].n).toBe(0);
    expect((await db().query("select count(*)::int n from private.order_email_outbox where fulfillment_id=$1 and kind='shipped'",[id])).rows[0].n).toBe(notify?1:0);
    await db().query('set constraints all immediate');
  });
  test.each([false,true])('FREQ-533-AC-05: 番号ありの親は票×版で1つ、オンの時だけ最小order_idの代表を外部登録（enabled=%s）',async enabled=>{
    await setDeliveryTracking(db(), enabled, await flow.createActor(['admin']));
    expect((await db().query('select delivery_tracking_enabled from public.shop_settings where id=1')).rows[0].delivery_tracking_enabled).toBe(enabled);
    const a=await ready();const b=await ready();const s=await draft([a,b].map(f=>({orderItemId:f.orderItemId,quantity:2})));
    const r=await confirm(s.id,{tracking:' ab-123 '});const leader=r.fulfillments[0];
    expect((await db().query('select leader_fulfillment_id,carrier,tracking_number,tracking_version from private.shipment_tracking_registrations where slip_id=$1',[s.id])).rows)
      .toEqual([{leader_fulfillment_id:leader.fulfillmentId,carrier:'yamato',tracking_number:'AB-123',tracking_version:1}]);
    const registrations=(await db().query(`select r.fulfillment_id,r.tracking_number,r.expires_at=f.shipped_at+interval '30 days' as expires
      from private.fulfillment_tracking_registrations r join public.order_fulfillments f on f.id=r.fulfillment_id where f.id=any($1::uuid[])`,[r.fulfillments.map(f=>f.fulfillmentId)])).rows;
    expect(registrations).toEqual(enabled?[{fulfillment_id:leader.fulfillmentId,tracking_number:'AB-123',expires:true}]:[]);
  });

  test.each([
    ['2026-10-20T14:59:59Z','2026-10-20','2026-10-19'],['2026-10-20T15:00:00Z','2026-10-21','2026-10-20'],
  ])('FREQ-535-AC-02: 入金%sのJST境界は%sで、前日は拒否する',async(paidAt,lower,previous)=>{
    const f=await ready({paidAt});const s=await draft([{orderItemId:f.orderItemId,quantity:2}]);
    await refused(s.id,'GROUP_G_SHIPMENT_DATE_INVALID',{date:previous});
    await refused(s.id,'GROUP_G_SHIPMENT_DATE_INVALID',{date:await flow.today(1)});
    const r=await confirm(s.id,{date:lower});expect(r.shipmentDate).toBe(lower);
    const row=(await db().query(`select shipment_date::text,shipped_at=now() as shipped,delivery_status_at=now() as status_at from public.order_fulfillments where id=$1`,[r.fulfillments[0].fulfillmentId])).rows[0];
    expect(row).toEqual({shipment_date:lower,shipped:true,status_at:true});
    expect((await db().query('select stage,confirmed_at=now() as confirmed,version,expires_at from public.shipment_slips where id=$1',[s.id])).rows[0])
      .toEqual({stage:'confirmed',confirmed:true,version:2,expires_at:null});
    expect((await db().query('select kind,version,previous_date::text,new_date::text,reason from public.shipment_date_history where slip_id=$1',[s.id])).rows)
      .toEqual([{kind:'initial',version:2,previous_date:today,new_date:lower,reason:null}]);
    expect((await db().query('select kind,version,tracking_version,shipment_date::text from public.shipment_slip_versions where slip_id=$1',[s.id])).rows)
      .toEqual([{kind:'confirm',version:2,tracking_version:1,shipment_date:lower}]);
  });
  test('FREQ-535-AC-02: 複数注文の遅い入金日を下限とし、初期値と同日でもinitial履歴1件',async()=>{
    const a=await ready({paidAt:'2026-10-20T14:59:59Z'});const b=await ready({paidAt:'2026-10-20T15:00:00Z'});
    const s=await draft([a,b].map(f=>({orderItemId:f.orderItemId,quantity:2})));
    await refused(s.id,'GROUP_G_SHIPMENT_DATE_INVALID',{date:'2026-10-20'});await confirm(s.id);
    expect((await db().query('select previous_date::text,new_date::text from public.shipment_date_history where slip_id=$1',[s.id])).rows)
      .toEqual([{previous_date:today,new_date:today}]);
  });
  test('FREQ-535-AC-02: paid_atなしはORDER_NOT_SHIPPABLE',async()=>{
    const f=await ready({paidAt:null});const id=await seedGroupG3Slip(db(),{actorId:actor,draftLines:[{orderItemId:f.orderItemId,quantity:2}]});
    await refused(id,'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE');
  });
  test('FREQ-533-AC-02: 下書き後の支払確認・未払・会員紐づき・期限・版を再検証し拒否時不変',async()=>{
    const a=await ready();const b=await ready();const s=await draft([a,b].map(f=>({orderItemId:f.orderItemId,quantity:2})));
    await refused(s.id,'GROUP_G_SLIP_VERSION_CONFLICT',{version:2},'55000');
    for (const [change,message] of [
      [()=>db().query("select private.ensure_group_g_payment_review_hold($1,'g3-confirm',null,null,null)",[a.orderId]),'GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED'],
      [()=>setOrderStatusForFixture(db(),[a.orderId],'cancelled'),'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE'],
      [async()=>db().query('update public.orders set user_id=$2 where id=$1',[a.orderId,await flow.createActor([])]),'GROUP_G_SLIP_CUSTOMER_MISMATCH'],
    ] as const) {
      await db().query('savepoint changed');await change();await refused(s.id,message);await db().query('rollback to savepoint changed');await db().query('release savepoint changed');
    }
    const expired=await seedGroupG3Slip(db(),{actorId:actor,expired:true,draftLines:[{orderItemId:a.orderItemId,quantity:1}]});
    await refused(expired,'GROUP_G_SLIP_DRAFT_EXPIRED',{},'55000');await refused(randomUUID(),'GROUP_G_SLIP_NOT_FOUND',{},'P0002');
  });
  test('FREQ-533-AC-02: 法定配送先は下書き後も変更不可で、不足する注文を指す票は確定時に拒否する',async()=>{
    const valid=await ready();await draft([{orderItemId:valid.orderItemId,quantity:2}]);
    const before=await snapshot();
    expect(await flow.rejected(()=>db().query("update public.orders set shipping_phone='' where id=$1",[valid.orderId])))
      .toEqual({message:'immutable legal order fields cannot be changed',code:'23001'});
    expect(await snapshot()).toEqual(before);
    // Legal fields cannot change after INSERT. Seed the defensive draft reference instead of bypassing that guard.
    const incomplete=await ready({shipping:{phone:' '}});
    const slip=await seedGroupG3Slip(db(),{actorId:actor,draftLines:[{orderItemId:incomplete.orderItemId,quantity:2}]});
    await refused(slip,'GROUP_G_SLIP_ADDRESS_INCOMPLETE');
  });
  test('FREQ-533-AC-02: consumeの裏付けは即時検査で通り、不足と余分なconsume1つを遅延ガードが拒否する',async()=>{
    // With A=3 and quantity=4, consuming only 1 then shipping 2 still satisfies the immediate G-1 bound (2+2=4).
    // It must reach the deferred consumption guard rather than fail at the earlier G-1 constraint.
    const f=await ready({allocated:3});const s=await draft([{orderItemId:f.orderItemId,quantity:2}]);
    const before=await snapshot();
    const definition=(await db().query('select pg_get_functiondef($1::regprocedure) def',[`private.${signature}`])).rows[0].def as string;
    expect(definition).toContain('private.consume_group_g_allocations(v_line.order_item_id, v_line.quantity,');
    const less=await flow.rejected(async()=>{
      await db().query(definition.replace('private.consume_group_g_allocations(v_line.order_item_id, v_line.quantity,','private.consume_group_g_allocations(v_line.order_item_id, v_line.quantity - 1,'));
      await confirm(s.id);
      expect((await db().query('select shipped,completed,quantity from private.order_line_fulfillment($1) where order_item_id=$2',[f.orderId,f.orderItemId])).rows[0])
        .toMatchObject({shipped:2,completed:4,quantity:4});
      await db().query('set constraints all immediate');
    });
    expect(less).toMatchObject({message:'GROUP_G_SHIPMENT_CONSUMPTION',code:'23514'});
    expect(await snapshot()).toEqual(before);
    await confirm(s.id);await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
    const result=await flow.rejected(async()=>{
      // A valid allocation decrease/event pair alone is still not backed by a shipment line.
      const op=randomUUID();await db().query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
        values($1,'fixture_consume',$2,repeat('a',64),'order',$3,'{}')`,[op,randomUUID(),f.orderId]);
      await db().query('select private.consume_group_g_allocations($1,1,$2,$3)',[f.orderItemId,op,actor]);
      await db().query('set constraints all immediate');
    });
    expect(result).toMatchObject({message:'GROUP_G_SHIPMENT_CONSUMPTION',code:'23514'});
  });
  test('FREQ-535-AC-02: 交換手数料待ちは下書き後にも拒否し、入金後も初回paid_atが出荷日の下限',async()=>{
    const f=await ready({paidAt:'2026-10-20T15:00:00Z'});
    const shipment=await seedGroupG1Shipment(db(),{orderId:f.orderId,lines:[{orderItemId:f.orderItemId,quantity:1}],shippedAt:'2026-10-21T00:00:00Z'});
    const returnId=(await db().query(`insert into public.order_returns
      (order_id,number,source,status,request_key,request_fingerprint,return_method,return_shipping_payer,notify_customer)
      values($1,1,'customer_request','open',$2,'fixture','customer_ships','customer',false) returning id`,[f.orderId,randomUUID()])).rows[0].id;
    const returnLine=(await db().query(`insert into public.order_return_lines
      (return_id,fulfillment_id,order_item_id,quantity,reason,resolution,exchange_variant_id,exchange_method)
      values($1,$2,$3,1,'unknown','exchange',$4,'make') returning id`,[returnId,shipment,f.orderItemId,f.variantId])).rows[0].id;
    const exchange=(await db().query(`insert into public.order_items
      (order_id,item_id,variant_id,item_name,item_price,quantity,line_total,fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
      values($1,$2,$3,'exchange',0,1,0,'backorder','exchange',$4,5000) returning id`,[f.orderId,f.itemId,f.variantId,returnLine])).rows[0].id;
    await seedGroupG1Allocation(db(),{orderItemId:exchange,quantity:1,kind:'paid'});
    const slip=await draft([{orderItemId:exchange,quantity:1}]);
    await db().query('update public.order_returns set fee_due_amount=100 where id=$1',[returnId]);
    await refused(slip.id,'GROUP_G_SLIP_EXCHANGE_ON_HOLD');
    await db().query('select public.admin_record_return_fee_payment($1,$2,$3,false)',[returnId,actor,'fixture']);
    expect((await db().query("select paid_at='2026-10-20T15:00:00Z'::timestamptz as same from public.orders where id=$1",[f.orderId])).rows[0].same).toBe(true);
    await refused(slip.id,'GROUP_G_SHIPMENT_DATE_INVALID',{date:'2026-10-20'});
    expect((await confirm(slip.id,{date:'2026-10-21'})).shipmentDate).toBe('2026-10-21');
  });
  test('FREQ-533-AC-02: 棚卸減で準備数が減った下書きは確定で再検証する',async()=>{
    const manager=await flow.createActor(['admin']);
    const f=await ready();const slip=await draft([{orderItemId:f.orderItemId,quantity:4}]);
    const counts=(await db().query(`select v.stock_quantity+sum(a.remaining_quantity)::integer hand from public.item_variants v
      join public.order_item_allocations a on a.variant_id=v.id where v.id=$1 group by v.id`,[f.variantId])).rows[0];
    await db().query("select public.admin_record_stock_movement($1,$2,$3,'adjustment','fixture',$4,$5,3)",[f.itemId,f.variantId,1-counts.hand,manager,randomUUID()]);
    await refused(slip.id,'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY');
  });
  test.each(['perform 1 from only "public"."orders" limit 1;', "perform private.group_g_actor_has_permissions(_actor_id,array['admin.shipping.manage']);"])(
    'FREQ-540-AC-11: 確定本体の押さえ前の参照も末尾assertが止める (%s)',async injected=>{
      const definition=(await db().query('select pg_get_functiondef($1::regprocedure) def',[`private.${signature}`])).rows[0].def as string;
      const tampered=definition.replace('PERFORM private.lock_group_g_shipment_slips(',injected+' PERFORM private.lock_group_g_shipment_slips(');
      expect(tampered).not.toBe(definition);
      const start=sql.indexOf('DO $g3c_final_objects$');const end=sql.indexOf('$g3c_final_objects$;',start)+ '$g3c_final_objects$;'.length;
      expect(await flow.rejected(async()=>{await db().query(tampered);await db().query(sql.slice(start,end));}))
        .toEqual({message:'GROUP_G_MIGRATION_ASSERTION_FAILED',code:'55000',detail:'shipment_slip_lock_order'});
    },
  );
  test('FREQ-540-AC-11: 確定はadvisory待ちの間に設定・票・注文・variant・割当の行を持たない',async()=>{
    const f=await ready();const slip=await draft([{orderItemId:f.orderItemId,quantity:2}]);
    const other=await connectLocalDb();let pending: Promise<unknown> | undefined;
    try {
      await other.query('begin');await other.query("set local statement_timeout='10s'");
      const pid=(await other.query('select pg_backend_pid() pid')).rows[0].pid;
      pending=other.query('select public.admin_confirm_shipment_slip($1,1,null,null,$2::date,false,$3,$4)',[slip.id,today,actor,randomUUID()]).then(()=>({ok:true}),()=>({ok:false}));
      let waiting=false;
      for(let i=0;i<300&&!waiting;i+=1) waiting=(await db().query("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) waiting",[pid])).rows[0].waiting;
      expect(waiting).toBe(true);
      for(const [table,column,id] of [['public.shop_settings','id',1],['public.shipment_slips','id',slip.id],['public.orders','id',f.orderId],['public.item_variants','id',f.variantId],['public.order_item_allocations','id',f.allocationId]] as const)
        await db().query(`select ${column} from ${table} where ${column}=$1 for update nowait`,[id]);
      await db().query('select pg_cancel_backend($1)',[pid]);await pending;
    } finally {if(pending) await pending;await other.query('rollback');await other.end();}
  });

  test('FREQ-540-AC-10: 4権限を全て必要とし、有効な役割だけを使う',async()=>{
    const f=await ready();const s=await draft([{orderItemId:f.orderItemId,quantity:2}]);
    for (const code of ['admin.shipping.manage','admin.shipping.read','admin.orders.manage','admin.orders.read'])
      await withRolePermissions(db(),'supporter',[],[code],()=>refused(s.id,'GROUP_G_FORBIDDEN',{},'42501'));
    for (const by of [await flow.createActor([]),await flow.createActor(['supporter'],{inactive:['supporter']}),await flow.createActor(['supporter'],{expired:['supporter']})])
      await refused(s.id,'GROUP_G_FORBIDDEN',{by},'42501');
    expect((await confirm(s.id)).version).toBe(2);
  });
  test('FREQ-540-AC-11: 公開入口はINVOKER委譲、private本体はDEFINER、helperにEXECUTEなし、allowlist72本',async()=>{
    const rows=(await db().query(`select n.nspname,p.prosecdef,p.prosrc,has_function_privilege('service_role',p.oid,'EXECUTE') service,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid=any($1::regprocedure[])`,[[`public.${signature}`,`private.${signature}`,
      'private.consume_group_g_allocations(uuid,integer,uuid,uuid)','private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)']])).rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({anon:false,authenticated:false});
    expect(rows.find(r=>r.nspname==='public')).toMatchObject({prosecdef:false,service:true});
    expect(rows.find(r=>r.nspname==='public').prosrc).toContain('SELECT private.admin_confirm_shipment_slip(');
    expect(rows.filter(r=>!r.service)).toHaveLength(2);
    expect((await db().query('select cardinality(private.group_g_writer_allowlist()) n')).rows[0].n).toBe(72);
  });
  test('FREQ-540-AC-11: consumeは共通advisoryなしでは拒否する',async()=>{
    const other=await connectLocalDb();try {
      await expect(other.query('select private.consume_group_g_allocations($1,1,$2,$3)',[randomUUID(),randomUUID(),actor]))
        .rejects.toMatchObject({message:'GROUP_G_INVENTORY_LOCK_REQUIRED',code:'55000'});
    } finally {await other.end();}
  });
});
