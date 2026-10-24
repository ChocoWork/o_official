/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture } from './helpers/order-fixtures';

/**
 * G-1 Task 14（FREQ-522-AC-02・FREQ-524・FREQ-540-AC-05）: 書き手の閉じた一覧の構造の確かめ。
 * public/private の全 pg_proc（SQL・PL/pgSQL、全 overload）の prosrc を走査し、在庫の台帳・発送・仕上がり・割当の3表・
 * 操作の受付への INSERT/UPDATE/DELETE/MERGE/TRUNCATE、item_variants.stock_quantity の UPDATE、これらの表を指す動的 EXECUTE を
 * 持つ関数が private.group_g_writer_allowlist() の中だけにあることを見る。書き手を PERFORM・SELECT・:= で呼ぶ関数も、
 * 一覧の中か、同じ名前の private 本体へ委ねるだけの公開 SQL INVOKER のどちらかに限る。
 * 一覧は設計の53本と、Task 7/8 で足した内部の書き手3本の56本（private.record_group_g_payment_exception_row・
 * private.record_group_g_refund_result・private.release_group_g_payment_holds）に、G-2 Task 4 で
 * private.admin_create_purchase_order を足した57本に、G-2 Task 6 で発注先・メモの訂正 private.admin_update_purchase_order_header、
 * 数量の確定・訂正 private.admin_confirm_purchase_order_quantities、残りの打切り private.admin_short_close_purchase_order を足した
 * 60本（G-2 の後続 Task が書き手を足すたびに増える）。
 */
jest.setTimeout(60000);

const ALLOWLIST = [
  'private.apply_group_g_stock_movement(bigint,integer)',
  'private.allocate_group_g_fifo(bigint[],uuid,uuid)',
  'private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)',
  'private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)',
  'private.ensure_group_g_payment_review_hold(uuid,text,text,text,uuid)',
  'private.release_group_g_payment_review_holds(uuid,uuid)',
  'private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)',
  'private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
  'private.mark_order_awaiting_payment(uuid,text,text)',
  'private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)',
  'private.record_cancelled_order_paid_amount(uuid,text,integer)',
  'private.admin_cancel_failed_order(uuid,uuid,text,text)',
  'private.link_guest_orders(uuid,text)',
  'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)',
  'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)',
  'private.apply_order_refund_state(uuid)',
  'private.apply_return_refund_outcome(uuid,text)',
  'private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)',
  'private.mark_order_refund_error(uuid,text,boolean)',
  'private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)',
  'private.mark_order_reviewed(uuid,uuid)',
  'private.record_payment_exception(text,text,text,text,text,uuid,uuid)',
  'private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)',
  'private.resolve_payment_exception_by_system(uuid,text)',
  'private.customer_order_for_request(uuid,uuid,boolean)',
  'private.customer_request_cancel(uuid,uuid,uuid,jsonb,text)',
  'private.lock_order_cancel_request(uuid)',
  'private.admin_decline_cancel_request(uuid,uuid,text,text)',
  'private.admin_close_cancel_request(uuid,uuid)',
  'private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)',
  'private.lock_order_return(uuid)',
  'private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
  'private.admin_cancel_return(uuid,uuid)',
  'private.customer_request_return(uuid,uuid,uuid,jsonb)',
  'private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
  'private.admin_decline_return(uuid,uuid,text,text)',
  'private.admin_close_return_missing(uuid,uuid,uuid)',
  'private.admin_reopen_return(uuid,uuid,uuid)',
  'private.admin_inspect_return(uuid,uuid,uuid,jsonb)',
  'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)',
  'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)',
  'private.refresh_order_return_status(uuid)',
  'private.admin_record_return_fee_payment(uuid,uuid,text,boolean)',
  'private.admin_release_return_exchange(uuid,uuid)',
  'private.record_delivery_read_result(uuid,integer,uuid,jsonb)',
  'private.apply_tracking_status(uuid,text,timestamptz,timestamptz)',
  'public.apply_stock_movement()',
  'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
  'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
  'public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)',
  'public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)',
  'public.admin_record_completion(uuid,uuid,uuid,jsonb)',
  'public.admin_cancel_completion(uuid,uuid,uuid)',
  'private.record_group_g_payment_exception_row(text,text,text,text,text,uuid,uuid)',
  'private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)',
  'private.release_group_g_payment_holds(uuid,uuid,text,uuid)',
  'private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)',
  'private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)',
  'private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)',
  'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
];

