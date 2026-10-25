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
 * 60本に、G-2 Task 7 で受け取り private.admin_receive_purchase_order と受け取りの取消・数量訂正
 * private.admin_reverse_purchase_order_receipt を足した62本に、G-2 Task 8 で原本の予約 private.admin_reserve_purchase_order_attachment、
 * 確定 private.admin_attach_purchase_order_document、訂正・無効化 private.admin_revise_purchase_order_document を足した65本
 * （G-2 の Task 9 で閉じた。書き手は65本のまま）に、G-3 Task 4 で発送票の下書きの保存 private.admin_save_shipment_slip_draft と
 * 破棄 private.admin_discard_shipment_slip_draft の2本、Task 5でconsume・register・confirmの3本、Task 6で restore・cancel の2本を足した72本（G-3 の以降の Task が書き手を足すたびに本数が増える）。
 * 走査する表には G-2 の発注書の9表を足した（TABLES）。
 * G-2 Task 9（FREQ-540-AC-08）: 新しい書込み関数9本とその公開入口9本・内部の道具4本・読取4本の構造（private・SECURITY DEFINER・
 * search_path 空・EXECUTE の集合）と、各本体が共通の押さえ lock_group_g_purchase_orders を発注書の表・item_variants・
 * stock_movements への最初の参照より前に呼ぶ順を、pg_proc の prosrc で確かめる。
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
  'private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)',
  'private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)',
  'private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)',
  'private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)',
  'private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)',
  'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
  'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
  'private.consume_group_g_allocations(uuid,integer,uuid,uuid)',
  'private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)',
  'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
  'private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)',
  'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)',
];

const STOPPED = ALLOWLIST.slice(47, 53);

/** 旧の返品の入口7本（Task 10 レビュー）: private の DEFINER 本体が共通の押さえを取り、公開は INVOKER の委譲だけ */
const LEGACY_RETURN_ENTRIES = [
  'admin_receive_return', 'admin_refund_return', 'admin_inspect_return', 'admin_close_return_missing',
  'admin_reopen_return', 'admin_record_return_fee_payment', 'admin_release_return_exchange',
];

/** G-2 の発注書の9表。G-1 の7表と同じ走査で、書く関数は閉じた一覧の中だけにあることを見る */
const PURCHASE_TABLES = [
  'purchase_orders', 'purchase_order_lines', 'purchase_order_revisions', 'purchase_order_short_closures',
  'purchase_order_receipts', 'purchase_order_receipt_lines', 'purchase_order_attachment_reservations',
  'purchase_order_attachments', 'purchase_order_attachment_revisions',
];

const TABLES = [
  'shipment_slips', 'shipment_slip_lines', 'shipment_slip_fulfillments',
  'shipment_slip_versions', 'shipment_date_history', 'shipment_tracking_registrations',
  'stock_movements', 'order_fulfillments', 'order_item_completions', 'order_item_allocations',
  'order_item_allocation_events', 'order_item_state_events', 'group_g_operations',
  ...PURCHASE_TABLES,
];

