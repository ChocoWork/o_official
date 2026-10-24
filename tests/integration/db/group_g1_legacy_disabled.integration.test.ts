/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, shipFixtureOrder, uniqueSuffix } from './helpers/order-fixtures';

/**
 * G-1 Task 14（FREQ-524-AC-03・FREQ-540-AC-05）: 旧の発送4関数は LEGACY_FULFILLMENT_DISABLED / 55000、手動の仕上がり2関数は
 * MANUAL_COMPLETION_DISABLED / 55000 で、引数の確かめ・lock・参照・再送の判定より先に断る。データ・メール・割当・履歴は何も変えない。
 * 仕上がりの表は所有者の通常の SQL の新しい INSERT・UPDATE もトリガーで断る。写しの helper 2本は消した。
 * 1件ごとに取引の中で動かし、終わったら戻す（2接続の試験だけは確定した行を使う）。
 */
jest.setTimeout(30000);

const LEGACY = { code: '55000', message: 'LEGACY_FULFILLMENT_DISABLED' };
const MANUAL = { code: '55000', message: 'MANUAL_COMPLETION_DISABLED' };

const STOPPED = [
  ['public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
    'select * from public.admin_create_fulfillment($1,$2,$3,$4,$5,$6,$7::jsonb)', LEGACY],
  ['public.admin_cancel_fulfillment(uuid,uuid,uuid)',
    'select * from public.admin_cancel_fulfillment($1,$2,$3)', LEGACY],
  ['public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)',
    'select * from public.admin_update_fulfillment_tracking($1,$2,$3,$4,$5,$6,$7)', LEGACY],
  ['public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)',
    'select * from public.admin_mark_fulfillment_delivered($1,$2,$3,$4,$5::date,$6)', LEGACY],
  ['public.admin_record_completion(uuid,uuid,uuid,jsonb)',
    'select * from public.admin_record_completion($1,$2,$3,$4::jsonb)', MANUAL],
  ['public.admin_cancel_completion(uuid,uuid,uuid)',
    'select * from public.admin_cancel_completion($1,$2,$3)', MANUAL],
] as const;

type Target = { orderId: string; orderItemId: string; fulfillmentId: string; actorId: string };

async function createActor(db: PgClient): Promise<string> {
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`legacy-disabled-${uniqueSuffix()}@example.com`],
  );
  return res.rows[0].id as string;
}

/** 在庫の品2点の入金済みの注文に、1点の合成の発送（通知あり）を作る */
async function createTarget(db: PgClient): Promise<Target> {
  const fx = await createCatalogFixture(db, { stock: 2 });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status: 'paid',
    lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 2, fulfillmentType: 'stock' }],
  });
  const actorId = await createActor(db);
  const shipped = await shipFixtureOrder(db, {
    orderId, actorId, notifyCustomer: true, lines: [{ order_item_id: orderItemIds[0], quantity: 1 }],
  });
  return { orderId, orderItemId: orderItemIds[0], fulfillmentId: shipped.fulfillment_id, actorId };
}

/** 有効な入力・空の入力・再送（同じ入力を2回）を、関数ごとの引数で返す */
function argumentSets(signature: string, t: Target, requestKey: string): unknown[][] {
  const lines = JSON.stringify([{ order_item_id: t.orderItemId, quantity: 1 }]);
  const valid: Record<string, unknown[]> = {
    'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)': [t.orderId, t.actorId, requestKey, 'yamato', 'G1-STOP-1', true, lines],
    'public.admin_cancel_fulfillment(uuid,uuid,uuid)': [t.orderId, t.fulfillmentId, t.actorId],
    'public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)': [t.orderId, t.fulfillmentId, t.actorId, requestKey, 'sagawa', 'G1-STOP-2', true],
    'public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)': [t.orderId, t.fulfillmentId, t.actorId, requestKey, '2026-10-20', true],
    'public.admin_record_completion(uuid,uuid,uuid,jsonb)': [t.orderId, t.actorId, requestKey, lines],
    'public.admin_cancel_completion(uuid,uuid,uuid)': [t.orderId, crypto.randomUUID(), t.actorId],
  };
  const args = valid[signature];
  return [args, args, args.map(() => null), args.map((value, index) => (index === 0 ? crypto.randomUUID() : value))];
}

