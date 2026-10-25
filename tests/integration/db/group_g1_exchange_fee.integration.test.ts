/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';
import { createShippedOrderFixture, insertOrderWithLines, insertReturnRecord } from './helpers/order-fixtures';

const ACTIONS = ['payment', 'waiver', 'release'] as const;
type Action = typeof ACTIONS[number];
const operationName = (action: Action) => action === 'release'
  ? 'admin_release_return_exchange' : 'admin_record_return_fee_payment';

async function act(db: PgClient, action: Action, returnId: string, actor: string) {
  return db.query(action === 'release'
    ? 'select * from public.admin_release_return_exchange($1::uuid,$2::uuid)'
    : 'select * from public.admin_record_return_fee_payment($1::uuid,$2::uuid,$3::text,$4::boolean)',
  action === 'release' ? [returnId, actor] : [returnId, actor, '  fee decision  ', action === 'waiver']);
}

async function refusal(db: PgClient, run: () => Promise<unknown>, message: string, code = '22023') {
  await db.query('savepoint fee_refusal');
  try { await expect(run()).rejects.toMatchObject({ message, code }); }
  finally {
    await db.query('rollback to savepoint fee_refusal');
    await db.query('release savepoint fee_refusal');
  }
}

describeLocalDb('G-1 exchange fee payment, waiver and shipping hold release', getDb => {
  const db = () => getDb();
  const cleanup: Array<{ returnId: string; exceptionId?: string }> = [];
  // Preparation commits its synthetic material and releases its advisory. Every tested public entry
  // starts in a new transaction; the shared fixtures cannot accidentally supply its inventory lock.
  async function fixture(hold = false) {
    return withGroupG1FixtureTransaction(db(), async () => {
      const f = await createShippedOrderFixture(db(), { createdAt: '2026-01-02T00:00:00Z',
        lines: [{ quantity: 1, extraStock: 2 }] });
      // The synthetic shipped-order helper predates paid_at; seed its first value while preparing material.
      await db().query('update public.orders set paid_at=now() where id=$1 and paid_at is null', [f.orderId]);
      const actor = (await db().query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
        values(gen_random_uuid(),$1,'{}',now(),now()) returning id`, [`g1-fee-${randomUUID()}@example.com`])).rows[0].id as string;
      const ret = await insertReturnRecord(db(), { orderId: f.orderId, exchangeFee: 500, lines: [{
        fulfillmentId: f.fulfillments[0].id, orderItemId: f.orderItemIds[0], quantity: 1,
        resolution: 'exchange', exchangeVariantId: f.variantIds[0], exchangeMethod: 'stock',
      }] });
      const receipt = (await db().query(`select * from public.admin_receive_return($1::uuid,$2::uuid,true,$3::uuid,
        $4::jsonb,'[]'::jsonb,'consult',null,0,null,false,null,null,null)`, [ret.returnId, actor, randomUUID(),
      JSON.stringify([{ return_line_id: ret.lineIds[0], quantity: 1, disposition: 'not_restocked' }])])).rows[0];
      expect(receipt.fee_due_amount).toBe(500);
      expect(receipt.exchange_order_item_ids).toHaveLength(1);
      const exchangeId = receipt.exchange_order_item_ids[0] as string;
      const waiting = async (createdAt: string) => insertOrderWithLines(db(), { status: 'paid', createdAt,
        lines: [{ itemId: f.itemIds[0], variantId: f.variantIds[0], quantity: 1, fulfillmentType: 'backorder', reserved: false }] });
      const older = await waiting('2026-01-01T00:00:00Z');
      const newer = await waiting('2026-01-03T00:00:00Z');
      let exceptionId: string | undefined;
      if (hold) {
        exceptionId = (await db().query(`select exception_id from public.record_payment_exception(
          $1::text,'paid_amount_mismatch',null,null,null,null,$2::uuid)`, [`pi_${randomUUID()}`, f.orderId])).rows[0].exception_id as string;
      }
      cleanup.push({ returnId: ret.returnId, exceptionId });
      return { ...f, ...ret, actor, exchangeId, older, newer, exceptionId };
    });
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  async function snapshot(f: Fx) {
    return (await db().query(`select
      (select stock_quantity from public.item_variants where id=$1::bigint) as free,
      (select count(*)::int from public.stock_movements where variant_id=$2::bigint) as movements,
      (select count(*)::int from private.group_g_operations where cause_id=$3::text) as operations,
      (select count(*)::int from public.order_item_state_events where order_item_id=any($4::uuid[])) as states,
      (select count(*)::int from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
        where a.order_item_id=any($5::uuid[])) as allocations,
      (select paid_at from public.orders where id=$6::uuid) as paid_at,
      (select to_jsonb(r) from public.order_returns r where id=$7::uuid) as return_row`,
    [f.variantIds[0], f.variantIds[0], f.returnId, [f.exchangeId, ...f.older.orderItemIds, ...f.newer.orderItemIds],
      [f.exchangeId, ...f.older.orderItemIds, ...f.newer.orderItemIds], f.orderId, f.returnId])).rows[0];
  }
  async function quantities(f: Fx) {
    return (await db().query(`select oi.id,coalesce(sum(a.remaining_quantity),0)::int n from public.order_items oi
      left join public.order_item_allocations a on a.order_item_id=oi.id where oi.id=any($1::uuid[])
      group by oi.id order by oi.id`, [[f.exchangeId, ...f.older.orderItemIds, ...f.newer.orderItemIds]])).rows;
  }
  async function reasons(f: Fx) {
    return (await db().query(`select blocked_reasons from private.group_g_item_state_ranges($1::uuid[])
      where order_item_id=$2::uuid`, [[f.orderId], f.exchangeId])).rows[0].blocked_reasons as string[];
  }
  async function noAdvisory() {
    expect((await db().query(`select exists(select 1 from pg_catalog.pg_locks where pid=pg_backend_pid()
      and locktype='advisory' and classid=190521 and objid=1 and objsubid=2 and granted) as held`)).rows).toEqual([{ held: false }]);
  }
  afterEach(async () => {
    await db().query('rollback');
    await withGroupG1FixtureTransaction(db(), async () => {
      for (const f of cleanup.splice(0)) {
        if (f.exceptionId) await db().query('select public.resolve_payment_exception_by_system($1::uuid,$2::text)',
          [f.exceptionId, 'fixture cleanup']);
        await db().query(`update public.order_returns set status='cancelled',cancelled_at=now()
          where id=$1 and status='open'`, [f.returnId]);
      }
    });
  });

  test.each(ACTIONS)('%s public entry takes its own advisory and rejoins FIFO at the original order date', async action => {
    const f = await fixture();
    await db().query('begin');
    await noAdvisory();
    expect(await reasons(f)).toEqual(['exchange_fee_waiting']);
    expect((await quantities(f)).map(row => row.n)).toEqual([0, 0, 0]);
    const before = await snapshot(f);
    expect(before.free).toBe(2);
    const sentinel = randomUUID();
    await db().query("select set_config('app.group_g_operation_id',$1,true)", [sentinel]);
    await db().query('set local role service_role');
    const result = await act(db(), action, f.returnId, f.actor);
    await db().query('reset role');
    expect(result.rows).toEqual([{ return_id: f.returnId, return_status: action === 'release' ? 'open' : 'closed' }]);
    expect((await db().query("select current_setting('app.group_g_operation_id') id")).rows[0].id).toBe(sentinel);
    expect(await quantities(f)).toEqual([
      { id: f.older.orderItemIds[0], n: 1 }, { id: f.exchangeId, n: 1 }, { id: f.newer.orderItemIds[0], n: 0 },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await reasons(f)).toEqual([]);
    const after = await snapshot(f);
    expect(after.free).toBe(0); expect(after.paid_at).not.toBeNull(); expect(after.paid_at).toEqual(before.paid_at);
    expect(after.operations).toBe(before.operations + 1);
    const op = (await db().query(`select id,request_key,actor_id,cause_type,cause_id from private.group_g_operations
      where operation=$1::text and cause_id=$2::text`, [operationName(action), f.returnId])).rows;
    expect(op).toHaveLength(1);
    const key = (await db().query('select md5($1::text)::uuid id', [`${operationName(action)}:${f.returnId}`])).rows[0].id;
    expect(op[0]).toMatchObject({ request_key: key, actor_id: f.actor, cause_type: 'order_return', cause_id: f.returnId });
    expect((await db().query(`select from_status,to_status,sequence,reason,actor_id from public.order_item_state_events
      where operation_id=$1::uuid and order_item_id=$2::uuid order by sequence`, [op[0].id, f.exchangeId])).rows).toEqual([
      { from_status: 'in_production', to_status: 'ready', sequence: 2, reason: 'fifo', actor_id: f.actor },
    ]);
    expect(after.return_row).toMatchObject(action === 'release'
      ? { fee_due_amount: 500, fee_received_at: null, fee_settled_amount: 0, exchange_released_by: f.actor }
      : { fee_due_amount: 0, fee_settled_amount: 500, fee_waived: action === 'waiver', fee_received_by: f.actor,
        fee_received_note: 'fee decision', exchange_released_at: null });
    // Legacy no-key RPCs reject repeats. A repeat must not add an operation, event or movement.
    await refusal(db(), () => act(db(), action, f.returnId, f.actor), 'RETURN_STATE_CONFLICT');
    if (action !== 'release') await refusal(db(), () => act(db(), action === 'payment' ? 'waiver' : 'payment', f.returnId, f.actor), 'RETURN_STATE_CONFLICT');
    expect(await snapshot(f)).toEqual(after);
    expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [f.variantIds[0]])).rows).toEqual([]);
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
  });

  test.each(ACTIONS)('%s leaves another active payment-review hold intact and allocates zero to the exchange', async action => {
    const f = await fixture(true);
    await db().query('begin'); await noAdvisory();
    expect(await reasons(f)).toEqual(['payment_review', 'exchange_fee_waiting']);
    const before = await snapshot(f);
    await act(db(), action, f.returnId, f.actor);
    expect(await reasons(f)).toEqual(['payment_review']);
    expect(await quantities(f)).toEqual([
      { id: f.older.orderItemIds[0], n: 1 }, { id: f.exchangeId, n: 0 }, { id: f.newer.orderItemIds[0], n: 1 },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await db().query('select resolved_at from public.payment_exceptions where id=$1', [f.exceptionId])).rows).toEqual([{ resolved_at: null }]);
    expect((await snapshot(f)).paid_at).toEqual(before.paid_at);
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
  });

  test('payment after approval to ship settles the fee without allocating the same exchange twice', async () => {
    const f = await fixture();
    await db().query('begin'); await noAdvisory();
    await act(db(), 'release', f.returnId, f.actor);
    const before = await snapshot(f);
    await act(db(), 'payment', f.returnId, f.actor);
    const after = await snapshot(f);
    expect(after).toMatchObject({ free: before.free, movements: before.movements, allocations: before.allocations,
      paid_at: before.paid_at, operations: before.operations + 1 });
    expect(after.return_row).toMatchObject({ status: 'closed', fee_due_amount: 0, fee_settled_amount: 500,
      exchange_released_by: f.actor, fee_received_by: f.actor });
    await refusal(db(), () => act(db(), 'release', f.returnId, f.actor), 'RETURN_STATE_CONFLICT');
    expect(await snapshot(f)).toEqual(after);
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
  });

  test.each(['payment', 'waiver'] as const)('a new fee debt after %s can be paid on the same return, with two operations and zero replay delta', async firstAction => {
    const f = await withGroupG1FixtureTransaction(db(), async () => {
      const shipped = await createShippedOrderFixture(db(), { lines: [{ quantity: 2 }] });
      await db().query('update public.orders set paid_at=now() where id=$1 and paid_at is null', [shipped.orderId]);
      const actor = (await db().query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
        values(gen_random_uuid(),$1,'{}',now(),now()) returning id`, [`g1-fee-cycle-${randomUUID()}@example.com`])).rows[0].id as string;
      const ret = await insertReturnRecord(db(), { orderId: shipped.orderId, returnMethod: 'shop_label',
        returnShippingPayer: 'customer', returnShippingFee: 6000, exchangeFee: 600, lines: [{
          fulfillmentId: shipped.fulfillments[0].id, orderItemId: shipped.orderItemIds[0], quantity: 2, reason: 'unknown',
          resolution: 'exchange', exchangeVariantId: shipped.variantIds[0], exchangeMethod: 'stock',
        }] });
      const first = (await db().query(`select refund_status,fee_due_amount from public.admin_receive_return(
        $1::uuid,$2::uuid,true,$3::uuid,$4::jsonb,$5::jsonb,'now',null,0,null,false,null,null,null)`,
      [ret.returnId, actor, randomUUID(), JSON.stringify([{ return_line_id: ret.lineIds[0], quantity: 1, disposition: 'not_restocked' }]),
        JSON.stringify([{ return_line_id: ret.lineIds[0], action: 'refund' }])])).rows[0];
      expect(first).toEqual({ refund_status: 'waived', fee_due_amount: 1000 });
      cleanup.push({ returnId: ret.returnId });
      return { ...shipped, ...ret, actor };
    });
    await db().query('begin'); await noAdvisory();
    const paidAt = (await db().query('select paid_at from public.orders where id=$1', [f.orderId])).rows[0].paid_at;
    expect((await act(db(), firstAction, f.returnId, f.actor)).rows).toEqual([{ return_id: f.returnId, return_status: 'open' }]);
    const second = (await db().query(`select fee_due_amount from public.admin_receive_return(
      $1::uuid,$2::uuid,true,$3::uuid,$4::jsonb,$5::jsonb,'consult',null,0,null,false,null,null,null)`,
    [f.returnId, f.actor, randomUUID(), JSON.stringify([{ return_line_id: f.lineIds[0], quantity: 1, disposition: 'not_restocked' }]),
      JSON.stringify([{ return_line_id: f.lineIds[0], action: 'make' }])])).rows[0];
    expect(second).toEqual({ fee_due_amount: 600 });
    expect((await act(db(), 'payment', f.returnId, f.actor)).rows).toEqual([{ return_id: f.returnId, return_status: 'closed' }]);
    expect((await db().query(`select fee_due_amount,fee_settled_amount,fee_waived from public.order_returns where id=$1`,
      [f.returnId])).rows).toEqual([{ fee_due_amount: 0, fee_settled_amount: 1600, fee_waived: false }]);
    const operations = async () => (await db().query(`select id,request_key from private.group_g_operations
      where operation='admin_record_return_fee_payment' and cause_id=$1::text order by id`, [f.returnId])).rows;
    const snapshotPayment = async () => (await db().query(`select
      (select count(*)::int from public.order_item_state_events e join public.order_items oi on oi.id=e.order_item_id
        where oi.order_id=$1::uuid) states,
      (select count(*)::int from public.stock_movements where variant_id=$2::bigint) movements,
      (select stock_quantity from public.item_variants where id=$3::bigint) free,
      (select count(*)::int from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
        join public.order_items oi on oi.id=a.order_item_id where oi.order_id=$4::uuid) allocations,
      (select fee_settled_amount from public.order_returns where id=$5::uuid) settled`,
    [f.orderId, f.variantIds[0], f.variantIds[0], f.orderId, f.returnId])).rows[0];
    const before = await operations(); expect(before).toHaveLength(2);
    const base = `admin_record_return_fee_payment:${f.returnId}`;
    const keys = (await db().query('select md5($1::text)::uuid first_key,md5($2::text)::uuid second_key', [base, `${base}:1000`])).rows[0];
    expect(before.map(row => row.request_key as string).sort()).toEqual([keys.first_key, keys.second_key].sort());
    const quantitiesBeforeReplay = await snapshotPayment();
    // These are exactly the first call's four arguments. The legacy RPC has no individual payment identity;
    // preserve its refusal contract while checking that a late repeat cannot mutate a settled return.
    await refusal(db(), () => act(db(), firstAction, f.returnId, f.actor), 'RETURN_STATE_CONFLICT');
    expect(await operations()).toEqual(before);
    expect(await snapshotPayment()).toEqual(quantitiesBeforeReplay);
    expect((await db().query('select paid_at from public.orders where id=$1', [f.orderId])).rows[0].paid_at).toEqual(paidAt);
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
  });

  test.each(ACTIONS)('%s rolls back fee, FIFO, state history and operation when history fails', async action => {
    const f = await fixture();
    await db().query('begin'); await noAdvisory();
    await db().query(`create function pg_temp.reject_fee_state() returns trigger language plpgsql as $$
      begin raise exception 'G1_FEE_HISTORY_FAILURE' using errcode='55000'; end $$`);
    await db().query(`create trigger g1_fee_state_failure before insert on public.order_item_state_events
      for each row when (new.sequence=2) execute function pg_temp.reject_fee_state()`);
    const before = await snapshot(f);
    await refusal(db(), () => act(db(), action, f.returnId, f.actor), 'G1_FEE_HISTORY_FAILURE', '55000');
    expect(await snapshot(f)).toEqual(before);
    await noAdvisory();
  });

  test.each(['admin_record_return_fee_payment(uuid,uuid,text,boolean)', 'admin_release_return_exchange(uuid,uuid)'])(
    '%s preserves public/private ACL, ownership and the lock boundary', async signature => {
      await db().query('begin'); await noAdvisory();
      for (const schema of ['public', 'private']) {
        const r = (await db().query(`select p.prosecdef,p.prosrc,p.proargnames,pg_get_function_arguments(p.oid) args,
          pg_get_function_result(p.oid) result,pg_get_userbyid(p.proowner) owner,p.proconfig,
          has_function_privilege('anon',p.oid,'EXECUTE') anon,
          has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
          has_function_privilege('service_role',p.oid,'EXECUTE') service_role
          from pg_proc p where p.oid=to_regprocedure($1::text)`, [`${schema}.${signature}`])).rows;
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ prosecdef: schema === 'private', owner: 'postgres', proconfig: ['search_path=""'],
          anon: false, authenticated: false, service_role: true, result: 'TABLE(return_id uuid, return_status text)' });
        expect(r[0].args).toBe(signature.startsWith('admin_record')
          ? '_return_id uuid, _actor_id uuid, _note text, _waive boolean' : '_return_id uuid, _actor_id uuid');
        if (schema === 'public') {
          expect(r[0].prosrc.trim()).toBe(signature.startsWith('admin_record')
            ? 'SELECT * FROM private.admin_record_return_fee_payment(_return_id, _actor_id, _note, _waive);'
            : 'SELECT * FROM private.admin_release_return_exchange(_return_id, _actor_id);');
        } else {
          const body = r[0].prosrc as string;
          expect(body.match(/private\.lock_group_g_inventory\(/g)).toHaveLength(1);
          expect(body.indexOf('private.lock_group_g_inventory(')).toBeLessThan(body.indexOf('private.lock_order_return('));
          const refreshed = body.indexOf('INTO v_variants', body.indexOf('private.lock_group_g_inventory('));
          expect(refreshed).toBeGreaterThan(body.indexOf('private.lock_group_g_inventory('));
          expect(body.indexOf('private.allocate_group_g_fifo(')).toBeGreaterThan(refreshed);
          expect(body).not.toMatch(/\bFOR\s+(?:UPDATE|SHARE|KEY\s+SHARE)|pg_advisory_xact_lock|(?:PERFORM|FROM)\s+public\.\w+\s*\(/i);
        }
      }
    });
});