const STOPPED = ALLOWLIST.slice(47, 53);

/** 旧の返品の入口7本（Task 10 レビュー）: private の DEFINER 本体が共通の押さえを取り、公開は INVOKER の委譲だけ */
const LEGACY_RETURN_ENTRIES = [
  'admin_receive_return', 'admin_refund_return', 'admin_inspect_return', 'admin_close_return_missing',
  'admin_reopen_return', 'admin_record_return_fee_payment', 'admin_release_return_exchange',
];

const TABLES = [
  'stock_movements', 'order_fulfillments', 'order_item_completions', 'order_item_allocations',
  'order_item_allocation_events', 'order_item_state_events', 'group_g_operations',
];

type Proc = { oid: string; schema: string; name: string; identity: string; key: string; secdef: boolean; language: string; src: string };

/** 注釈・引用符を外し、空白をまとめ、小文字にする。文字の値（'…'）は別に外せるようにする */
function normalize(src: string, dropLiterals: boolean): string {
  let text = src.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (dropLiterals) text = text.replace(/'(?:[^']|'')*'/g, "''");
  return text.replace(/"/g, '').replace(/\s+/g, ' ').toLowerCase();
}

const WRITE = new RegExp(String.raw`\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+(?:only\s+)?(?:(?:public|private)\s*\.\s*)?(?:${TABLES.join('|')})\b`);
const STOCK = /\bupdate\s+(?:only\s+)?(?:public\s*\.\s*)?item_variants\b[^;]*?\bset\b[^;]*?\bstock_quantity\b/;
const DYNAMIC = /\bexecute\b(?!\s+(?:function|procedure)\b)/;

/** 直接の書き手か（動的 EXECUTE は、文字の値も含めて表の名前があれば書き手として扱う） */
function isDirectWriter(proc: Proc): boolean {
  const code = normalize(proc.src, true);
  const all = normalize(proc.src, false);
  return WRITE.test(code) || STOCK.test(code) || (DYNAMIC.test(code) && TABLES.some((table) => all.includes(table)));
}

async function loadProcs(db: PgClient): Promise<Proc[]> {
  const rows = (await db.query(`select p.oid::text as oid, n.nspname as schema, p.proname as name,
      pg_get_function_identity_arguments(p.oid) as identity, p.prosecdef as secdef, l.lanname as language, p.prosrc as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname in ('public', 'private') and l.lanname in ('sql', 'plpgsql')`)).rows;
  return rows.map((row) => ({ ...row, key: row.oid as string }));
}

async function allowlistOids(db: PgClient): Promise<Set<string>> {
  const rows = (await db.query('select unnest(private.group_g_writer_allowlist())::oid::text as oid')).rows;
  return new Set(rows.map((row) => String(row.oid)));
}

/** 直接の書き手と、書き手を呼ぶ関数（推移的）。名前は schema.name で見る（overload も同じ名前なら呼び手に入れる） */
function analyze(procs: Proc[]) {
  const direct = new Set(procs.filter(isDirectWriter).map((proc) => proc.key));
  const closure = new Set(direct);
  for (let changed = true; changed;) {
    changed = false;
    const names = [...new Set(procs.filter((proc) => closure.has(proc.key)).map((proc) => `${proc.schema}.${proc.name}`))];
    for (const proc of procs) {
      if (closure.has(proc.key)) continue;
      const code = normalize(proc.src, true);
      if (names.some((name) => new RegExp(String.raw`\b${name.replace('.', String.raw`\s*\.\s*`)}\s*\(`).test(code))) {
        closure.add(proc.key);
        changed = true;
      }
    }
  }
  return { direct, closure };
}