/** 止めた関数が変えてはいけない物の全体の写し（この取引の中の全行の数と、対象の注文の行） */
async function snapshot(db: PgClient, orderId: string) {
  const counts = (await db.query(`select
    (select count(*) from public.order_fulfillments) as fulfillments,
    (select count(*) from public.order_fulfillment_lines) as fulfillment_lines,
    (select count(*) from public.order_fulfillment_events) as events,
    (select count(*) from public.order_fulfillment_tracking_changes) as tracking_changes,
    (select count(*) from private.fulfillment_tracking_registrations) as registrations,
    (select count(*) from public.order_fulfillment_attention) as attention,
    (select count(*) from private.order_email_outbox) as emails,
    (select count(*) from public.order_item_completions) as completions,
    (select count(*) from public.order_item_allocations) as allocations,
    (select coalesce(sum(remaining_quantity), 0) from public.order_item_allocations) as allocated,
    (select count(*) from public.order_item_allocation_events) as allocation_events,
    (select count(*) from public.order_item_state_events) as state_events,
    (select count(*) from private.group_g_operations) as operations,
    (select count(*) from public.stock_movements) as movements,
    (select coalesce(sum(stock_quantity), 0) from public.item_variants) as stock,
    (select count(*) from public.order_revisions) as revisions`)).rows[0];
  const order = (await db.query('select * from public.orders where id = $1', [orderId])).rows[0];
  const fulfillments = (await db.query('select * from public.order_fulfillments where order_id = $1 order by id', [orderId])).rows;
  return { counts, order, fulfillments };
}

async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint stopped_call');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint stopped_call');
}

