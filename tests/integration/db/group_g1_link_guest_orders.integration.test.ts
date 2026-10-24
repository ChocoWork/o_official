/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, insertOrderWithLines, insertOrderWithStockLine } from './helpers/order-fixtures';

/**
 * G-1 Task 6: guest orders are linked by a service_role-only RPC that takes the common advisory first and
 * then locks/updates the matching orders in id order. The e-mail is an exact, case-insensitive match.
 */
jest.setTimeout(30000);

const LINK_SQL = 'select * from public.link_guest_orders($1::uuid, $2::text)';

describeLocalDb('G-1 guest order linking', (db) => {
  let catalog: { itemId: number; variantId: number };

  beforeAll(async () => {
    catalog = await createCatalogFixture(db(), { stock: 0 });
  });

  async function user(email: string, confirmed = true): Promise<string> {
    return (await db().query(
      `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, case when $2::boolean then now() else null end, '{}'::jsonb, now(), now()) returning id`,
      [email, confirmed],
    )).rows[0].id as string;
  }

  async function guestOrder(email: string, status = 'pending'): Promise<string> {
    return (await insertOrderWithLines(db(), { status, shippingEmail: email, lines: [
      { itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, fulfillmentType: 'backorder' },
    ] })).orderId;
  }

  /** Inserts guest orders with chosen ids, the largest id first and with the oldest order date. */
  async function guestOrdersInReverse(email: string, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID()).sort();
    for (const [index, id] of [...ids].reverse().entries()) {
      await db().query(
        `insert into public.orders (id, session_id, checkout_session_id, status, subtotal_amount, shipping_amount, total_amount,
           currency, shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city,
           shipping_address, shipping_phone, created_at)
         values ($1, $2, $3, 'pending', 5000, 0, 5000, 'jpy', $4, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1',
           '0311112222', $5::timestamptz)`,
        [id, `fx-link-${id}`, `cs_fx_link_${id}`, email, new Date(Date.UTC(2026, 0, 1 + index)).toISOString()],
      );
    }
    return ids;
  }

  async function ownerOf(orderId: string): Promise<string | null> {
    return (await db().query('select user_id from public.orders where id = $1', [orderId])).rows[0].user_id as string | null;
  }

  test('matches the e-mail case-insensitively and exactly: %, _ and \\ are plain characters', async () => {
    const tag = randomUUID().slice(0, 8);
    const email = `a_b%c\\d.${tag}@example.com`;
    const userId = await user(email);
    const exact = await guestOrder(`A_B%C\\D.${tag}@Example.COM`);
    const decoys = [
      await guestOrder(`axb%c\\d.${tag}@example.com`),
      await guestOrder(`a_bzzc\\d.${tag}@example.com`),
      await guestOrder(`a_b%cd.${tag}@example.com`),
      await guestOrder(`a_b%c\\\\d.${tag}@example.com`),
    ];

    const linked = await db().query(LINK_SQL, [userId, `  ${email.toUpperCase()} `]);

    expect(linked.rows.map((row) => row.id)).toEqual([exact]);
    expect(await ownerOf(exact)).toBe(userId);
    for (const decoy of decoys) expect(await ownerOf(decoy)).toBeNull();
  });

  test('returns the 8 columns of the updated rows in id order; a replay returns 0 rows', async () => {
    const email = `g1-link-${randomUUID()}@example.com`;
    const userId = await user(email);
    const ids = await guestOrdersInReverse(email, 3);

    const first = await db().query(LINK_SQL, [userId, email]);
    const replay = await db().query(LINK_SQL, [userId, email]);

    expect(first.rows).toEqual(ids.map((id, index) => ({
      id,
      shipping_full_name: '山田 花子',
      shipping_postal_code: '1500001',
      shipping_prefecture: '東京都',
      shipping_city: '渋谷区',
      shipping_address: '神宮前1-1-1',
      shipping_building: null,
      created_at: new Date(Date.UTC(2026, 0, 3 - index)),
    })));
    expect(replay.rows).toEqual([]);
    for (const id of ids) expect(await ownerOf(id)).toBe(userId);
  });

  test("never moves another owner's order and links nothing for an unconfirmed, different or missing account", async () => {
    const email = `g1-link-${randomUUID()}@example.com`;
    const owner = await user(`owner-${randomUUID()}@example.com`);
    const owned = await guestOrder(email);
    await db().query('update public.orders set user_id = $2 where id = $1', [owned, owner]);
    const guest = await guestOrder(email);
    const unconfirmed = await user(email, false);
    const other = await user(`other-${randomUUID()}@example.com`);

    for (const userId of [unconfirmed, other, randomUUID()]) {
      await expect(db().query(LINK_SQL, [userId, email])).rejects.toMatchObject({ code: '42501', message: 'GROUP_G_FORBIDDEN' });
    }
    expect(await ownerOf(guest)).toBeNull();

    // The confirmed owner of the address links only the guest order; the other owner's order stays.
    await db().query('update auth.users set email_confirmed_at = now() where id = $1', [unconfirmed]);
    expect((await db().query(LINK_SQL, [unconfirmed, email])).rows.map((row) => row.id)).toEqual([guest]);
    expect(await ownerOf(owned)).toBe(owner);
  });

  test.each([
    [null, 'x@example.com'],
    ['user', null],
    ['user', '   '],
  ])('rejects user=%s email=%s with GROUP_G_ARGUMENT_INVALID', async (userArg, email) => {
    const userId = userArg === null ? null : randomUUID();
    await expect(db().query(LINK_SQL, [userId, email])).rejects.toMatchObject({ code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' });
  });

  test('only service_role may execute; anon and authenticated are refused', async () => {
    for (const signature of ['public.link_guest_orders(uuid,text)', 'private.link_guest_orders(uuid,text)']) {
      const res = await db().query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as authed,
                has_function_privilege('service_role', $1, 'EXECUTE') as service,
                has_function_privilege('public', $1, 'EXECUTE') as everyone`,
        [signature],
      );
      expect(res.rows[0]).toEqual({ anon: false, authed: false, service: true, everyone: false });
    }
    const definition = (await db().query(
      `select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner from pg_proc p
       where p.oid in ('public.link_guest_orders(uuid,text)'::regprocedure, 'private.link_guest_orders(uuid,text)'::regprocedure)
       order by p.prosecdef`,
    )).rows;
    expect(definition).toEqual([
      { prosecdef: false, proconfig: ['search_path=""'], owner: 'postgres' },
      { prosecdef: true, proconfig: ['search_path=""'], owner: 'postgres' },
    ]);

    const email = `g1-link-${randomUUID()}@example.com`;
    const userId = await user(email);
    const order = await guestOrder(email);
    for (const role of ['anon', 'authenticated']) {
      await db().query('begin');
      try {
        await db().query(`set local role ${role}`);
        await expect(db().query(LINK_SQL, [userId, email])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await db().query('rollback');
      }
    }
    expect(await ownerOf(order)).toBeNull();
    await db().query('begin');
    try {
      await db().query('set local role service_role');
      expect((await db().query(LINK_SQL, [userId, email])).rows.map((row) => row.id)).toEqual([order]);
      await db().query('reset role');
      await db().query('commit');
    } catch (error) {
      await db().query('rollback');
      throw error;
    }
    expect(await ownerOf(order)).toBe(userId);
  });
});

describeLocalDb('G-1 guest order linking across connections', (db) => {
  async function client() {
    const c = await connectLocalDb();
    await c.query("set statement_timeout='10s'");
    return c;
  }

  async function pidOf(c: PgClient) { return (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number; }

  async function waitBlockedBy(observer: PgClient, waiter: number, blocker: number, advisory: boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = (await observer.query(`select $2::int = any(pg_catalog.pg_blocking_pids($1::int)) as blocked,
        exists(select 1 from pg_catalog.pg_locks where pid=$1::int and locktype='advisory'
          and classid=190521 and objid=1 and objsubid=2 and not granted) as advisory`, [waiter, blocker])).rows[0];
      if (r.blocked && r.advisory === advisory) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('G1_LINK_WAIT_NOT_OBSERVED');
  }

  async function confirmedUser(email: string) {
    return (await db().query(
      `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, now(), '{}'::jsonb, now(), now()) returning id`, [email],
    )).rows[0].id as string;
  }

  async function guestOrders(email: string, count: number) {
    const fx = await createCatalogFixture(db(), { stock: count });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push((await insertOrderWithStockLine(db(), {
        status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true, shippingEmail: email,
      })).orderId);
    }
    return { fx, ids: ids.sort() };
  }

  test('locks the matching orders in id order after the advisory: a held middle row leaves the lower locked and the higher free', async () => {
    const email = `g1-link-order-${randomUUID()}@example.com`;
    const userId = await confirmedUser(email);
    const { ids } = await guestOrders(email, 3);
    const holder = await client();
    const linker = await client();
    const probe = await client();
    let pending: Promise<{ rows: any[] }> | undefined;
    try {
      const [holderPid, linkerPid] = [await pidOf(holder), await pidOf(linker)];
      await holder.query('begin');
      await holder.query('select id from public.orders where id = $1 for update', [ids[1]]);
      await linker.query('begin');
      pending = linker.query('select id from public.link_guest_orders($1::uuid,$2::text)', [userId, email]);
      void pending.catch(() => {});
      await waitBlockedBy(probe, linkerPid, holderPid, false);
      await probe.query('begin');
      await expect(probe.query('select id from public.orders where id = $1 for update nowait', [ids[0]]))
        .rejects.toMatchObject({ code: '55P03' });
      await probe.query('rollback');
      await probe.query('begin');
      expect((await probe.query('select id from public.orders where id = $1 for update nowait', [ids[2]])).rowCount).toBe(1);
      await probe.query('rollback');
      await holder.query('commit');
      expect((await pending).rows.map((row) => row.id)).toEqual(ids);
      await linker.query('commit');
    } finally {
      await holder.query('rollback');
      if (pending) await pending.catch(() => {});
      await linker.query('rollback');
      await probe.query('rollback');
      await Promise.all([holder.end(), linker.end(), probe.end()]);
    }
  });

  test.each(['checkout', 'release', 'payment'])('linking and a concurrent %s finish without deadlock', async (kind) => {
    const email = `g1-link-${kind}-${randomUUID()}@example.com`;
    const userId = await confirmedUser(email);
    const { fx, ids } = await guestOrders(email, 2);
    const first = await client();
    const second = await client();
    let pending: Promise<{ rows: any[] }> | undefined;
    const link = (c: PgClient) => c.query('select id from public.link_guest_orders($1::uuid,$2::text)', [userId, email]);
    const [firstPid, secondPid] = [await pidOf(first), await pidOf(second)];
    try {
      await first.query('begin');
      await second.query('begin');
      if (kind === 'checkout') {
        // Checkout first: the link waits on the advisory, then links both orders.
        const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
        await first.query(`select * from public.place_order_from_checkout_draft($1::uuid,$2::text,$3::text,$4::integer,0,'jpy',now(),null::text)`,
          [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount]);
        pending = link(second);
        void pending.catch(() => {});
        await waitBlockedBy(db(), secondPid, firstPid, true);
        await first.query('commit');
        expect((await pending).rows.map((row) => row.id)).toEqual(ids);
      } else if (kind === 'release') {
        // Link first: the release of one of the orders waits on the advisory, then releases its H.
        expect((await link(first)).rows.map((row) => row.id)).toEqual(ids);
        pending = second.query(`select released from public.release_stock_for_unpaid_order($1::uuid,'payment_in_progress','abandoned','stripe_checkout_expired')`, [ids[1]]);
        void pending.catch(() => {});
        await waitBlockedBy(db(), secondPid, firstPid, true);
        await first.query('commit');
        expect((await pending).rows).toEqual([{ released: true }]);
      } else {
        // The payment RPC holds the order row first; the link takes the advisory and waits on that row only.
        await first.query(`select updated from public.mark_order_paid($1::uuid,'payment_in_progress',$2::text,5000,'jpy',true,'order_confirmed',null)`,
          [ids[0], `pi_${randomUUID()}`]);
        pending = link(second);
        void pending.catch(() => {});
        await waitBlockedBy(db(), secondPid, firstPid, false);
        await first.query('commit');
        expect((await pending).rows.map((row) => row.id)).toEqual(ids);
      }
      await second.query('commit');
      const owners = (await db().query('select user_id from public.orders where id = any($1::uuid[])', [ids])).rows;
      expect(owners.map((row) => row.user_id)).toEqual([userId, userId]);
    } finally {
      await first.query('rollback');
      if (pending) await pending.catch(() => {});
      await second.query('rollback');
      await Promise.all([first.end(), second.end()]);
    }
  });
});

// Separate frame: the unchanged orders_user_id_fkey (profile DELETE -> orders.user_id SET NULL) may meet a G-1
// order/FK lock in reverse. PostgreSQL aborts one side with 40P01 and rolls that transaction back completely.
describeLocalDb('G-1 guest order linking and the unchanged profile FK', (db) => {
  test('a reverse wait with a profile DELETE ends in 40P01 for one side, a full rollback there and no partial update', async () => {
    const email = `g1-link-fk-${randomUUID()}@example.com`;
    const userId = (await db().query(
      `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, now(), '{}'::jsonb, now(), now()) returning id`, [email],
    )).rows[0].id as string;
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const owned = (await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true, shippingEmail: email,
    })).orderId;
    expect((await db().query('select id from public.link_guest_orders($1::uuid,$2::text)', [userId, email])).rows).toEqual([{ id: owned }]);
    const guest = (await insertOrderWithLines(db(), { status: 'pending', shippingEmail: email, lines: [
      { itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'backorder' },
    ] })).orderId;

    const g1 = await connectLocalDb();
    const deleter = await connectLocalDb();
    try {
      for (const c of [g1, deleter]) {
        await c.query("set statement_timeout = '10s'");
        await c.query('begin');
      }
      // G-1 holds the advisory and the owned order row.
      expect((await g1.query('select updated from public.mark_order_awaiting_payment($1::uuid,$2::text,null)',
        [owned, `pi_${randomUUID()}`])).rows).toEqual([{ updated: true }]);
      const g1Pid = (await g1.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      const deleterPid = (await deleter.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      // Deleting the account cascades to the profile DELETE (orders_owner_immutable only lets user_id become NULL
      // once the account is gone): it holds the profile row and waits on the owned order for its SET NULL.
      const deletion = deleter.query('delete from auth.users where id = $1', [userId]);
      void deletion.catch(() => {});
      const deadline = Date.now() + 5000;
      while (!(await db().query('select $2::int = any(pg_catalog.pg_blocking_pids($1::int)) as blocked', [deleterPid, g1Pid])).rows[0].blocked) {
        if (Date.now() > deadline) throw new Error('G1_FK_WAIT_NOT_OBSERVED');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // G-1 now links the guest order: its FK check needs the profile row the deleter holds.
      const linking = g1.query('select id from public.link_guest_orders($1::uuid,$2::text)', [userId, email]);
      const [linked, deleted] = await Promise.allSettled([linking, deletion]);
      const failures = [linked, deleted].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toMatchObject({ code: '40P01' });

      if (linked.status === 'rejected') {
        await g1.query('rollback');
        await deleter.query('commit');
        // The whole G-1 transaction is gone: no awaiting, no link; the delete nulled the owner.
        expect((await db().query('select status::text as status, user_id from public.orders where id = $1', [owned])).rows[0])
          .toEqual({ status: 'payment_in_progress', user_id: null });
        expect((await db().query('select user_id from public.orders where id = $1', [guest])).rows[0].user_id).toBeNull();
        expect((await db().query(`select count(*)::int as n from private.group_g_operations
          where operation = 'mark_order_awaiting_payment' and cause_id = $1`, [owned])).rows[0].n).toBe(0);
        expect((await db().query('select count(*)::int as n from public.profiles where user_id = $1', [userId])).rows[0].n).toBe(0);
      } else {
        await deleter.query('rollback');
        await g1.query('commit');
        // The whole DELETE is gone: the profile stays, both orders belong to the user and the awaiting is kept.
        expect((await db().query('select count(*)::int as n from public.profiles where user_id = $1', [userId])).rows[0].n).toBe(1);
        expect((await db().query('select status::text as status, user_id from public.orders where id = $1', [owned])).rows[0])
          .toEqual({ status: 'pending', user_id: userId });
        expect((await db().query('select user_id from public.orders where id = $1', [guest])).rows[0].user_id).toBe(userId);
      }
      // Nothing is left waiting.
      expect((await db().query(`select count(*)::int as n from pg_stat_activity
        where pid = any($1::int[]) and wait_event_type = 'Lock'`, [[g1Pid, deleterPid]])).rows[0].n).toBe(0);
    } finally {
      await g1.query('rollback').catch(() => undefined);
      await deleter.query('rollback').catch(() => undefined);
      await Promise.all([g1.end(), deleter.end()]);
    }
  });
});
