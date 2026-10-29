/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { hDiscount, hRpc, seedHDiscount, seedHMember, seedHRedemption } from './helpers/group-h-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { createCatalogFixture } from './helpers/order-fixtures';

type Outcome = { ok: true } | { ok: false; code?: string; message?: string };
type Op = (client: PgClient) => Promise<unknown>;
jest.setTimeout(120000);
describeLocalDb('H2 common advisory serialization (controller: run three times)', (db) => {
  const clients: PgClient[] = [];
  afterEach(async () => { for (const c of clients.splice(0)) { await c.query('rollback').catch(() => undefined); await c.end(); } await db().query('rollback'); });
  async function connection() { const c = await connectLocalDb(); clients.push(c); await c.query("set statement_timeout='20s'"); return c; }
  const pid = async (c: PgClient) => Number((await c.query('select pg_backend_pid() p')).rows[0].p);
  async function waitBlocked(waiter: number, blockers: number[]) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const r = (await db().query(`select exists(select 1 from unnest(pg_blocking_pids($1)) p where p=any($2::int[])) b,
        exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and classid=190521 and objid=1 and objsubid=2 and not granted) l`, [waiter, blockers])).rows[0];
      if (r.b && r.l) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('H2_COMMON_LOCK_WAIT_NOT_OBSERVED');
  }
  async function invoke(c: PgClient, op: Op): Promise<Outcome> {
    await c.query('savepoint h2_race');
    try { await op(c); await c.query('set constraints all immediate'); return { ok: true }; }
    catch (caught) { const e = caught as { code?: string; message?: string }; await c.query('rollback to savepoint h2_race');
      return { ok: false, code: e.code, message: /^GROUP_H_[A-Z_]+$/.test(e.message ?? '') ? e.message : 'DATABASE_ERROR' }; }
  }
  async function race(aOp: Op, bOp: Op, probeIds: string[] = []) {
    const gate = await connection(), a = await connection(), b = await connection();
    const gp = await pid(gate), ap = await pid(a), bp = await pid(b);
    await gate.query('begin'); await gate.query('select pg_advisory_xact_lock(190521,1)');
    await a.query('begin'); await b.query('begin');
    const pa = invoke(a, aOp); await waitBlocked(ap, [gp]);
    const pb = invoke(b, bOp); await waitBlocked(bp, [gp, ap]);
    // No H row lock may precede the common lock. This probe must succeed while both wait.
    await db().query('begin'); await db().query('select id from public.discounts where id=any($1::uuid[]) for update nowait', [probeIds]); await db().query('rollback');
    await gate.query('rollback');
    const aFirst = await Promise.race([pa.then(() => true), pb.then(() => false)]);
    const [winner, loser, wc, lc, wp, lp] = aFirst ? [pa, pb, a, b, ap, bp] : [pb, pa, b, a, bp, ap];
    const w = await winner; if (w.ok) await waitBlocked(lp, [wp]);
    await wc.query(w.ok ? 'commit' : 'rollback'); const l = await loser; await lc.query(l.ok ? 'commit' : 'rollback');
    const results = [await pa, await pb];
    expect(results.some(r => !r.ok && r.code === '40P01')).toBe(false); return results;
  }
  async function material(run: () => Promise<void>) { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); await run(); await db().query('set constraints all immediate'); await db().query('commit'); }

  test('FREQ-546-AC-03: 予定の重なり25件へ同時に２件足しても26件にならない', async () => {
    let actor = ''; const name = `race-${randomUUID()}`;
    // A disjoint future window makes repeated runs independent of committed test material.
    const start = new Date(Date.UTC(2300, 0, 1) + Math.floor(Math.random() * 1000000000) * 1000);
    const input = hDiscount({ name, method: 'automatic', allowGuests: true, startsAt: start.toISOString(), endsAt: new Date(+start + 1000).toISOString() });
    const ids: string[] = [];
    await material(async () => { actor = await createPurchaseFlow(db).manager(); for (let n = 0; n < 24; n++) ids.push(await seedHDiscount(db(), input)); });
    const op: Op = c => hRpc(c, 'admin_create_discount', [input, randomUUID(), actor]);
    const results = await race(op, op, ids);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toEqual({ ok: false, code: '23514', message: 'GROUP_H_AUTOMATIC_LIMIT' });
    expect((await db().query('select count(*)::int n from public.discounts where name=$1', [name])).rows[0].n).toBe(25);
  });

  test('FREQ-547-AC-04: 同時６件目は１件だけ成功し共有itemセットも共通鍵で直列化する', async () => {
    let actor = ''; const name = `cap-${randomUUID()}`;
    const start = new Date(Date.UTC(2500, 0, 1) + Math.floor(Math.random() * 1000000000) * 1000);
    const input = hDiscount({ name, method: 'automatic', allowGuests: true, combinesWithOrder: true,
      startsAt: start.toISOString(), endsAt: new Date(+start + 1000).toISOString() });
    const ids: string[] = [];
    await material(async () => { actor = await createPurchaseFlow(db).manager(); for (let n = 0; n < 5; n++) ids.push(await seedHDiscount(db(), input)); });
    const op: Op = c => hRpc(c, 'admin_create_discount', [input, randomUUID(), actor]);
    const capped = await race(op, op, ids); expect(capped.filter(r => r.ok)).toHaveLength(1);
    expect(capped.find(r => !r.ok)).toEqual({ ok: false, code: '23514', message: 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' });
    let items: number[] = [];
    await material(async () => { items = [(await createCatalogFixture(db())).itemId, (await createCatalogFixture(db())).itemId]; });
    const set = hDiscount({ kind: 'set', targetMode: 'include', itemIds: items, combinesWithProduct: true });
    const sets = await race(c => hRpc(c, 'admin_create_discount', [set, randomUUID(), actor]), c => hRpc(c, 'admin_create_discount', [set, randomUUID(), actor]));
    expect(sets.filter(r => r.ok)).toHaveLength(1);
    expect(sets.find(r => !r.ok)).toEqual({ ok: false, code: '23514', message: 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' });
  });

  test('FREQ-547-AC-05: 解除と受付が競合したらどちらか一方が先に決まり使用後の解除は拒否される', async () => {
    for (const reservationFirst of [true, false]) {
    let actor = '', user = '', id = '', code = '';
    await material(async () => { actor = await createPurchaseFlow(db).manager(); user = await seedHMember(db());
      id = await seedHDiscount(db(), hDiscount({ audience: 'assigned', code: `RACE-${randomUUID().toUpperCase()}`, userIds: [user] }));
      code = (await db().query('select id from public.discount_codes where discount_id=$1', [id])).rows[0].id as string; });
    const reserve: Op = async c => {
      await c.query('select pg_advisory_xact_lock(190521,1)'); await c.query('select pg_advisory_xact_lock(190522,0)');
      const rows = (await c.query('select id from public.discount_assignments where code_id=$1 and user_id=$2', [code, user])).rows;
      if (rows.length) await seedHRedemption(c, id, { codeId: code, userId: user, state: 'reserved' });
      else await c.query("do $$begin raise exception 'GROUP_H_ASSIGNMENT_USED' using errcode='55000'; end$$");
    };
    const unassign: Op = c => hRpc(c, 'admin_unassign_discount', [id, code, user, randomUUID(), actor]);
    const outcomes = reservationFirst ? await race(reserve, unassign, [id]) : await race(unassign, reserve, [id]);
    expect(outcomes.filter(r => r.ok)).toHaveLength(1);
    const counts = (await db().query(`select (select count(*)::int from public.discount_assignments where code_id=$1) a,
      (select count(*)::int from public.discount_redemptions where code_id=$1 and state='reserved') r`, [code])).rows[0];
    expect(counts).toEqual(reservationFirst ? { a: 1, r: 1 } : { a: 0, r: 0 });
    }
  });
});
