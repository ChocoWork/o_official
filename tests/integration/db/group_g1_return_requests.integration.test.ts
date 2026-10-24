/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createShippedOrderFixture, type ShippedOrderFixture } from './helpers/order-fixtures';

type Fx = ShippedOrderFixture & { owner: string; actor: string };
const WRITERS = [
  'customer_request_return(uuid,uuid,uuid,jsonb)',
  'admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
  'admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
  'admin_decline_return(uuid,uuid,text,text)', 'admin_cancel_return(uuid,uuid)',
];

async function refusal(db: PgClient, run: () => Promise<unknown>, message: string, code = '22023') {
  await db.query('savepoint expected_refusal');
  try { await expect(run()).rejects.toMatchObject({ message, code }); }
  finally {
    await db.query('rollback to savepoint expected_refusal');
    await db.query('release savepoint expected_refusal');
  }
}

describeLocalDb('G-1 return request quantities, history and operations', getDb => {
  const db = () => getDb();
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await db().query(`update public.shop_return_settings set requests_enabled=true, request_types='returns_and_cancellations',
      return_address_name='fixture', return_address_postal_code='1000001', return_address_line='fixture',
      return_address_phone='0312345678', no_return_needed_enabled=false where id=1`);
    await db().query(`update public.shop_return_reason_settings set shown=true, photo='optional', resolutions='refund_and_exchange'
      where reason='defective'`);
  });
  afterEach(async () => { await db().query('rollback'); });

  async function fixture(): Promise<Fx> {
    const users: string[] = [];
    for (let i = 0; i < 2; i++) users.push((await db().query(`insert into auth.users
      (id,email,raw_user_meta_data,created_at,updated_at) values(gen_random_uuid(),$1,'{}',now(),now()) returning id`,
    [`g1-return-${randomUUID()}@example.com`])).rows[0].id as string);
    const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 5 }],
      shipments: [{ lines: [{ lineIndex: 0, quantity: 3 }] }] });
    await db().query('update public.orders set user_id=$1 where id=$2', [users[0], fx.orderId]);
    return { ...fx, owner: users[0], actor: users[1] };
  }
  function lines(f: Fx, quantity = 1) {
    return [{ fulfillment_id: f.fulfillments[0].id, order_item_id: f.orderItemIds[0], quantity,
      reason: 'defective', customer_note: 'fixture', requested_resolution: 'refund',
      requested_exchange_variant_id: null, photos: [] }];
  }
  async function request(f: Fx, quantity = 1, key = randomUUID()) {
    return (await db().query('select * from public.customer_request_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
      [f.orderId, f.owner, key, JSON.stringify(lines(f, quantity))])).rows[0];
  }
  async function create(f: Fx, quantity = 1, key = randomUUID()) {
    return (await db().query(`select * from public.admin_create_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb,
      'customer_ships','shop',null,null,0,0,0,0,'private fixture',false)`,
    [f.orderId, f.actor, key, JSON.stringify([{ ...lines(f, quantity)[0], resolution: 'refund',
      exchange_variant_id: null, exchange_method: null }])])).rows[0];
  }
  async function approve(f: Fx, id: string) {
    const ls = (await db().query('select id from public.order_return_lines where return_id=$1 order by id', [id])).rows;
    return (await db().query(`select * from public.admin_approve_return($1::uuid,$2::uuid,$3::jsonb,
      'customer_ships','shop',null,null,0,0,0,0,'private fixture',false)`, [id, f.actor,
    JSON.stringify(ls.map(l => ({ return_line_id: l.id, resolution: 'refund', exchange_variant_id: null, exchange_method: null })))])).rows[0];
  }
  async function ranges(f: Fx, expected: Record<string, number>) {
    const rows = (await db().query(`select status,unit_from,unit_to from private.group_g_item_state_ranges($1::uuid[])
      where order_item_id=$2 order by unit_from`, [[f.orderId], f.orderItemIds[0]])).rows;
    let end = 0;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      expect(row.unit_from).toBe(end);
      expect(row.unit_to).toBeGreaterThan(row.unit_from);
      end = row.unit_to;
      counts[row.status] = (counts[row.status] ?? 0) + row.unit_to - row.unit_from;
    }
    expect(end).toBe(5);
    expect(counts).toEqual(expected);
  }
  async function operation(f: Fx, name: string, id: string, from: string, to: string, n: number, reason = name) {
    const ops = (await db().query(`select id,request_key,actor_id,cause_type,result from private.group_g_operations
      where operation=$1 and cause_id=$2`, [name, id])).rows;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ actor_id: name === 'customer_request_return' ? f.owner : f.actor,
      cause_type: 'order_return', result: { return_id: id, order_id: f.orderId } });
    const events = (await db().query(`select from_status,to_status,unit_to-unit_from as n,reason,sequence,actor_id
      from public.order_item_state_events where operation_id=$1 and order_item_id=$2 order by unit_from`,
    [ops[0].id, f.orderItemIds[0]])).rows;
    expect(events).toEqual([{ from_status: from, to_status: to, n, reason, sequence: 1, actor_id: ops[0].actor_id }]);
    return ops[0];
  }
  async function stockSnapshot(f: Fx) {
    return (await db().query(`select
      (select stock_quantity from public.item_variants where id=$1::bigint) as free,
      (select sum(remaining_quantity)::int from public.order_item_allocations where order_item_id=$2::uuid) as allocated,
      (select count(*)::int from public.stock_movements where variant_id=$3::bigint) as movements,
      (select count(*)::int from public.order_item_allocation_events e join public.order_item_allocations a
        on a.id=e.allocation_id where a.order_item_id=$4::uuid) as allocation_events`,
    [f.variantIds[0], f.orderItemIds[0], f.variantIds[0], f.orderItemIds[0]])).rows[0];
  }

  test('部分申請→承認は発送分だけを変え、未発送A・在庫を保ち、再送/CASの増分は0', async () => {
    const f = await fixture();
    const snapshot = await stockSnapshot(f);
    const key = randomUUID();
    const r = await request(f, 2, key);
    await ranges(f, { return_requested: 2, shipped: 1, ready: 2 });
    const op = await operation(f, 'customer_request_return', r.return_id, 'shipped', 'return_requested', 2);
    expect(op.request_key).toBe(key);
    expect(await request(f, 2, key)).toEqual({ ...r, replayed: true });
    expect(await approve(f, r.return_id)).toEqual({ return_id: r.return_id, status: 'open' });
    await ranges(f, { return_in_progress: 2, shipped: 1, ready: 2 });
    const approved = await operation(f, 'admin_approve_return', r.return_id, 'return_requested', 'return_in_progress', 2);
    expect(approved.request_key).toBe((await db().query("select md5('admin_approve_return:' || $1::text)::uuid as id", [r.return_id])).rows[0].id);
    await refusal(db(), () => approve(f, r.return_id), 'RETURN_STATE_CONFLICT');
    expect(await stockSnapshot(f)).toEqual(snapshot);
    expect(await request(f, 2, key)).toEqual({ ...r, replayed: true });
    await operation(f, 'customer_request_return', r.return_id, 'shipped', 'return_requested', 2);
    await operation(f, 'admin_approve_return', r.return_id, 'return_requested', 'return_in_progress', 2);
    await db().query('set constraints all immediate');
  });

  test('却下は対象数量を管理の配達済みに戻し、配送event/delivered_atを作らない', async () => {
    const f = await fixture();
    const before = (await db().query('select delivered_at from public.order_fulfillments where id=$1', [f.fulfillments[0].id])).rows;
    expect(before).toEqual([{ delivered_at: null }]);
    const deliveryCount = (await db().query('select count(*)::int n from public.order_fulfillment_events where fulfillment_id=$1', [f.fulfillments[0].id])).rows;
    const snapshot = await stockSnapshot(f);
    const r = await request(f, 2);
    const run = () => db().query("select * from public.admin_decline_return($1::uuid,$2::uuid,'other','fixture')", [r.return_id, f.actor]);
    expect((await run()).rows).toEqual([{ return_id: r.return_id, status: 'declined' }]);
    await ranges(f, { delivered: 2, shipped: 1, ready: 2 });
    await operation(f, 'admin_decline_return', r.return_id, 'return_requested', 'delivered', 2, 'return_declined_restore');
    expect((await db().query('select delivered_at from public.order_fulfillments where id=$1', [f.fulfillments[0].id])).rows).toEqual(before);
    expect((await db().query('select count(*)::int n from public.order_fulfillment_events where fulfillment_id=$1', [f.fulfillments[0].id])).rows).toEqual(deliveryCount);
    await refusal(db(), run, 'RETURN_STATE_CONFLICT');
    expect(await stockSnapshot(f)).toEqual(snapshot);
    await operation(f, 'admin_decline_return', r.return_id, 'return_requested', 'delivered', 2, 'return_declined_restore');
  });

  test('店作成→取消は部分数量を戻す。request_key再送・取消CASで履歴を増やさない', async () => {
    const f = await fixture();
    const key = randomUUID();
    const snapshot = await stockSnapshot(f);
    const r = await create(f, 1, key);
    await ranges(f, { return_in_progress: 1, shipped: 2, ready: 2 });
    expect((await operation(f, 'admin_create_return', r.return_id, 'shipped', 'return_in_progress', 1)).request_key).toBe(key);
    expect(await create(f, 1, key)).toEqual({ ...r, replayed: true });
    const run = () => db().query('select * from public.admin_cancel_return($1::uuid,$2::uuid)', [r.return_id, f.actor]);
    expect((await run()).rows).toEqual([{ return_id: r.return_id, status: 'cancelled' }]);
    await ranges(f, { shipped: 3, ready: 2 });
    await operation(f, 'admin_cancel_return', r.return_id, 'return_in_progress', 'shipped', 1);
    await refusal(db(), run, 'RETURN_STATE_CONFLICT');
    expect(await create(f, 1, key)).toEqual({ ...r, status: 'cancelled', replayed: true });
    expect(await stockSnapshot(f)).toEqual(snapshot);
    await operation(f, 'admin_cancel_return', r.return_id, 'return_in_progress', 'shipped', 1);
  });

  test('申請超過/別所有者を拒否し、公開C-2の範囲に内部履歴や操作を足さない', async () => {
    const f = await fixture();
    const r = await request(f, 2);
    await refusal(db(), () => request(f, 2), 'RETURN_QUANTITY_EXCEEDS');
    await refusal(db(), () => request({ ...f, owner: f.actor }), 'ORDER_NOT_FOUND', 'P0002');
    const result = (await db().query('select public.get_customer_order_returns($1::uuid,$2::uuid) as r', [f.orderId, f.owner])).rows[0].r;
    expect(Object.keys(result).sort()).toEqual(['availability', 'cancel_requests', 'returns']);
    expect(result.returns).toHaveLength(1);
    expect(result.returns[0]).toMatchObject({ id: r.return_id, status: 'requested' });
    expect(Object.keys(result.returns[0]).sort()).toEqual(['id', 'number', 'status', 'customer_status',
      'return_method', 'return_shipping_payer', 'return_shipping_fee', 'return_address', 'requested_at', 'closed_at',
      'lines', 'refund_amount', 'sent_back', 'decline_message', 'exchange_shipping'].sort());
    expect(Object.keys(result.returns[0].lines[0]).sort()).toEqual(['item_name', 'color', 'size', 'quantity',
      'requested_resolution', 'requested_exchange', 'resolution', 'exchange'].sort());
    const keys: string[] = [];
    function visit(value: unknown) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { keys.push(key); visit(child); }
    }
    visit(result);
    for (const key of ['shop_note', 'actor_id', 'operation_id', 'request_fingerprint', 'state_events', 'allocation_events']) expect(keys).not.toContain(key);
    await ranges(f, { return_requested: 2, shipped: 1, ready: 2 });
  });

  test('履歴故障は業務・メール・操作を同じSAVEPOINTへ全rollbackする', async () => {
    const f = await fixture();
    const before = await stockSnapshot(f);
    const count = async () => (await db().query(`select
      (select count(*)::int from public.order_returns where order_id=$1::uuid) as returns,
      (select count(*)::int from private.order_email_outbox where order_id=$2::uuid) as emails,
      (select count(*)::int from private.group_g_operations) as operations`, [f.orderId, f.orderId])).rows[0];
    const counts = await count();
    await db().query(`create function pg_temp.fail_g1_return_history() returns trigger language plpgsql as $$
      begin raise exception 'G1_TEST_HISTORY_FAILURE' using errcode='55000'; end $$`);
    await db().query(`create trigger g1_test_return_history before insert on public.order_item_state_events
      for each row execute function pg_temp.fail_g1_return_history()`);
    await refusal(db(), () => request(f), 'G1_TEST_HISTORY_FAILURE', '55000');
    expect(await count()).toEqual(counts);
    expect(await stockSnapshot(f)).toEqual(before);
    await ranges(f, { shipped: 3, ready: 2 });
    await db().query('drop trigger g1_test_return_history on public.order_item_state_events');
  });

  test('公開委譲/private本体の正確なACL・所有者・search_pathと内部coreの非再入を守る', async () => {
    for (const signature of WRITERS) {
      for (const schema of ['public', 'private']) {
        const p = (await db().query(`select p.prosecdef,p.proconfig,p.prosrc,pg_get_userbyid(p.proowner) as owner,
          has_function_privilege('anon',p.oid,'execute') as anon,
          has_function_privilege('authenticated',p.oid,'execute') as authenticated,
          has_function_privilege('service_role',p.oid,'execute') as service
          from pg_proc p where p.oid=$1::regprocedure`, [`${schema}.${signature}`])).rows[0];
        expect(p).toMatchObject({ prosecdef: schema === 'private', owner: 'postgres',
          proconfig: ['search_path=""'], anon: false, authenticated: false, service: true });
        if (schema === 'public') expect(p.prosrc.trim()).toMatch(/^SELECT \* FROM private\./);
        else {
          expect(p.prosrc).toContain('private.lock_group_g_inventory(');
          expect(p.prosrc).not.toMatch(/public\.(?:admin_|customer_request_|begin_order_refund|record_order_refund)/);
        }
      }
    }
    for (const name of ['lock_order_return', 'begin_order_refund_core', 'customer_order_for_request']) {
      const p = (await db().query(`select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='private' and p.proname=$1`, [name])).rows[0];
      expect(p.prosrc).toContain('GROUP_G_INVENTORY_LOCK_REQUIRED');
      expect(p.prosrc).not.toMatch(/FOR UPDATE|lock_group_g_inventory\(/i);
    }
  });
});

describeLocalDb('G-1 return internal cores require the real advisory', getDb => {
  test('operation GUCだけではlock helper/refund coreを実行できない', async () => {
    const db = getDb();
    await db.query('begin');
    try {
      await db.query("select set_config('app.group_g_operation_id',$1,true)", [randomUUID()]);
      await refusal(db, () => db.query('select private.lock_order_return($1::uuid)', [randomUUID()]), 'GROUP_G_INVENTORY_LOCK_REQUIRED', '55000');
      await refusal(db, () => db.query(`select * from private.begin_order_refund_core($1::uuid,'order_cancel',$2::uuid,
        '[]'::jsonb,true,null,null,null,null,'customer_request',false,$3::uuid,null,null,null)`,
      [randomUUID(), randomUUID(), randomUUID()]), 'GROUP_G_INVENTORY_LOCK_REQUIRED', '55000');
    } finally { await db.query('rollback'); }
  });
});