/** 同じ名前の private 本体へ委ねるだけの公開 SQL INVOKER か */
function isPublicDelegate(proc: Proc, allow: Set<string>, procs: Proc[]): boolean {
  if (proc.schema !== 'public' || proc.secdef || proc.language !== 'sql') return false;
  const body = normalize(proc.src, true).trim().replace(/;$/, '').trim();
  if (!new RegExp(String.raw`^select (?:\* from )?private\.${proc.name}\([^;]*\)(?: as [a-z_]+)?$`).test(body)) return false;
  return procs.some((other) => other.schema === 'private' && other.name === proc.name && allow.has(other.key));
}

describeLocalDb('integration: G-1 の書き手の閉じた一覧（pg_proc の走査）', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  test('一覧は決めた60本と同じ集合で、関数は postgres の SECURITY DEFINER・search_path 空・だれも EXECUTE できない', async () => {
    const expected = (await db().query('select to_regprocedure(s)::oid::text as oid, s from unnest($1::text[]) as s', [ALLOWLIST])).rows;
    expect(expected.filter((row) => row.oid === null).map((row) => row.s)).toEqual([]);
    expect(new Set(expected.map((row) => row.oid)).size).toBe(60);
    const actual = (await db().query('select unnest(private.group_g_writer_allowlist())::oid::text as oid')).rows.map((row) => row.oid);
    expect([...actual].sort()).toEqual(expected.map((row) => row.oid).sort());
    const fn = (await db().query(`select p.proowner::regrole::text as owner, p.prosecdef, p.proconfig, p.provolatile,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_execute
      from pg_proc p where p.oid = 'private.group_g_writer_allowlist()'::regprocedure`)).rows[0];
    expect(fn).toEqual({
      owner: 'postgres', prosecdef: true, proconfig: ['search_path=""'], provolatile: 's',
      anon: false, authenticated: false, service_role: false, public_execute: false,
    });
  });

  test('直接の書き手（INSERT/UPDATE/DELETE/MERGE/TRUNCATE・在庫数の UPDATE・表を指す動的 EXECUTE）は一覧の中だけ', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    const { direct } = analyze(procs);
    const outside = procs.filter((proc) => direct.has(proc.key) && !allow.has(proc.key)).map((proc) => `${proc.schema}.${proc.name}(${proc.identity})`);
    expect(outside).toEqual([]);
    // 走査が書き手を見つけていること（空の集合で通らない）
    for (const name of ['private.allocate_group_g_fifo', 'private.apply_group_g_stock_movement', 'private.apply_tracking_status',
      'private.record_group_g_item_state_changes', 'private.admin_record_stock_movement']) {
      expect({ name, found: procs.some((proc) => `${proc.schema}.${proc.name}` === name && direct.has(proc.key)) }).toEqual({ name, found: true });
    }
    // 止めた旧の6本は何も書かない
    const stopped = (await db().query('select to_regprocedure(s)::oid::text as oid from unnest($1::text[]) as s', [STOPPED])).rows;
    for (const row of stopped) expect(direct.has(String(row.oid))).toBe(false);
  });

  test('書き手を PERFORM・SELECT・:= で呼ぶ関数は、一覧の中か、同じ名前の private 本体へ委ねるだけの公開 SQL INVOKER', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    const { closure } = analyze(procs);
    const outside = procs
      .filter((proc) => closure.has(proc.key) && !allow.has(proc.key) && !isPublicDelegate(proc, allow, procs))
      .map((proc) => `${proc.schema}.${proc.name}(${proc.identity})`);
    expect(outside).toEqual([]);
    expect(procs.filter((proc) => closure.has(proc.key) && isPublicDelegate(proc, allow, procs)).length).toBeGreaterThan(20);
  });

  test('走査は、試験用の overload・PERFORM/SELECT/:= の呼び手・引用符の名前・注釈を挟んだ文・動的 EXECUTE を未許可として見つける（取引は戻す）', async () => {
    await db().query('savepoint probes');
    try {
      await db().query(`create function private.allocate_group_g_fifo(_probe uuid) returns void language plpgsql as $$
        begin insert into public.stock_movements (variant_id, delta, reason) values (1, 1, 'restock'); end; $$`);
      await db().query(`create function private.g1_probe_perform() returns void language plpgsql as $$
        begin perform private.allocate_group_g_fifo(null::uuid); end; $$`);
      await db().query(`create function private.g1_probe_select() returns integer language plpgsql as $$
        declare v integer; begin select private.allocate_group_g_fifo(array[1]::bigint[], null, null) into v; return v; end; $$`);
      await db().query(`create function private.g1_probe_assign() returns integer language plpgsql as $$
        declare v integer; begin v := private.allocate_group_g_fifo(array[1]::bigint[], null, null); return v; end; $$`);
      await db().query(`create function private.g1_probe_quoted() returns void language plpgsql as $$
        begin update "public"."order_item_allocations" set version = version where false; end; $$`);
      await db().query(`create function private.g1_probe_comment() returns void language plpgsql as $$
        begin delete /* note */ from
          public.order_item_state_events where false; end; $$`);
      await db().query(`create function private.g1_probe_stock() returns void language plpgsql as $$
        begin update public.item_variants as v set updated_at = now(), stock_quantity = v.stock_quantity where false; end; $$`);
      await db().query(`create function private.g1_probe_dynamic() returns void language plpgsql as $$
        begin execute 'insert into public.order_fulfillments default values'; end; $$`);
      await db().query(`create function public.g1_probe_sql() returns void language sql as $$
        insert into private.group_g_operations (id) select null::uuid where false; $$`);

      const procs = await loadProcs(db());
      const allow = await allowlistOids(db());
      const { direct, closure } = analyze(procs);
      const outside = (set: Set<string>) => procs.filter((proc) => set.has(proc.key) && !allow.has(proc.key)
        && !isPublicDelegate(proc, allow, procs)).map((proc) => `${proc.schema}.${proc.name}(${proc.identity})`).sort();
      expect(outside(direct)).toEqual([
        'private.allocate_group_g_fifo(_probe uuid)', 'private.g1_probe_comment()', 'private.g1_probe_dynamic()',
        'private.g1_probe_quoted()', 'private.g1_probe_stock()', 'public.g1_probe_sql()',
      ]);
      expect(outside(closure)).toEqual([
        'private.allocate_group_g_fifo(_probe uuid)', 'private.g1_probe_assign()', 'private.g1_probe_comment()',
        'private.g1_probe_dynamic()', 'private.g1_probe_perform()', 'private.g1_probe_quoted()', 'private.g1_probe_select()',
        'private.g1_probe_stock()', 'public.g1_probe_sql()',
      ]);
      // 試験用の overload は一覧の OID に入らない（名前だけの一致で許さない）
      const probe = (await db().query("select to_regprocedure('private.allocate_group_g_fifo(uuid)')::oid::text as oid")).rows[0].oid;
      expect(allow.has(String(probe))).toBe(false);
    } finally {
      await db().query('rollback to savepoint probes');
    }
    expect((await db().query("select to_regprocedure('private.allocate_group_g_fifo(uuid)') as fn")).rows[0].fn).toBeNull();
  });

  test('旧の返品の入口7本は、private の DEFINER 本体が共通の押さえを返品の行より先に取り、公開は SQL INVOKER の委譲だけ', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    for (const name of LEGACY_RETURN_ENTRIES) {
      const body = procs.filter((proc) => proc.schema === 'private' && proc.name === name);
      const entry = procs.filter((proc) => proc.schema === 'public' && proc.name === name);
      expect({ name, bodies: body.length, entries: entry.length }).toEqual({ name, bodies: 1, entries: 1 });
      expect({ name, definer: body[0].secdef, allowed: allow.has(body[0].key) }).toEqual({ name, definer: true, allowed: true });
      const code = normalize(body[0].src, true);
      const lock = code.indexOf('private.lock_group_g_inventory(');
      const returnRow = code.indexOf('private.lock_order_return(');
      expect({ name, lock: lock >= 0, beforeReturnRow: returnRow < 0 || lock < returnRow }).toEqual({ name, lock: true, beforeReturnRow: true });
      expect({ name, delegate: isPublicDelegate(entry[0], allow, procs) }).toEqual({ name, delegate: true });
      const config = (await db().query('select proconfig from pg_proc where oid = $1', [entry[0].oid])).rows[0].proconfig;
      expect(config).toEqual(['search_path=""']);
    }
  });

  test('閉包を前提にする helper（customer_order_for_request の鍵あり・lock_order_cancel_request・lock_order_return）の呼び手は、先に共通の押さえを取る一覧の本体だけ', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    const helpers = ['private.customer_order_for_request', 'private.lock_order_cancel_request', 'private.lock_order_return'];
    const problems: string[] = [];
    for (const proc of procs) {
      const code = normalize(proc.src, true);
      for (const helper of helpers) {
        const calls = [...code.matchAll(new RegExp(String.raw`${helper.replace('.', String.raw`\.`)}\(([^;]*?)\)`, 'g'))];
        if (calls.length === 0 || `${proc.schema}.${proc.name}` === helper) continue;
        // 鍵なしの読み（customer_order_for_request の3つ目が false）は前提を持たない
        const locking = calls.filter((call) => helper !== 'private.customer_order_for_request' || !/,\s*false\s*$/.test(call[1]));
        if (locking.length === 0) continue;
        const lock = code.indexOf('private.lock_group_g_inventory(');
        const ok = allow.has(proc.key) && proc.secdef && lock >= 0 && locking.every((call) => lock < (call.index ?? 0));
        if (!ok) problems.push(`${proc.schema}.${proc.name}(${proc.identity}) -> ${helper}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('台帳のトリガーの本体は、共通の押さえが無い在庫の変更を GROUP_G_INVENTORY_LOCK_REQUIRED で断り、押さえがあれば動かす', async () => {
    const definition = normalize((await db().query(
      "select prosrc from pg_proc where oid = 'private.apply_group_g_stock_movement(bigint,integer)'::regprocedure",
    )).rows[0].prosrc, false);
    expect(definition).toContain("l.locktype = 'advisory' and l.classid = 190521 and l.objid = 1 and l.objsubid = 2");
    expect(definition).toContain('group_g_inventory_lock_required');
    expect(definition.indexOf('pg_locks')).toBeLessThan(definition.indexOf('update public.item_variants'));

    const variant = Number((await db().query(`insert into public.items (name, description, price, category, image_url, status)
      values ('g1-writer-probe', 'probe', 1000, 'TOPS', 'https://example.com/i.png', 'published') returning id`)).rows[0].id);
    const color = (await db().query("insert into public.item_colors (item_id, name, hex, position) values ($1, 'BLACK', '#000000', 0) returning id", [variant])).rows[0].id;
    const size = (await db().query("insert into public.item_sizes (item_id, label, position) values ($1, 'M', 0) returning id", [variant])).rows[0].id;
    const variantId = Number((await db().query(
      'insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, true) returning id', [variant, color, size],
    )).rows[0].id);
    await db().query('savepoint no_lock');
    await expect(db().query("insert into public.stock_movements (variant_id, delta, reason) values ($1, 1, 'restock')", [variantId]))
      .rejects.toMatchObject({ code: '55000', message: 'GROUP_G_INVENTORY_LOCK_REQUIRED' });
    await db().query('rollback to savepoint no_lock');
    expect(Number((await db().query('select stock_quantity from public.item_variants where id = $1', [variantId])).rows[0].stock_quantity)).toBe(0);

    await db().query('select pg_catalog.pg_advisory_xact_lock(190521, 1)');
    await db().query("insert into public.stock_movements (variant_id, delta, reason) values ($1, 2, 'restock')", [variantId]);
    expect(Number((await db().query('select stock_quantity from public.item_variants where id = $1', [variantId])).rows[0].stock_quantity)).toBe(2);
    // 材料の道具（createCatalogFixture）も押さえの下で入荷を書く
    const fx = await createCatalogFixture(db(), { stock: 3 });
    expect(Number((await db().query('select stock_quantity from public.item_variants where id = $1', [fx.variantId])).rows[0].stock_quantity)).toBe(3);
  });
});
