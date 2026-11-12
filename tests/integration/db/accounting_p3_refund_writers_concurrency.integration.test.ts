/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { seedFactSlip, seedUnitOrder } from './helpers/accounting-orders-fixtures';
import { seedPreShipmentCancel, seedRefundFlow } from './helpers/accounting-returns-fixtures';
import { hBegin, hResult } from './helpers/group-h-refund-fixtures';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// 計画3 Task 3（S17）の並行の試験。2つの接続でコミットまで流す（使い捨ての手元の DB だけ）。
jest.setTimeout(120000);

describeLocalDb('FREQ-577-AC-09: S17 refund writers under concurrency', () => {
  const clients: PgClient[] = [];
  const open = async () => { const c = await connectLocalDb(); clients.push(c); return c; };
  afterEach(async () => {
    for (const c of clients.splice(0)) { await c.query('rollback').catch(() => null); await c.end(); }
  });

  test('FREQ-577-AC-09: 後に始まった取り消しが先に鍵を取っても、送る着と割り当てが重ならない', async () => {
    const setup = await open();
    await setup.query('begin');
    const f = await seedRefundFlow(setup, false);
    await setup.query('commit');

    const confirm = await open();
    const cancel = await open();
    await confirm.query('begin');
    await confirm.query('select 1');
    await cancel.query('begin');
    await cancel.query('select pg_advisory_xact_lock(190521,1)');
    const c = await seedPreShipmentCancel(cancel, f, { itemId: f.itemId, quantity: 1 });
    // 先に始めた確定は鍵の前で待つ
    const waiting = confirm.query('select pg_advisory_xact_lock(190521,1)');
    await new Promise((r) => setTimeout(r, 300));
    await cancel.query('commit');
    await waiting;
    await seedFactSlip(confirm, { orderItemId: f.itemId, quantity: 1 });
    await confirm.query('commit');

    const check = await open();
    const cancelled = (await check.query("select unit_index from public.order_unit_event_lines where event_id=$1 and line_kind='returned'", [c.eventId])).rows[0].unit_index;
    const shipped = (await check.query('select unit_index from private.accounting_shipped_units($1,null)', [f.itemId])).rows.map((r) => r.unit_index);
    const allocated = (await check.query('select unit_index from public.accounting_unit_refund_allocations where refund_key=$1', [c.eventId])).rows.map((r) => r.unit_index);
    expect(allocated).toEqual([cancelled]);
    expect(shipped).toHaveLength(1);
    expect(shipped).not.toContain(cancelled);
  });

  test('FREQ-577-AC-07: 取り消しの区分の選択と返金の結果の記録を同時に流しても、止まらず履歴と割り当てが合う', async () => {
    const setup = await open();
    await setup.query('begin');
    const f = await seedRefundFlow(setup, 1);
    const admin = await insertAccountingAdmin(setup);
    const noItem = (await setup.query(`select * from public.begin_order_refund($1,'admin',$2,'[]'::jsonb,false,0,1000,null,'requested_by_customer',null,false,$3,null,null)`,
      [f.orderId, randomUUID(), f.actor])).rows[0].refund_id as string;
    await setup.query("select * from public.record_order_refund_result($1,$2,'canceled',null,'unknown',null,'card',null,null)", [noItem, `re_${noItem.replaceAll('-', '')}`]);
    const other = (await hBegin(setup, f, 500)).refund_id;
    await setup.query('commit');

    const a = await open();
    const b = await open();
    await a.query('begin');
    await b.query('begin');
    const results = await Promise.allSettled([
      a.query('select public.admin_decide_refund_cancellation($1,$2,$3,$4,$5) as r', [admin, noItem, 'abandoned', 'やめた', randomUUID()]).then(() => a.query('commit')),
      hResult(b, other, 'succeeded').then(() => b.query('commit')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const check = await open();
    const states = async (id: string) => (await check.query('select state from public.accounting_refund_events where refund_id=$1 order by seq', [id])).rows.map((r) => r.state);
    expect(await states(noItem)).toEqual(expect.arrayContaining(['requested', 'canceled', 'abandoned']));
    expect(await states(other)).toEqual(expect.arrayContaining(['requested', 'succeeded']));
    const net = (await check.query(`select coalesce(sum(amount),0)::int n from public.accounting_unit_refund_allocations where refund_key=$1 or refund_key like $2`,
      [noItem, `release:${noItem}:%`])).rows[0].n;
    expect(net).toBe(0);
  });

  test('FREQ-563-AC-02: order_unit_shipped_slots は G の鍵の外で呼んでも断られず、accounting_shipped_units(品, NULL) と同じ着の組を返す', async () => {
    // 注文と発送票を G の鍵を持つ接続で作ってコミットし、鍵を持たない別の接続から読む（巻き戻しの suite から移した）。
    const setup = await open();
    await setup.query('begin');
    await setup.query('select pg_advisory_xact_lock(190521,1)');
    const o = await seedUnitOrder(setup, [[1000, 1000]]);
    await seedFactSlip(setup, { orderItemId: o.orderItemIds[0], quantity: 1 });
    await setup.query('commit');
    const other = await open();
    const held = (await other.query("select count(*)::int n from pg_locks where locktype='advisory' and classid=190521 and pid=pg_backend_pid()")).rows[0].n;
    expect(held).toBe(0);
    const b2 = (await other.query('select unit_index from private.order_unit_shipped_slots($1)', [o.orderItemIds[0]])).rows;
    const c2 = (await other.query('select unit_index from private.accounting_shipped_units($1,null) order by unit_index', [o.orderItemIds[0]])).rows;
    expect(b2).toEqual(c2);
    expect(b2).toEqual([{ unit_index: 0 }]);
  });
});
