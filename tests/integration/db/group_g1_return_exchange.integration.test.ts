/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createShippedOrderFixture, insertOrderWithLines, insertReturnRecord, variantStock } from './helpers/order-fixtures';

const WRITERS = [
  'admin_close_return_missing(uuid,uuid,uuid)', 'admin_reopen_return(uuid,uuid,uuid)',
  'admin_inspect_return(uuid,uuid,uuid,jsonb)',
  'admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)',
  'admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)',
];
type Fx = Awaited<ReturnType<typeof createShippedOrderFixture>> & {
  returnId: string; lineId: string; actor: string; quantity: number;
};

async function refusal(db: PgClient, run: () => Promise<unknown>, message: string, code = '22023') {
  await db.query('savepoint expected_refusal');
  try { await expect(run()).rejects.toMatchObject({ message, code }); }
  finally {
    await db.query('rollback to savepoint expected_refusal');
    await db.query('release savepoint expected_refusal');
  }
}

describeLocalDb('G-1 return receipt, inspection, amount decision and exchange FIFO', getDb => {
  const db = () => getDb();
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await db().query('update public.shop_return_settings set inspection_enabled=true where id=1');
    await db().query("update public.shop_return_reason_settings set out_of_stock_exchange='make' where reason='defective'");
  });
  afterEach(async () => { await db().query('rollback'); });

  async function fixture(options: { quantity?: number; method?: 'stock' | 'make'; stock?: number; fee?: number } = {}): Promise<Fx> {
    const quantity = options.quantity ?? 1;
    const f = await createShippedOrderFixture(db(), { createdAt: '2026-01-02T00:00:00Z',
      lines: [{ quantity, extraStock: options.stock ?? 0 }] });
    const actor = (await db().query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
      values(gen_random_uuid(),$1,'{}',now(),now()) returning id`, [`g1-receive-${randomUUID()}@example.com`])).rows[0].id as string;
    const r = await insertReturnRecord(db(), { orderId: f.orderId, exchangeFee: options.fee ?? 0,
      lines: [{ fulfillmentId: f.fulfillments[0].id, orderItemId: f.orderItemIds[0], quantity,
        resolution: options.method ? 'exchange' : 'refund', exchangeVariantId: options.method ? f.variantIds[0] : undefined,
        exchangeMethod: options.method }] });
    return { ...f, actor, returnId: r.returnId, lineId: r.lineIds[0], quantity };
  }
  async function receive(f: Fx, options: {
    key?: string; units?: { disposition: string; quantity: number }[]; choice?: string; canRefund?: boolean;
  } = {}) {
    return (await db().query(`select * from public.admin_receive_return($1::uuid,$2::uuid,$3::boolean,$4::uuid,
      $5::jsonb,'[]'::jsonb,$6::text,null,0,null,true,$7::text,null,null)`, [f.returnId, f.actor,
    options.canRefund ?? true, options.key ?? randomUUID(), JSON.stringify((options.units ?? [{ disposition: 'restocked', quantity: f.quantity }])
      .map(u => ({ return_line_id: f.lineId, ...u }))), options.choice ?? 'consult', 'fixture sent back'])).rows[0];
  }
  async function inspect(f: Fx, restocked: number, notRestocked: number, key = randomUUID()) {
    return (await db().query('select * from public.admin_inspect_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
      [f.returnId, f.actor, key, JSON.stringify([{ return_line_id: f.lineId, restocked, not_restocked: notRestocked }])])).rows[0];
  }
  async function amount(f: Fx, value: number | null, key = randomUUID()) {
    return (await db().query('select * from public.admin_refund_return($1::uuid,$2::uuid,$3::uuid,$4::integer,0,null,false)',
      [f.returnId, f.actor, key, value])).rows[0];
  }
  async function states(f: Fx, expected: Record<string, number>) {
    const rows = (await db().query(`select status,unit_from,unit_to from private.group_g_item_state_ranges($1::uuid[])
      where order_item_id=$2::uuid order by unit_from`, [[f.orderId], f.orderItemIds[0]])).rows;
    let end = 0;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      expect(row.unit_from).toBe(end); expect(row.unit_to).toBeGreaterThan(end);
      end = row.unit_to; counts[row.status] = (counts[row.status] ?? 0) + row.unit_to - row.unit_from;
    }
    expect(end).toBe(f.quantity); expect(counts).toEqual(expected);
  }
  async function snapshot(f: Fx) {
    return (await db().query(`select
      (select stock_quantity from public.item_variants where id=$1::bigint) as free,
      (select count(*)::int from public.stock_movements where variant_id=$2::bigint) as movements,
      (select count(*)::int from public.order_items where order_id=$3::uuid) as items,
      (select count(*)::int from private.group_g_operations where cause_id=$4::text) as operations,
      (select count(*)::int from public.order_item_state_events e join public.order_items oi on oi.id=e.order_item_id
        where oi.order_id=$5::uuid) as states,
      (select count(*)::int from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
        join public.order_items oi on oi.id=a.order_item_id where oi.order_id=$6::uuid) as allocations,
      (select paid_at from public.orders where id=$7::uuid) as paid_at`,
    [f.variantIds[0], f.variantIds[0], f.orderId, f.returnId, f.orderId, f.orderId, f.orderId])).rows[0];
  }
  async function operation(f: Fx, name: string, key: string) {
    const rows = (await db().query(`select id,actor_id,cause_type,cause_id from private.group_g_operations
      where operation=$1 and request_key=$2::uuid`, [name, key])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: f.actor, cause_type: 'order_return', cause_id: f.returnId });
    return rows[0].id as string;
  }
  async function transition(f: Fx, op: string, from: string, to: string, quantity: number, reason: string) {
    expect((await db().query(`select from_status,to_status,sum(unit_to-unit_from)::int quantity,sequence,reason,actor_id
      from public.order_item_state_events where operation_id=$1 and order_item_id=$2
      group by from_status,to_status,sequence,reason,actor_id`, [op, f.orderItemIds[0]])).rows).toEqual([
      { from_status: from, to_status: to, quantity, sequence: 1, reason, actor_id: f.actor },
    ]);
  }
  async function waiting(f: Fx, createdAt: string) {
    return insertOrderWithLines(db(), { status: 'paid', createdAt, lines: [{ itemId: f.itemIds[0],
      variantId: f.variantIds[0], quantity: 1, fulfillmentType: 'backorder', reserved: false }] });
  }

  test.each(['stock', 'make'] as const)('%s交換は元注文日でFIFOへ入り、古い別注文を優先し、受取再送は増分0', async method => {
    const f = await fixture({ method, stock: 1 });
    const older = await waiting(f, '2026-01-01T00:00:00Z');
    const newer = await waiting(f, '2026-01-03T00:00:00Z');
    const paidAt = (await snapshot(f)).paid_at;
    const key = randomUUID();
    const r = await receive(f, { key, choice: 'none' });
    expect(r.exchange_order_item_ids).toHaveLength(1);
    const item = r.exchange_order_item_ids[0] as string;
    expect((await db().query('select private.return_exchange_item_id($1::uuid,$2::uuid,$3::text) id',
      [r.receipt_id, f.lineId, method])).rows[0].id).toBe(item);
    expect((await db().query(`select order_item_id,sum(remaining_quantity)::int n from public.order_item_allocations
      where order_item_id=any($1::uuid[]) and remaining_quantity>0 group by order_item_id order by order_item_id`,
    [[older.orderItemIds[0], item, newer.orderItemIds[0]]])).rows).toEqual([
      { order_item_id: older.orderItemIds[0], n: 1 }, { order_item_id: item, n: 1 },
    ].sort((a, b) => a.order_item_id.localeCompare(b.order_item_id)));
    expect(await variantStock(db(), f.variantIds[0])).toBe(0);
    expect((await db().query("select count(*)::int n from public.stock_movements where return_id=$1 and reason='return' and delta=1",
      [f.returnId])).rows[0].n).toBe(1);
    const op = await operation(f, 'admin_receive_return', key);
    const events = (await db().query(`select to_status,sequence,reason,actor_id from public.order_item_state_events
      where operation_id=$1 and order_item_id=$2 order by sequence`, [op, item])).rows;
    expect(events).toEqual([
      { to_status: 'in_production', sequence: 1, reason: 'admin_receive_return', actor_id: f.actor },
      { to_status: 'ready', sequence: 2, reason: 'fifo', actor_id: f.actor },
    ]);
    const before = await snapshot(f);
    expect(before.paid_at).toEqual(paidAt);
    expect(await receive(f, { key, choice: 'none' })).toEqual({ ...r, replayed: true });
    expect(await snapshot(f)).toEqual(before);
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
  });

  test('手数料待ちの交換はFを確保せず、次の注文へ通常割当する', async () => {
    const f = await fixture({ method: 'make', stock: 1, fee: 500 });
    const next = await waiting(f, '2026-01-03T00:00:00Z');
    const r = await receive(f, { choice: 'none', units: [{ disposition: 'not_restocked', quantity: 1 }] });
    expect(r.fee_due_amount).toBe(500);
    expect((await db().query('select count(*)::int n from public.order_item_allocations where order_item_id=$1',
      [r.exchange_order_item_ids[0]])).rows[0].n).toBe(0);
    expect((await db().query('select sum(remaining_quantity)::int n from public.order_item_allocations where order_item_id=$1',
      [next.orderItemIds[0]])).rows[0].n).toBe(1);
    expect((await db().query('select blocked_reasons from private.group_g_item_state_ranges($1::uuid[]) where order_item_id=$2',
      [[f.orderId], r.exchange_order_item_ids[0]])).rows[0].blocked_reasons).toContain('exchange_fee_waiting');
  });

  test('部分受取・検品・相談・未着/再開・お返しの数量和とpaid_atを保ち、検品再送で戻さない', async () => {
    const f = await fixture({ quantity: 5 });
    const paidAt = (await snapshot(f)).paid_at;
    const r = await receive(f, { choice: 'consult', units: [
      { disposition: 'pending_inspection', quantity: 1 }, { disposition: 'not_restocked', quantity: 1 },
      { disposition: 'sent_back', quantity: 1 },
    ] });
    await states(f, { return_in_progress: 3, refund_waiting: 1, returned: 1 });
    expect(await variantStock(db(), f.variantIds[0])).toBe(0);
    const key = randomUUID();
    const result = await inspect(f, 1, 0, key);
    expect(await variantStock(db(), f.variantIds[0])).toBe(1);
    await states(f, { return_in_progress: 2, refund_waiting: 2, returned: 1 });
    await transition(f, await operation(f, 'admin_inspect_return', key), 'return_in_progress', 'refund_waiting', 1, 'admin_inspect_return');
    const before = await snapshot(f);
    expect(await inspect(f, 1, 0, key)).toEqual({ ...result, replayed: true });
    expect(await snapshot(f)).toEqual(before);
    const closeKey = randomUUID();
    const close = () => db().query('select * from public.admin_close_return_missing($1,$2,$3)', [f.returnId, f.actor, closeKey]);
    const closed = (await close()).rows[0];
    const closeOp = await operation(f, 'admin_close_return_missing', closeKey);
    // The canonical ranges place returned units first, then refund waiting, then work in progress.
    expect((await db().query(`select from_status,to_status,sum(unit_to-unit_from)::int quantity,sequence,reason,actor_id
      from public.order_item_state_events where operation_id=$1 and order_item_id=$2
      group by from_status,to_status,sequence,reason,actor_id order by from_status`, [closeOp, f.orderItemIds[0]])).rows).toEqual([
      { from_status: 'refund_waiting', to_status: 'returned', quantity: 2, sequence: 1, reason: 'admin_close_return_missing', actor_id: f.actor },
      { from_status: 'return_in_progress', to_status: 'refund_waiting', quantity: 2, sequence: 1, reason: 'admin_close_return_missing', actor_id: f.actor },
    ]);
    const afterClose = await snapshot(f);
    expect((await close()).rows[0]).toEqual({ ...closed, replayed: true });
    expect(await snapshot(f)).toEqual(afterClose);
    await states(f, { returned: 3, refund_waiting: 2 });
    expect((await db().query('select missing,sent_back,pending_inspection from private.order_return_line_progress($1)',
      [f.returnId])).rows).toEqual([{ missing: 2, sent_back: 1, pending_inspection: 0 }]);
    // Finish consultation without moving money, allowing the missing units to reopen.
    const waiveKey = randomUUID();
    expect(await amount(f, 0, waiveKey)).toMatchObject({ amount: 0, status: 'waived', replayed: false });
    await transition(f, await operation(f, 'admin_refund_return', waiveKey), 'refund_waiting', 'returned', 2, 'admin_refund_return');
    await states(f, { returned: 5 });
    const reopenKey = randomUUID();
    const reopen = () => db().query('select * from public.admin_reopen_return($1,$2,$3)', [f.returnId, f.actor, reopenKey]);
    const opened = (await reopen()).rows[0];
    await transition(f, await operation(f, 'admin_reopen_return', reopenKey), 'returned', 'return_in_progress', 2, 'admin_reopen_return');
    await states(f, { return_in_progress: 2, returned: 3 });
    const after = await snapshot(f);
    expect((await reopen()).rows[0]).toEqual({ ...opened, replayed: true });
    expect(await snapshot(f)).toEqual(after); expect(after.paid_at).toEqual(paidAt);
    expect(r.return_status).toBe('open');
    await refusal(db(), () => inspect(f, 1, 0), 'RETURN_RECEIPT_EXCEEDS');
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
  });

  test('相談→金額決定→pending→failed→不要は返品在庫を再度戻さず、再送は履歴を増やさない', async () => {
    const f = await fixture();
    const paidAt = (await snapshot(f)).paid_at;
    await receive(f);
    await states(f, { refund_waiting: 1 });
    const key = randomUUID();
    const r = await amount(f, null, key);
    await transition(f, await operation(f, 'admin_refund_return', key), 'refund_waiting', 'return_in_progress', 1, 'admin_refund_return');
    const before = await snapshot(f);
    expect(await amount(f, null, key)).toEqual({ ...r, replayed: true }); expect(await snapshot(f)).toEqual(before);
    for (const status of ['pending', 'failed']) {
      await db().query(`select * from public.record_order_refund_result($1::uuid,$2::text,$3::text,null,
        $4::text,null,'card',null,null)`, [r.refund_id, `re_${String(r.refund_id).replaceAll('-', '')}`, status,
      status === 'failed' ? 'lost_or_stolen_card' : null]);
      await states(f, { return_in_progress: 1 });
      expect(await variantStock(db(), f.variantIds[0])).toBe(1);
    }
    const waiveKey = randomUUID();
    const waived = await amount(f, 0, waiveKey);
    await states(f, { returned: 1 });
    const after = await snapshot(f);
    expect(await amount(f, 0, waiveKey)).toEqual({ ...waived, replayed: true }); expect(await snapshot(f)).toEqual(after);
    expect(after.paid_at).toEqual(paidAt); expect(after.free).toBe(1);
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
  });

  test('検品で戻さない決定は在庫を増やさず、受取の障害は在庫・交換明細・履歴・operationを全rollback', async () => {
    const f = await fixture({ method: 'make' });
    const first = await receive(f, { choice: 'none', units: [{ disposition: 'pending_inspection', quantity: 1 }] });
    expect(first.exchange_order_item_ids).toHaveLength(1);
    await inspect(f, 0, 1);
    expect(await variantStock(db(), f.variantIds[0])).toBe(0);
    const other = await fixture({ method: 'make' });
    const before = await snapshot(other);
    await db().query(`create function pg_temp.reject_return_state() returns trigger language plpgsql as
      'begin raise exception ''G1_RETURN_TEST_FAILURE'' using errcode=''55000''; end'`);
    await db().query(`create trigger g1_return_test_failure before insert on public.order_item_state_events
      for each row execute function pg_temp.reject_return_state()`);
    await refusal(db(), () => receive(other, { choice: 'none' }), 'G1_RETURN_TEST_FAILURE', '55000');
    expect(await snapshot(other)).toEqual(before);
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=$1', [other.returnId])).rows[0].n).toBe(0);
  });

  test.each(WRITERS)('%s re-reads variants under the common lock before using free stock or FIFO', async signature => {
    const body = (await db().query('select prosrc from pg_proc where oid=$1::regprocedure', [`private.${signature}`])).rows[0].prosrc as string;
    const lock = body.indexOf('private.lock_group_g_inventory(');
    const refreshed = body.indexOf('INTO v_variants', lock);
    expect(lock).toBeGreaterThan(-1); expect(refreshed).toBeGreaterThan(lock);
    expect(body.slice(refreshed)).toContain('l.exchange_variant_id');
    expect(body.slice(refreshed)).toContain('l.requested_exchange_variant_id');
    for (const consumer of ['INTO v_free_by_variant', 'private.allocate_group_g_fifo(']) {
      const use = body.indexOf(consumer, lock);
      if (use !== -1) expect(use).toBeGreaterThan(refreshed);
    }
    if (/admin_(close_return_missing|reopen_return)\(/.test(signature)) expect(body).not.toContain('v_middle');
  });

  test('公開は委譲のみ、private本体だけが閉包を取得、refresh/coreは取得済み専用でservice_roleから不可', async () => {
    for (const signature of WRITERS) {
      for (const [schema, definer] of [['public', false], ['private', true]] as const) {
        const p = (await db().query(`select p.oid,p.prosrc,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner
          from pg_proc p where p.oid=$1::regprocedure`, [`${schema}.${signature}`])).rows[0];
        expect(p.prosecdef).toBe(definer); expect(p.owner).toBe('postgres'); expect(p.proconfig.join(' ')).toContain('search_path=');
        for (const role of ['anon', 'authenticated', 'service_role']) expect((await db().query(
          "select has_function_privilege($1,$2::oid,'EXECUTE') allowed", [role, p.oid])).rows[0].allowed).toBe(role === 'service_role');
        if (schema === 'public') {
          expect(p.prosrc).toContain(`private.${signature.split('(')[0]}`);
          expect(p.prosrc).not.toMatch(/\b(insert|update|delete|perform)\b/i);
        } else {
          expect(p.prosrc.match(/private\.lock_group_g_inventory\(/g)).toHaveLength(1);
          expect(p.prosrc).not.toMatch(/\bFOR\s+(UPDATE|KEY SHARE)\b/i);
          expect(p.prosrc).not.toMatch(/(?:from|perform)\s+public\.[a-z_]+\(/i);
        }
      }
    }
    const p = (await db().query(`select oid,prosrc,prosecdef from pg_proc where oid='private.refresh_order_return_status(uuid)'::regprocedure`)).rows[0];
    expect(p.prosecdef).toBe(false);
    expect(p.prosrc).not.toMatch(/lock_group_g_inventory|pg_advisory_xact_lock|FOR\s+UPDATE/i);
    for (const role of ['anon', 'authenticated', 'service_role']) expect((await db().query(
      "select has_function_privilege($1,$2::oid,'EXECUTE') allowed", [role, p.oid])).rows[0].allowed).toBe(false);
    await db().query('rollback'); await db().query('begin');
    await db().query("select set_config('app.group_g_operation_id',$1,true)", [randomUUID()]);
    await refusal(db(), () => db().query('select private.refresh_order_return_status($1::uuid)', [randomUUID()]),
      'GROUP_G_INVENTORY_LOCK_REQUIRED', '55000');
  });
});

// Task 11 M4: the receipt rollback above runs inside a SAVEPOINT. Here the failing receipt runs in its own top-level
// transaction on a second connection (no savepoint) and is rolled back as a whole; this connection then reads the
// committed state and finds nothing of it: no receipt, stock, ledger, exchange line, history, operation or trigger.
describeLocalDb('G-1 return receipt failure without a savepoint (separate connection)', getDb => {
  const db = () => getDb();
  jest.setTimeout(30000);

  test('受取の障害は取引ごと戻り、別の接続から見て何も残らない', async () => {
    // Committed material (another connection must be able to read it): a shipped order and its open refund return.
    const f = await createShippedOrderFixture(db(), { createdAt: '2026-01-02T00:00:00Z', lines: [{ quantity: 1 }] });
    const r = await insertReturnRecord(db(), { orderId: f.orderId,
      lines: [{ fulfillmentId: f.fulfillments[0].id, orderItemId: f.orderItemIds[0], quantity: 1, resolution: 'refund' }] });
    const actor = (await db().query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
      values(gen_random_uuid(),$1,'{}',now(),now()) returning id`, [`g1-receive-top-${randomUUID()}@example.com`])).rows[0].id as string;
    const committed = async () => (await db().query(`select
      (select stock_quantity from public.item_variants where id=$1::bigint) as free,
      (select count(*)::int from public.stock_movements where variant_id=$1::bigint) as movements,
      (select count(*)::int from public.order_items where order_id=$2::uuid) as items,
      (select count(*)::int from public.order_return_receipts where return_id=$3::uuid) as receipts,
      (select status from public.order_returns where id=$3::uuid) as return_status,
      (select count(*)::int from private.group_g_operations where cause_id=$3::text) as operations,
      (select count(*)::int from public.order_item_state_events e join public.order_items oi on oi.id=e.order_item_id
        where oi.order_id=$2::uuid) as states,
      (select count(*)::int from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
        join public.order_items oi on oi.id=a.order_item_id where oi.order_id=$2::uuid) as allocations,
      (select count(*)::int from private.order_email_outbox where order_id=$2::uuid) as emails,
      (select count(*)::int from pg_trigger where tgname='g1_return_top_failure') as triggers`,
    [f.variantIds[0], f.orderId, r.returnId])).rows[0];
    const before = await committed();
    expect(before).toMatchObject({ receipts: 0, return_status: 'open', triggers: 0 });

    const other = await connectLocalDb();
    try {
      await other.query('begin');
      await other.query('update public.shop_return_settings set inspection_enabled=true where id=1');
      await other.query(`create function pg_temp.reject_return_top() returns trigger language plpgsql as
        'begin raise exception ''G1_RETURN_TOP_FAILURE'' using errcode=''55000''; end'`);
      await other.query(`create trigger g1_return_top_failure before insert on public.order_item_state_events
        for each row execute function pg_temp.reject_return_top()`);
      await expect(other.query(`select * from public.admin_receive_return($1::uuid,$2::uuid,true,$3::uuid,
        $4::jsonb,'[]'::jsonb,'consult',null,0,null,true,'fixture sent back',null,null)`, [r.returnId, actor, randomUUID(),
        JSON.stringify([{ return_line_id: r.lineIds[0], disposition: 'restocked', quantity: 1 }])]))
        .rejects.toMatchObject({ code: '55000', message: 'G1_RETURN_TOP_FAILURE' });
      await other.query('rollback');
    } finally {
      await other.end();
    }

    expect(await committed()).toEqual(before);
  });
});