describeLocalDb('integration: G-1 で止めた旧の発送・仕上がりの関数', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  test.each(STOPPED)('%s は有効・空・再送・無い注文の入力でも固定の拒否で、データ・メール・割当・履歴の差分は0', async (signature, sql, match) => {
    const target = await createTarget(db());
    const before = await snapshot(db(), target.orderId);
    for (const params of argumentSets(signature, target, crypto.randomUUID())) {
      await expectRejected(db(), sql, params, match);
    }
    expect(await snapshot(db(), target.orderId)).toEqual(before);
  });

  test.each(STOPPED)('%s は service_role だけが呼べ、その時も固定の拒否。お客様・ログインした人は呼べない', async (signature, sql, match) => {
    const acl = (await db().query(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service_role,
              p.prosecdef, p.proconfig, p.proowner::regrole::text as owner,
              exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_execute
       from pg_proc p where p.oid = $1::regprocedure`, [signature],
    )).rows[0];
    expect(acl).toEqual({
      anon: false, authenticated: false, service_role: true, prosecdef: false,
      proconfig: ['search_path=""'], owner: 'postgres', public_execute: false,
    });
    const nulls = sql.match(/\$\d+/g)!.map(() => null);
    for (const role of ['anon', 'authenticated']) {
      await db().query('savepoint role_call');
      await db().query(`set local role ${role}`);
      await expect(db().query(sql, nulls)).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint role_call');
    }
    await db().query('savepoint role_call');
    await db().query('set local role service_role');
    await expect(db().query(sql, nulls)).rejects.toMatchObject(match);
    await db().query('rollback to savepoint role_call');
  });

  test('仕上がりの表は service_role から書けず、所有者の新しい INSERT・UPDATE もトリガーが MANUAL_COMPLETION_DISABLED で断る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
      status: 'paid',
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 2, fulfillmentType: 'backorder' }],
    });
    const insert = `insert into public.order_item_completions (order_id, order_item_id, quantity, request_key)
      values ($1, $2, 1, gen_random_uuid()) returning id`;
    await expectRejected(db(), insert, [orderId, orderItemIds[0]], MANUAL);

    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const allowed = (await db().query(
        "select has_table_privilege('service_role', 'public.order_item_completions', $1) as allowed", [privilege],
      )).rows[0].allowed;
      expect({ privilege, allowed }).toEqual({ privilege, allowed: false });
    }

    // 前からある行（G-1 の前に書かれた行の再現）を、この取引の中だけトリガーを外して作り、更新が断られることを見る
    await db().query('alter table public.order_item_completions disable trigger order_item_completions_disabled');
    const legacyRow = (await db().query(insert, [orderId, orderItemIds[0]])).rows[0].id as string;
    await db().query('alter table public.order_item_completions enable trigger order_item_completions_disabled');
    await expectRejected(db(), 'update public.order_item_completions set cancelled_at = now() where id = $1', [legacyRow], MANUAL);
    // 削除は既存の守りが断る（片付けの節だけがトリガーを外して消す）
    await expectRejected(db(), 'delete from public.order_item_completions where id = $1', [legacyRow], { code: '55000' });

    const trigger = (await db().query(`select tgfoid::regprocedure::text as fn, tgtype, tgenabled from pg_trigger
      where tgrelid = 'public.order_item_completions'::regclass and tgname = 'order_item_completions_disabled'`)).rows;
    expect(trigger).toEqual([{ fn: 'private.reject_group_g_manual_completion()', tgtype: 23, tgenabled: 'O' }]);
  });

  test('写しの helper 2本は消してあり、DROP 済みの旧関数も戻らない', async () => {
    const res = await db().query(`select
      to_regprocedure('private.backfill_legacy_fulfillments()') as backfill,
      to_regprocedure('private.link_legacy_shipped_emails()') as link,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.proname in ('finalize_order_from_checkout_draft', 'admin_ship_paid_order', 'apply_order_refund_projection')) as dropped`);
    expect(res.rows[0]).toEqual({ backfill: null, link: null, dropped: 0 });
  });

  test('止めた関数は同じ名前の別の形を持たない（Data API が呼び分けに迷わない）', async () => {
    const res = await db().query(`select p.proname, count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('admin_create_fulfillment', 'admin_cancel_fulfillment',
        'admin_update_fulfillment_tracking', 'admin_mark_fulfillment_delivered', 'admin_record_completion', 'admin_cancel_completion')
      group by p.proname order by p.proname`);
    expect(res.rows).toEqual([
      { proname: 'admin_cancel_completion', n: 1 }, { proname: 'admin_cancel_fulfillment', n: 1 },
      { proname: 'admin_create_fulfillment', n: 1 }, { proname: 'admin_mark_fulfillment_delivered', n: 1 },
      { proname: 'admin_record_completion', n: 1 }, { proname: 'admin_update_fulfillment_tracking', n: 1 },
    ]);
  });
});

describeLocalDb('integration: 止めた関数は共通の押さえも注文の行も待たない（2接続）', (db) => {
  let other: PgClient;
  let otherPid: number;
  let target: Target;

  // The other connection must see real committed rows (an uncommitted row is invisible and never makes it wait).
  // Only the minimum is committed: one order and one fulfillment, with no items, stock, allocations or history,
  // and they are removed again in afterAll (their delete-protection triggers are off only inside that transaction).
  beforeAll(async () => {
    other = await connectLocalDb();
    await other.query("set statement_timeout = '3s'");
    otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await db().query('begin');
    const orderId = (await db().query(`insert into public.orders
      (session_id, checkout_session_id, status, subtotal_amount, shipping_amount, total_amount, currency,
       shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_phone)
      values ($1, $2, 'paid', 5000, 0, 5000, 'jpy',
        'fixture@example.com', '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222') returning id`,
    [`g1-legacy-wait-${uniqueSuffix()}`, `cs_g1_legacy_wait_${uniqueSuffix()}`])).rows[0].id as string;
    const fulfillmentId = (await db().query(`insert into public.order_fulfillments
      (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, shipped_at)
      values ($1, 1, gen_random_uuid(), 'yamato', 'G1-LEGACY-WAIT', false, false, now()) returning id`, [orderId])).rows[0].id as string;
    await db().query('commit');
    target = { orderId, orderItemId: crypto.randomUUID(), fulfillmentId, actorId: crypto.randomUUID() };
  });

  // The shared client of describeLocalDb is closed by its own afterAll first, so the cleanup uses `other`.
  afterAll(async () => {
    try {
      if (!target) return;
      await other.query('begin');
      try {
        await other.query('alter table public.order_fulfillments disable trigger order_fulfillments_no_delete');
        await other.query('alter table public.orders disable trigger protect_legal_order_delete');
        await other.query('delete from public.order_fulfillments where id = $1', [target.fulfillmentId]);
        await other.query('delete from public.orders where id = $1', [target.orderId]);
        await other.query('alter table public.order_fulfillments enable trigger order_fulfillments_no_delete');
        await other.query('alter table public.orders enable trigger protect_legal_order_delete');
        await other.query('commit');
      } catch (error) {
        await other.query('rollback');
        throw error;
      }
      expect((await other.query('select count(*)::int as n from public.orders where id = $1', [target.orderId])).rows[0].n).toBe(0);
    } finally {
      await other.end();
    }
  });

  /** Watches the other connection from the lock holder while its call is still running; returns every blocked sample. */
  async function watchWhileRunning(call: Promise<unknown>): Promise<{ samples: number; blocked: number }> {
    let settled = false;
    void call.then(() => { settled = true; }, () => { settled = true; });
    let samples = 0;
    let blocked = 0;
    do {
      const row = (await db().query(`select pg_catalog.cardinality(pg_catalog.pg_blocking_pids($1::int)) > 0
          or exists(select 1 from pg_catalog.pg_locks where pid = $1::int and not granted) as waiting`, [otherPid])).rows[0];
      samples++;
      if (row.waiting) blocked++;
    } while (!settled && samples < 1000);
    return { samples, blocked };
  }

  test('見張りは、待っている相手を見つけられる（共通の押さえを待つ接続）', async () => {
    await db().query('begin');
    try {
      await db().query('select pg_catalog.pg_advisory_xact_lock(190521, 1)');
      await other.query('begin');
      const waiting = other.query('select pg_catalog.pg_advisory_xact_lock(190521, 1)');
      void waiting.catch(() => {});
      let seen = false;
      for (let i = 0; i < 1000 && !seen; i++) {
        seen = (await db().query('select pg_catalog.cardinality(pg_catalog.pg_blocking_pids($1::int)) > 0 as w', [otherPid])).rows[0].w;
      }
      expect(seen).toBe(true);
      await db().query('rollback');
      await waiting;
    } finally {
      await db().query('rollback').catch(() => undefined);
      await other.query('rollback');
    }
  });

  test.each(STOPPED)('%s は、別の接続が共通の押さえと注文・発送の行を持っていても待たずに断る', async (signature, sql, match) => {
    await db().query('begin');
    try {
      await db().query('select pg_catalog.pg_advisory_xact_lock(190521, 1)');
      await db().query('select id from public.orders where id = $1 for update', [target.orderId]);
      await db().query('select id from public.order_fulfillments where order_id = $1 for update', [target.orderId]);
      const started = Date.now();
      const call = other.query(sql, argumentSets(signature, target, crypto.randomUUID())[0]);
      void call.catch(() => {});
      // Counted while the call is still in flight (not after it ended): it is never seen waiting on a lock.
      const watched = await watchWhileRunning(call);
      await expect(call).rejects.toMatchObject(match);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(watched.samples).toBeGreaterThan(0);
      expect(watched.blocked).toBe(0);
    } finally {
      await db().query('rollback');
    }
  });
});