/** G-2 の書込み関数9本（private の本体と public の入口が同名）・読取4本・内部の道具4本・追記専用の表を守る trigger 関数3本 */
const PURCHASE_WRITER_NAMES = [
  'admin_create_purchase_order', 'admin_update_purchase_order_header', 'admin_confirm_purchase_order_quantities',
  'admin_short_close_purchase_order', 'admin_receive_purchase_order', 'admin_reverse_purchase_order_receipt',
  'admin_reserve_purchase_order_attachment', 'admin_attach_purchase_order_document', 'admin_revise_purchase_order_document',
];
const PURCHASE_READER_NAMES = ['list_admin_inventory', 'list_admin_purchase_order_lines', 'get_admin_purchase_order', 'search_purchase_order_documents'];
const PURCHASE_INTERNAL_NAMES = ['lock_group_g_purchase_orders', 'group_g_actor_has_permissions', 'group_g_open_work_order_ids', 'purchase_order_display_stages'];
const PURCHASE_TRIGGER_NAMES = ['guard_group_g_purchase_order_change', 'check_purchase_order_receipt_line', 'check_purchase_order_line_received'];

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

  test('一覧は決めた72本と同じ集合で、関数は postgres の SECURITY DEFINER・search_path 空・だれも EXECUTE できない', async () => {
    const expected = (await db().query('select to_regprocedure(s)::oid::text as oid, s from unnest($1::text[]) as s', [ALLOWLIST])).rows;
    expect(expected.filter((row) => row.oid === null).map((row) => row.s)).toEqual([]);
    expect(new Set(expected.map((row) => row.oid)).size).toBe(72);
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

  // ---- G-2 Task 9（FREQ-540-AC-08）: 発注書の関数の構造 ----

  /** 関数 1 本の所有者・SECURITY・search_path と、EXECUTE の有無（意味で見る。PUBLIC は有効な ACL から読む） */
  async function aclOf(oid: string) {
    return (await db().query(`select p.proowner::regrole::text as owner, p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
      from pg_proc p where p.oid = $1::oid`, [oid])).rows[0];
  }
  const NO_ONE = { anon: false, authenticated: false, service_role: false, public_execute: false };
  const SERVICE_ROLE_ONLY = { anon: false, authenticated: false, service_role: true, public_execute: false };

  test('FREQ-540-AC-10: 発送の読取5本と内部の道具3本は書き手でなく、許可一覧（G-3 Task 6 で72本）を増やさない', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    const { direct, closure } = analyze(procs);
    expect(ALLOWLIST).toHaveLength(72);
    const readers = ['list_admin_packing', 'list_admin_shipment_slips', 'get_admin_shipment_slip',
      'list_admin_order_shipment_slips', 'list_shipment_accounting_inputs'];
    const internal = ['group_g_shipment_ready', 'group_g_bundle_verdict', 'group_g_bundle_key'];
    for (const name of [...readers, ...internal]) {
      const found = procs.filter((proc) => ['private', 'public'].includes(proc.schema) && proc.name === name);
      expect({ name, count: found.length }).toEqual({ name, count: readers.includes(name) ? 2 : 1 });
      for (const fn of found) {
        expect({ name, schema: fn.schema, writer: direct.has(fn.key), closure: closure.has(fn.key), allowed: allow.has(fn.key),
          acl: await aclOf(fn.oid) }).toEqual({ name, schema: fn.schema, writer: false, closure: false, allowed: false,
          acl: { owner: 'postgres', prosecdef: fn.schema === 'private', proconfig: ['search_path=""'],
            ...(readers.includes(name) ? SERVICE_ROLE_ONLY : NO_ONE) } });
        if (fn.schema === 'public') {
          expect(fn.language).toBe('sql');
          expect(normalize(fn.src, true).trim()).toMatch(new RegExp(`^select (?:\\* from )?private\\.${name}\\([^;]*\\);?$`));
        }
      }
    }
    const actual = procs.filter((p) => [...readers, ...internal].includes(p.name)
      && ['public', 'private'].includes(p.schema));
    const executable: string[] = [];
    for (const p of actual) if ((await aclOf(p.oid)).service_role) executable.push(p.oid);
    expect(executable.sort()).toEqual(actual.filter((p) => readers.includes(p.name)).map((p) => p.oid).sort());
    expect(executable).toHaveLength(10);
  });

  test('FREQ-540-AC-08: 発注の書込み関数9本は private の SECURITY DEFINER・search_path 空で閉じた一覧の中にあり、public の入口9本は同名 private へ委ねるだけの SQL INVOKER。どちらも service_role だけが EXECUTE できる', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    for (const name of PURCHASE_WRITER_NAMES) {
      const bodies = procs.filter((proc) => proc.schema === 'private' && proc.name === name);
      const entries = procs.filter((proc) => proc.schema === 'public' && proc.name === name);
      expect({ name, bodies: bodies.length, entries: entries.length }).toEqual({ name, bodies: 1, entries: 1 });
      // 走査が本体を書き手として見つけ（空振りで通らない）、閉じた一覧に載っている。入口は何も書かず、一覧に載らない
      expect({ name, definer: bodies[0].secdef, allowed: allow.has(bodies[0].key), writer: isDirectWriter(bodies[0]) })
        .toEqual({ name, definer: true, allowed: true, writer: true });
      expect({ name, delegate: isPublicDelegate(entries[0], allow, procs), writer: isDirectWriter(entries[0]), allowed: allow.has(entries[0].key) })
        .toEqual({ name, delegate: true, writer: false, allowed: false });
      expect({ name, acl: await aclOf(bodies[0].oid) })
        .toEqual({ name, acl: { owner: 'postgres', prosecdef: true, proconfig: ['search_path=""'], ...SERVICE_ROLE_ONLY } });
      expect({ name, acl: await aclOf(entries[0].oid) })
        .toEqual({ name, acl: { owner: 'postgres', prosecdef: false, proconfig: ['search_path=""'], ...SERVICE_ROLE_ONLY } });
    }
  });

  test('FREQ-540-AC-08: 内部の道具4本と trigger 関数3本は誰も（service_role も）EXECUTE できず何も書かない。読取4本は private の本体と public の入口の両方を service_role だけが EXECUTE できて何も書かない', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    for (const name of PURCHASE_INTERNAL_NAMES) {
      const found = procs.filter((proc) => proc.schema === 'private' && proc.name === name);
      expect({ name, count: found.length }).toEqual({ name, count: 1 });
      expect({ name, acl: await aclOf(found[0].oid), writer: isDirectWriter(found[0]), allowed: allow.has(found[0].key) })
        .toEqual({ name, acl: { owner: 'postgres', prosecdef: true, proconfig: ['search_path=""'], ...NO_ONE }, writer: false, allowed: false });
    }
    // trigger 関数: 守りの関数だけ INVOKER（G-2 の移行の本文のとおり）
    for (const [name, definer] of [['guard_group_g_purchase_order_change', false], ['check_purchase_order_receipt_line', true], ['check_purchase_order_line_received', true]] as const) {
      const found = procs.filter((proc) => proc.schema === 'private' && proc.name === name);
      expect({ name, count: found.length }).toEqual({ name, count: 1 });
      expect({ name, acl: await aclOf(found[0].oid), writer: isDirectWriter(found[0]), allowed: allow.has(found[0].key) })
        .toEqual({ name, acl: { owner: 'postgres', prosecdef: definer, proconfig: ['search_path=""'], ...NO_ONE }, writer: false, allowed: false });
    }
    for (const name of PURCHASE_READER_NAMES) {
      const bodies = procs.filter((proc) => proc.schema === 'private' && proc.name === name);
      const entries = procs.filter((proc) => proc.schema === 'public' && proc.name === name);
      expect({ name, bodies: bodies.length, entries: entries.length }).toEqual({ name, bodies: 1, entries: 1 });
      expect({ name, body: await aclOf(bodies[0].oid), writer: isDirectWriter(bodies[0]), allowed: allow.has(bodies[0].key) })
        .toEqual({ name, body: { owner: 'postgres', prosecdef: true, proconfig: ['search_path=""'], ...SERVICE_ROLE_ONLY }, writer: false, allowed: false });
      expect({ name, entry: await aclOf(entries[0].oid), language: entries[0].language, writer: isDirectWriter(entries[0]) })
        .toEqual({ name, entry: { owner: 'postgres', prosecdef: false, proconfig: ['search_path=""'], ...SERVICE_ROLE_ONLY }, language: 'sql', writer: false });
    }
  });

  test('FREQ-540-AC-08: service_role が EXECUTE できる発注書の関数は、書込みの本体9本とその入口9本・読取の本体4本とその入口4本の26本だけ（同名の別の overload が増えれば見つかる）', async () => {
    const names = [...PURCHASE_WRITER_NAMES, ...PURCHASE_READER_NAMES, ...PURCHASE_INTERNAL_NAMES, ...PURCHASE_TRIGGER_NAMES];
    const actual = (await db().query(`select p.oid::text as oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.proname = any($1::text[]) and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    [names])).rows.map((row) => String(row.oid)).sort();
    const procs = await loadProcs(db());
    const expected = procs.filter((proc) => [...PURCHASE_WRITER_NAMES, ...PURCHASE_READER_NAMES].includes(proc.name)).map((proc) => proc.oid).sort();
    expect(expected).toHaveLength(26);
    expect(actual).toEqual(expected);
    // 内部の道具・trigger 関数は同名の overload も含めて 1 本ずつ（増えていない）
    for (const name of [...PURCHASE_INTERNAL_NAMES, ...PURCHASE_TRIGGER_NAMES]) {
      expect({ name, count: procs.filter((proc) => proc.name === name && ['public', 'private'].includes(proc.schema)).length }).toEqual({ name, count: 1 });
    }
  });

  test('FREQ-540-AC-08: 発注の書込み本体9本は、共通の押さえ lock_group_g_purchase_orders を、発注書の表・item_variants・stock_movements への最初の参照より前に呼ぶ（先にあるのは引数の検証だけ）', async () => {
    const procs = await loadProcs(db());
    const CALL = 'lock_group_g_purchase_orders';
    for (const name of PURCHASE_WRITER_NAMES) {
      const body = procs.find((proc) => proc.schema === 'private' && proc.name === name)!;
      const code = normalize(body.src, true);
      const firstCall = code.indexOf(`${CALL}(`);
      // 呼び出し名の purchase_orders を表の参照に取り違えないよう、名前を同じ長さの空白に替えてから探す（位置は動かない）
      const withoutCall = code.split(CALL).join(' '.repeat(CALL.length));
      const references = [...withoutCall.matchAll(/\b(?:from|join|into|update)\s+(?:public\.)?(purchase_[a-z_]+|item_variants|stock_movements)\b/g)];
      // 空振りで通らない: 押さえの呼び出しがあり、表の参照も 1 つ以上ある
      expect({ name, called: firstCall >= 0, references: references.length > 0 }).toEqual({ name, called: true, references: true });
      expect({ name, lockFirst: firstCall < (references[0].index ?? -1) }).toEqual({ name, lockFirst: true });
    }
  });

  test('FREQ-540-AC-08: 走査は、発注書の9表へ書く試験用の関数を未許可として見つけ、読むだけ・FOR UPDATE だけの関数は書き手にしない（取引は戻す）', async () => {
    await db().query('savepoint g2_probes');
    try {
      const statements = ['insert into public.@ default values', 'update public.@ set id = id where false', 'delete from public.@ where false', 'truncate public.@'];
      for (const [index, table] of PURCHASE_TABLES.entries()) {
        await db().query(`create function private.g2_probe_write_${index}() returns void language plpgsql as $$
          begin ${statements[index % statements.length].replace('@', table)}; end; $$`);
      }
      await db().query(`create function private.g2_probe_lock() returns uuid language sql as $$
        select id from public.purchase_orders order by id limit 1 for update $$`);
      await db().query(`create function private.g2_probe_read() returns bigint language sql as $$
        select count(*) from public.purchase_orders po join public.purchase_order_lines l on l.purchase_order_id = po.id $$`);

      const procs = await loadProcs(db());
      const allow = await allowlistOids(db());
      const { direct, closure } = analyze(procs);
      const outside = (set: Set<string>) => procs.filter((proc) => set.has(proc.key) && !allow.has(proc.key)
        && !isPublicDelegate(proc, allow, procs)).map((proc) => `${proc.schema}.${proc.name}`).sort();
      const probes = PURCHASE_TABLES.map((_, index) => `private.g2_probe_write_${index}`).sort();
      expect(outside(direct)).toEqual(probes);
      expect(outside(closure)).toEqual(probes);
    } finally {
      await db().query('rollback to savepoint g2_probes');
    }
    expect((await db().query("select to_regprocedure('private.g2_probe_write_0()') as fn")).rows[0].fn).toBeNull();
  });

  // ---- G-3 Task 4・5・6（FREQ-540-AC-10・AC-11）: 発送票の下書き・確定・取消の書き手 ----

  const SLIP_WRITER_NAMES = ['admin_save_shipment_slip_draft', 'admin_discard_shipment_slip_draft', 'admin_confirm_shipment_slip', 'admin_cancel_shipment_slip'];
  const SLIP_LOCK = 'lock_group_g_shipment_slips';

  test('FREQ-540-AC-11: 発送票の書込み関数4本は private の SECURITY DEFINER・search_path 空で閉じた一覧の中にあり、public の入口4本は同名 private へ委ねるだけの SQL INVOKER。それぞれ service_role だけが EXECUTE できる', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    for (const name of SLIP_WRITER_NAMES) {
      const bodies = procs.filter((proc) => proc.schema === 'private' && proc.name === name);
      const entries = procs.filter((proc) => proc.schema === 'public' && proc.name === name);
      expect({ name, bodies: bodies.length, entries: entries.length }).toEqual({ name, bodies: 1, entries: 1 });
      expect({ name, definer: bodies[0].secdef, allowed: allow.has(bodies[0].key), writer: isDirectWriter(bodies[0]) })
        .toEqual({ name, definer: true, allowed: true, writer: true });
      expect({ name, delegate: isPublicDelegate(entries[0], allow, procs), writer: isDirectWriter(entries[0]), allowed: allow.has(entries[0].key) })
        .toEqual({ name, delegate: true, writer: false, allowed: false });
      expect({ name, acl: await aclOf(bodies[0].oid) })
        .toEqual({ name, acl: { owner: 'postgres', prosecdef: true, proconfig: ['search_path=""'], ...SERVICE_ROLE_ONLY } });
      expect({ name, acl: await aclOf(entries[0].oid) })
        .toEqual({ name, acl: { owner: 'postgres', prosecdef: false, proconfig: ['search_path=""'], ...SERVICE_ROLE_ONLY } });
    }
  });

  test('FREQ-540-AC-11: 発送票の押さえの道具は誰も（service_role も）EXECUTE できず、書き手でも一覧の中でもなく、1本だけ', async () => {
    const procs = await loadProcs(db());
    const allow = await allowlistOids(db());
    const found = procs.filter((proc) => ['private', 'public'].includes(proc.schema) && proc.name === SLIP_LOCK);
    expect(found.map((proc) => `${proc.schema}.${proc.name}(${proc.identity})`)).toEqual(['private.lock_group_g_shipment_slips(_slip_ids uuid[], _order_item_ids uuid[], _with_settings boolean)']);
    expect({ acl: await aclOf(found[0].oid), writer: isDirectWriter(found[0]), allowed: allow.has(found[0].key) })
      .toEqual({ acl: { owner: 'postgres', prosecdef: true, proconfig: ['search_path=""'], ...NO_ONE }, writer: false, allowed: false });
    // service_role が EXECUTE できる発送票の書込みの関数は、書込みの本体4本とその入口4本だけ（consume・register・restore の内部の道具は誰も EXECUTE できない）
    const executable = (await db().query(`select p.oid::text as oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.proname = any($1::text[]) and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    [[...SLIP_WRITER_NAMES, SLIP_LOCK, 'consume_group_g_allocations', 'register_group_g_slip_tracking', 'restore_group_g_shipment']])).rows.map((row) => String(row.oid)).sort();
    expect(executable).toEqual(procs.filter((proc) => SLIP_WRITER_NAMES.includes(proc.name)).map((proc) => proc.oid).sort());
    expect(executable).toHaveLength(8);
  });

  test('FREQ-540-AC-11: 発送票の書込み本体4本は、共通の押さえ lock_group_g_shipment_slips を、発送票・注文・操作の記録の表への最初の参照より前に呼び、押さえの道具は共通の advisory を最初の文にする', async () => {
    const procs = await loadProcs(db());
    for (const name of SLIP_WRITER_NAMES) {
      const body = procs.find((proc) => proc.schema === 'private' && proc.name === name)!;
      const code = normalize(body.src, true);
      const firstCall = code.indexOf(`${SLIP_LOCK}(`);
      const withoutCall = code.split(SLIP_LOCK).join(' '.repeat(SLIP_LOCK.length));
      const references = [...withoutCall.matchAll(/\b(?:from|join|into|update)\s+(?:public\.|private\.)(shipment_slips?|shipment_slip_[a-z_]+|order_items|orders|group_g_operations)\b/g)];
      expect({ name, called: firstCall >= 0, references: references.length > 0 }).toEqual({ name, called: true, references: true });
      expect({ name, lockFirst: firstCall < (references[0].index ?? -1) }).toEqual({ name, lockFirst: true });
    }
    const helper = procs.find((proc) => proc.schema === 'private' && proc.name === SLIP_LOCK)!;
    expect(helper.src).toMatch(/BEGIN\s+PERFORM pg_catalog\.pg_advisory_xact_lock\(190521,1\);/);
  });
});
