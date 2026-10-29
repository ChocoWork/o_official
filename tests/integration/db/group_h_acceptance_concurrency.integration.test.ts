/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { acceptHCheckout, hDiscount, seedHCheckout, seedHDiscount, seedHMember } from './helpers/group-h-fixtures';

jest.setTimeout(120000);
describeLocalDb('H4 acceptance common-lock races (controller: three consecutive runs)', db => {
  const clients: PgClient[] = [];
  afterEach(async () => { for (const c of clients.splice(0)) { await c.query('rollback').catch(() => undefined); await c.end(); } await db().query('rollback'); });
  async function connection() { const c = await connectLocalDb(); clients.push(c); await c.query("set statement_timeout='20s'"); return c; }
  const pid = async (c: PgClient) => Number((await c.query('select pg_backend_pid() p')).rows[0].p);
  async function blocked(waiter: number, blockers: number[]) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const r = (await db().query(`select exists(select 1 from unnest(pg_blocking_pids($1)) p where p=any($2::int[])) b,
        exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and classid=190521 and objid=1 and objsubid=2 and not granted) l`, [waiter, blockers])).rows[0];
      if (r.b && r.l) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('H4_COMMON_LOCK_WAIT_NOT_OBSERVED');
  }
  type Frozen = Awaited<ReturnType<typeof seedHCheckout>>;
  async function race(first: Frozen, second: Frozen, link?: { userId: string; email: string }) {
    const gate = await connection(), a = await connection(), b = await connection();
    const gp = await pid(gate), ap = await pid(a), bp = await pid(b);
    await gate.query('begin'); await gate.query('select pg_advisory_xact_lock(190521,1)');
    await a.query('begin'); await b.query('begin');
    const pa = acceptHCheckout(a, first); await blocked(ap, [gp]);
    const pb = link ? b.query('select * from public.link_guest_orders($1,$2)', [link.userId, link.email]) : acceptHCheckout(b, second);
    await blocked(bp, [gp, ap]);
    await gate.query('rollback'); const ra = await pa; await blocked(bp, [ap]);
    await a.query('commit'); const rb = await pb; await b.query('commit'); return { ra, rb };
  }

  test('FREQ-549-AC-05: 同一人の２draftは別コードでも初回を２回予約できず結付けとも競合しない', async () => {
    for (const kind of ['member', 'guest', 'link'] as const) {
      await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)');
      const email = `h4race-${randomUUID()}@example.invalid`; const userId = await seedHMember(db(), email);
      await db().query('update auth.users set email_confirmed_at=now() where id=$1', [userId]);
      const codes = [0, 1].map(() => `H4-${randomUUID().toUpperCase()}`);
      const ids = await Promise.all(codes.map(code => seedHDiscount(db(), hDiscount({ code, firstOrderOnly: true, allowGuests: true }))));
      const first = await seedHCheckout(db(), { discountId: ids[0], code: codes[0], email: email.toUpperCase(), ...(kind === 'member' ? { userId } : {}) });
      const second = await seedHCheckout(db(), { discountId: ids[1], code: codes[1], email, ...(kind === 'guest' ? {} : { userId }) });
      await db().query('set constraints all immediate'); await db().query('commit');
      const result = await race(first, second, kind === 'link' ? { userId, email } : undefined);
      expect(result.ra.rejection).toBeNull();
      if (kind === 'link') {
        // 結付けは先に受け付けた guest の注文を会員へ付け替える（G共通鍵の待ちが解けた後）。結果の行と注文の持ち主を確かめる
        expect((result.rb as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).toEqual([result.ra.order_id]);
        expect((await db().query('select user_id from public.orders where id=$1', [result.ra.order_id])).rows[0].user_id).toBe(userId);
        await db().query('begin'); const afterLink = await acceptHCheckout(db(), second); await db().query('rollback');
        expect(afterLink.rejection).toBe('discount_first_order_changed');
        expect((await db().query('select user_id,identity_key from public.discount_redemptions where order_id=$1', [result.ra.order_id])).rows[0]).toEqual({ user_id: userId, identity_key: `member:${userId}` });
      } else expect(result.rb).toMatchObject({ created: false, rejection: 'discount_first_order_changed' });
    }
  });
});
