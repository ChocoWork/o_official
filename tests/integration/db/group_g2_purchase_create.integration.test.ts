/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines } from './helpers/order-fixtures';
import { seedGroupG1Allocation } from './helpers/group-g1-fixtures';

/**
 * G-2 Task 4（FREQ-526・FREQ-540-AC-07）: 発注の作成 private.admin_create_purchase_order とその公開入口、ロック helper
 * private.lock_group_g_purchase_orders、書き手の閉じた一覧の置き換え。
 * 発注確定で発注書1件・明細N件・版1・段階 ordered・仮数量・名称の写し・revision(order)・操作の記録が一度に保存され、
 * 在庫・割当・台帳・注文は動かない。同じ request_key と同じ内容の再送は同じ発注書を返す。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 * 発注書は削除できないので、番号の期待は「その日の最大 + 1」で書く（空の DB なら 0001）。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const files = (suffix: string) => fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith(suffix));
const FOUNDATION_FILE = files('_group_g2_purchasing_foundation.sql');
const WRITERS_FILE = files('_group_g2_purchasing_writers.sql');
const G1_FILE = files('_group_g1_allocation.sql');
const WRITERS_SQL = WRITERS_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, WRITERS_FILE[0]), 'utf8') : '';
const G1_SQL = G1_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, G1_FILE[0]), 'utf8') : '';

const CREATE_SIGNATURE = 'admin_create_purchase_order(text,text,jsonb,uuid,uuid)';
const PRIVATE_CREATE = `private.${CREATE_SIGNATURE}`;
const PUBLIC_CREATE = `public.${CREATE_SIGNATURE}`;
const LOCK_SIGNATURE = 'private.lock_group_g_purchase_orders(uuid[],boolean)';
const FORBIDDEN = { code: '42501', message: 'GROUP_G_FORBIDDEN' };
const INVALID = { code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' };
const CONFLICT = { code: '23505', message: 'GROUP_G_REQUEST_KEY_CONFLICT' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** コメントの行を外した本文（コメント内の語を拾わないため） */
const withoutComments = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const WRITERS_CODE = withoutComments(WRITERS_SQL);

/** CREATE FUNCTION <name>( から、その ALTER FUNCTION までの本文 */
function functionText(code: string, createPrefix: string, alterPrefix: string): string {
  const start = code.indexOf(createPrefix);
  const end = code.indexOf(alterPrefix, start);
  return start >= 0 && end > start ? code.slice(start, end) : '';
}
const LOCK_FUNCTION = functionText(WRITERS_CODE, 'CREATE FUNCTION private.lock_group_g_purchase_orders(', 'ALTER FUNCTION private.lock_group_g_purchase_orders(');
const CREATE_FUNCTION = functionText(WRITERS_CODE, 'CREATE FUNCTION private.admin_create_purchase_order(', 'ALTER FUNCTION private.admin_create_purchase_order(');

/** 書き手の一覧の中の署名 */
function allowlistOf(code: string, createPrefix: string): string[] {
  const create = code.indexOf(createPrefix);
  const start = create < 0 ? -1 : code.indexOf('SELECT ARRAY[', create);
  const end = code.indexOf(']::pg_catalog.regprocedure[]', start);
  return start >= 0 && end > start ? [...code.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
}

describe('G-2 writers migration の発注作成の節（DB なし）', () => {
  test('FREQ-526-AC-02: 移行は foundation の後ろに並び、BEGIN / COMMIT を1組だけ持ち、節の印と通知を持つ（UTF-8・BOMなし・LF・ASCII のみ）', () => {
    expect(FOUNDATION_FILE).toHaveLength(1);
    expect(WRITERS_FILE).toHaveLength(1);
    expect(WRITERS_FILE[0] > FOUNDATION_FILE[0]).toBe(true);
    expect(WRITERS_FILE[0]).toMatch(/^\d{14}_group_g2_purchasing_writers\.sql$/);
    expect(WRITERS_SQL.charCodeAt(0)).not.toBe(0xfeff);
    expect(WRITERS_SQL).not.toContain('\r');
    expect(WRITERS_SQL).toMatch(/^[\x00-\x7f]*$/);
    expect(WRITERS_CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(WRITERS_CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(WRITERS_CODE.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';\nCOMMIT;")).toBe(true);
    const order = ['-- G2B_BODY_BEGIN', '-- G2B_BODY_END', '-- G2B_FINAL_ASSERT_BEGIN', '-- G2B_FINAL_ASSERT_END'].map((marker) => WRITERS_SQL.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(WRITERS_CODE).not.toMatch(/ON SCHEMA\s+private/i);
  });

  test('FREQ-526-AC-02: ロック helper は最初の文が pg_advisory_xact_lock(190521,1) で、在庫の閉包（advisory の後に読んだ variant）→ 発注書 → 明細の順に取り、SKIP LOCKED を使わない', () => {
    expect(LOCK_FUNCTION).not.toBe('');
    expect(LOCK_FUNCTION).toContain('LANGUAGE plpgsql SECURITY DEFINER SET search_path = \'\'');
    expect(LOCK_FUNCTION.match(/\bBEGIN\s+([^;]+;)/)?.[1]).toBe('PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);');
    const advisory = LOCK_FUNCTION.indexOf('pg_advisory_xact_lock(190521,1)');
    const variantsRead = LOCK_FUNCTION.indexOf('FROM public.purchase_order_lines AS l WHERE l.purchase_order_id = ANY(_purchase_order_ids);');
    const inventory = LOCK_FUNCTION.indexOf('private.lock_group_g_inventory(v_variants, ARRAY[]::uuid[], NULL)');
    const orders = LOCK_FUNCTION.indexOf('FROM public.purchase_orders AS po WHERE po.id = ANY(_purchase_order_ids) ORDER BY po.id FOR UPDATE');
    const lines = LOCK_FUNCTION.indexOf('FROM public.purchase_order_lines AS l WHERE l.purchase_order_id = ANY(_purchase_order_ids) ORDER BY l.id FOR UPDATE');
    expect(advisory).toBeGreaterThan(0);
    expect([advisory, variantsRead, inventory, orders, lines].every((position) => position > 0)).toBe(true);
    expect(advisory).toBeLessThan(variantsRead);
    expect(variantsRead).toBeLessThan(inventory);
    expect(inventory).toBeLessThan(orders);
    expect(orders).toBeLessThan(lines);
    expect(LOCK_FUNCTION.indexOf('FOR UPDATE')).toBeGreaterThan(inventory);
    expect(LOCK_FUNCTION).not.toMatch(/SKIP\s+LOCKED/i);
    expect(WRITERS_CODE).toContain('REVOKE ALL ON FUNCTION private.lock_group_g_purchase_orders(uuid[],boolean) FROM PUBLIC, anon, authenticated, service_role;');
    expect(WRITERS_CODE).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+private\.lock_group_g_purchase_orders/i);
  });

  test('FREQ-526-AC-02: 作成関数の処理順は 引数検証 → ロック helper → 権限 → 指紋と再送 → variant の存在 → 番号（JST）→ INSERT → 操作の記録', () => {
    expect(CREATE_FUNCTION).not.toBe('');
    const positions = [
      CREATE_FUNCTION.indexOf("RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'"),
      CREATE_FUNCTION.indexOf('PERFORM private.lock_group_g_purchase_orders(ARRAY[]::uuid[], false);'),
      CREATE_FUNCTION.indexOf("private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read'])"),
      CREATE_FUNCTION.indexOf("op.operation = 'purchase_order_create' AND op.request_key = _request_key"),
      CREATE_FUNCTION.indexOf('FROM public.item_variants AS v'),
      CREATE_FUNCTION.indexOf("AT TIME ZONE 'Asia/Tokyo'"),
      CREATE_FUNCTION.indexOf('INSERT INTO public.purchase_orders('),
      CREATE_FUNCTION.indexOf('INSERT INTO public.purchase_order_lines('),
      CREATE_FUNCTION.indexOf('INSERT INTO public.purchase_order_revisions('),
      CREATE_FUNCTION.indexOf('INSERT INTO private.group_g_operations('),
    ];
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // 本体で最初に public / private の物に触れるのがロック helper の呼び出し（引数検証は表を読まない）
    const body = CREATE_FUNCTION.slice(CREATE_FUNCTION.indexOf('\nBEGIN\n'));
    expect(body.search(/\b(?:public|private)\./)).toBe(body.indexOf('private.lock_group_g_purchase_orders('));
    expect(CREATE_FUNCTION).toContain('SECURITY DEFINER SET search_path = \'\'');
  });

  test('FREQ-526-AC-02: 作成関数は在庫・割当・台帳・注文を書かず、読むのは variant・商品・色・サイズ・発注書・操作の受付だけ', () => {
    expect(CREATE_FUNCTION).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|MERGE)\b/);
    expect(CREATE_FUNCTION).not.toMatch(/\b(stock_movements|order_item_allocations|order_item_allocation_events|order_item_state_events|order_items|order_fulfillments)\b/);
    expect(CREATE_FUNCTION).not.toMatch(/\bpublic\.orders\b/);
    expect(CREATE_FUNCTION).not.toMatch(/\bstock_quantity\b/);
    const inserts = [...CREATE_FUNCTION.matchAll(/INSERT INTO ([a-z_.]+)/g)].map((match) => match[1]);
    expect(inserts).toEqual(['public.purchase_orders', 'public.purchase_order_lines', 'public.purchase_order_revisions', 'public.purchase_order_revisions', 'private.group_g_operations']);
  });

  test('FREQ-540-AC-07: private 本体と public 入口は service_role だけに EXECUTE を渡し、PUBLIC / anon / authenticated を個別に外す。public 入口は SQL の INVOKER 委譲', () => {
    for (const schema of ['private', 'public']) {
      expect(WRITERS_CODE).toContain(`ALTER FUNCTION ${schema}.${CREATE_SIGNATURE} OWNER TO postgres;`);
      expect(WRITERS_CODE).toContain(`REVOKE ALL ON FUNCTION ${schema}.${CREATE_SIGNATURE} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(WRITERS_CODE).toContain(`GRANT EXECUTE ON FUNCTION ${schema}.${CREATE_SIGNATURE} TO service_role;`);
    }
    const delegate = functionText(WRITERS_CODE, 'CREATE FUNCTION public.admin_create_purchase_order(', 'ALTER FUNCTION public.admin_create_purchase_order(');
    expect(delegate).toContain("LANGUAGE sql SECURITY INVOKER SET search_path = ''");
    expect(delegate).toContain('SELECT private.admin_create_purchase_order(_supplier_name, _memo, _lines, _actor_id, _request_key);');
  });

  test('FREQ-526-AC-02: 書き手の一覧は G-1 の56本を1文字も変えず、末尾に admin_create_purchase_order と Task 6 の3本（発注先・メモの訂正、数量の確定・訂正、残りの打切り）と Task 7 の2本（受け取り、受け取りの取消）を足した62本', () => {
    const g1 = allowlistOf(withoutComments(G1_SQL), 'CREATE FUNCTION private.group_g_writer_allowlist()');
    const next = allowlistOf(WRITERS_CODE, 'CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()');
    expect(g1).toHaveLength(56);
    expect(next).toEqual([
      ...g1, PRIVATE_CREATE,
      'private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)',
      'private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)',
      'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
      'private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)',
      'private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)',
    ]);
    expect(new Set(next).size).toBe(62);
    const header = functionText(WRITERS_CODE, 'CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()', 'SELECT ARRAY[');
    expect(header).toContain("LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''");
  });

  test('FREQ-540-AC-07: 最後の確かめに $g2b_final_objects$ と $g2b_final_table_acl$ を置き、62本・関数の ACL・PG17 の MAINTAIN を見る', () => {
    const section = WRITERS_SQL.slice(WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_BEGIN'), WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_END'));
    for (const tag of ['$g2b_final_objects$', '$g2b_final_table_acl$']) {
      expect(section.split(`DO ${tag}`)).toHaveLength(2);
      expect(section.split(`${tag};`)).toHaveLength(2);
    }
    for (const detail of ['purchase_writer_functions', 'purchase_writer_lock_order', 'purchase_writer_allowlist_missing', 'purchase_writer_allowlist', 'purchase_writer_table_acl']) {
      expect(section).toContain(`v_failed := '${detail}'`);
    }
    expect(section.match(/RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed/g)).toHaveLength(2);
    expect(section).toContain('<> 62');
    expect(section).not.toContain('<> 60');
    expect(section).not.toContain('<> 57');
    expect(section).toContain("ARRAY['MAINTAIN']");
    expect(section).toContain("pg_catalog.current_setting('server_version_num')::integer >= 170000");
    expect(section).toContain('COALESCE(p.proacl, pg_catalog.acldefault(\'f\', p.proowner))');
    expect(section).not.toMatch(/ON SCHEMA\s+private/i);
  });
});

describeLocalDb('integration: G-2 発注の作成', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  // ---- 共通の道具 ----

  async function createActor(roleCodes: readonly string[], options: { inactive?: readonly string[]; expired?: readonly string[] } = {}): Promise<string> {
    const actor = randomUUID();
    await db().query("insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values($1,'{}','{}')", [actor]);
    for (const roleCode of roleCodes) {
      await db().query(`insert into public.user_roles(user_id,role_id,active,expires_at)
        select $1::uuid,id,$3::boolean,case when $4::boolean then now() - interval '1 second' else null end
        from public.roles where code=$2::text`,
      [actor, roleCode, !(options.inactive ?? []).includes(roleCode), (options.expired ?? []).includes(roleCode)]);
    }
    return actor;
  }

  async function grant(role: string, codes: string[]) {
    const result = await db().query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p where r.code=$1 and p.code=any($2::text[])
      on conflict do nothing`, [role, codes]);
    expect(result.rowCount).toBe(codes.length);
  }

  async function revoke(role: string, codes: string[]) {
    await db().query(`delete from public.role_permissions where role_id=(select id from public.roles where code=$1)
      and permission_id in (select id from public.permissions where code=any($2::text[]))`, [role, codes]);
  }

  /** 店長（admin）は初期のまま admin.purchase_orders.manage と admin.purchase_orders.read を持つ */
  const manager = () => createActor(['admin']);

  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try { await run(); return {}; } catch (e) {
      const error = e as { code: string; message: string };
      return { code: error.code, message: error.message };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  type CreateArgs = {
    actor?: string | null; supplier?: string | null; memo?: string | null; lines?: unknown; key?: string | null; schema?: 'public' | 'private';
  };
  const lineOf = (variantId: number, quantity: number) => ({ variantId, quantity });

  async function create(args: CreateArgs) {
    const lines = args.lines === undefined ? null : JSON.stringify(args.lines);
    const result = await db().query(`select ${args.schema ?? 'public'}.admin_create_purchase_order($1, $2, $3::jsonb, $4, $5) as r`, [
      args.supplier === undefined ? '工場A' : args.supplier, args.memo === undefined ? null : args.memo, lines,
      args.actor === undefined ? null : args.actor, args.key === undefined ? randomUUID() : args.key,
    ]);
    return result.rows[0].r as { id: string; number: string; version: number; replayed: boolean };
  }

  const snapshot = async () => (await db().query(`select
    (select count(*) from public.purchase_orders)::int as orders,
    (select count(*) from public.purchase_order_lines)::int as lines,
    (select count(*) from public.purchase_order_revisions)::int as revisions,
    (select count(*) from private.group_g_operations where operation = 'purchase_order_create')::int as create_operations,
    (select count(*) from private.group_g_operations)::int as operations,
    (select count(*) from public.stock_movements)::int as movements,
    (select count(*) from public.order_item_allocations)::int as allocations,
    (select count(*) from public.order_item_allocation_events)::int as allocation_events,
    (select count(*) from public.order_item_state_events)::int as state_events,
    (select count(*) from public.orders)::int as orders_total,
    (select count(*) from public.order_items)::int as order_items,
    (select coalesce(sum(stock_quantity), 0) from public.item_variants)::int as stock,
    (select md5(coalesce(string_agg(id::text || ':' || stock_quantity::text, ',' order by id), '')) from public.item_variants) as stock_by_variant,
    (select md5(coalesce(string_agg(id::text || ':' || remaining_quantity::text || ':' || version::text, ',' order by id), '')) from public.order_item_allocations) as allocation_state`)).rows[0];

  const today = async () => (await db().query("select to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD') as ymd")).rows[0].ymd as string;
  /** その日（JST）の発注番号の最大の連番。空の DB なら 0 */
  async function todaysMax(): Promise<number> {
    return Number((await db().query(`select coalesce(max(substr(number, 13)::int), 0) as n from public.purchase_orders
      where number like 'PO-' || to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD') || '-%'`)).rows[0].n);
  }
  const numberOf = (ymd: string, sequence: number) => `PO-${ymd}-${String(sequence).padStart(4, '0')}`;

  async function itemName(itemId: number): Promise<string> {
    return (await db().query('select name from public.items where id = $1', [itemId])).rows[0].name as string;
  }

  /** 1つの商品に色なし・サイズ n 個の variant を作る（上限 100 行の試験用） */
  async function createManyVariants(count: number): Promise<number[]> {
    const itemId = Number((await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('fx-many-' || gen_random_uuid()::text, '上限の試験', 5000, 'TOPS', 'https://example.com/item.png', 'published') returning id`)).rows[0].id);
    const ids: number[] = [];
    for (let position = 1; position <= count; position += 1) {
      const sizeId = Number((await db().query('insert into public.item_sizes (item_id, label, position) values ($1, $2, $3) returning id', [itemId, `S${position}`, position])).rows[0].id);
      ids.push(Number((await db().query('insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, null, $2, true) returning id', [itemId, sizeId])).rows[0].id));
    }
    return ids;
  }

  // ---- FREQ-526-AC-02: 保存される内容 ----

  test('FREQ-526-AC-02: 発注確定で発注書1件・明細N件・版1・段階ordered・仮数量・名称の写し・revision(order)・操作の記録が一度に保存され、番号は PO-<JSTの日付>-<その日の最大+1（空のDBなら0001）>', async () => {
    const actor = await manager();
    const first = await createCatalogFixture(db(), { stock: 0 });
    const second = await createCatalogFixture(db(), { stock: 0 });
    const ymd = await today();
    const base = await todaysMax();
    const before = await snapshot();
    const requestKey = randomUUID();

    const result = await create({ actor, supplier: '工場A', memo: '春の追加分', key: requestKey,
      lines: [lineOf(first.variantId, 5), lineOf(second.variantId, 3)] });

    expect(result).toEqual({ id: expect.stringMatching(UUID_PATTERN), number: numberOf(ymd, base + 1), version: 1, replayed: false });
    const order = (await db().query('select * from public.purchase_orders where id = $1', [result.id])).rows[0];
    expect(order).toMatchObject({
      number: result.number, supplier_name: '工場A', memo: '春の追加分', stage: 'ordered', version: 1, created_by: actor,
    });
    expect(order.ordered_at).toBeInstanceOf(Date);

    const lines = (await db().query(`select line_no, variant_id::int as variant_id, item_name, color_name, size_label, provisional_quantity,
        confirmed_quantity, received_quantity, unit_price_yen, outstanding_quantity, version
      from public.purchase_order_lines where purchase_order_id = $1 order by line_no`, [result.id])).rows;
    expect(lines).toEqual([
      { line_no: 1, variant_id: first.variantId, item_name: await itemName(first.itemId), color_name: first.colorName, size_label: first.sizeLabel,
        provisional_quantity: 5, confirmed_quantity: null, received_quantity: 0, unit_price_yen: null, outstanding_quantity: null, version: 1 },
      { line_no: 2, variant_id: second.variantId, item_name: await itemName(second.itemId), color_name: second.colorName, size_label: second.sizeLabel,
        provisional_quantity: 3, confirmed_quantity: null, received_quantity: 0, unit_price_yen: null, outstanding_quantity: null, version: 1 },
    ]);

    const operation = (await db().query(`select id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result
      from private.group_g_operations where operation = 'purchase_order_create' and request_key = $1`, [requestKey])).rows;
    expect(operation).toHaveLength(1);
    expect(operation[0]).toMatchObject({ cause_type: 'purchase_order', cause_id: result.id, actor_id: actor, result });
    expect(operation[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const revisions = (await db().query(`select r.line_id, r.revision_no, r.kind, r.before_quantity, r.after_quantity, r.after_supplier_name, r.after_memo,
        r.reason, r.actor_id, r.operation_id, l.line_no
      from public.purchase_order_revisions r left join public.purchase_order_lines l on l.id = r.line_id
      where r.purchase_order_id = $1 order by l.line_no nulls first`, [result.id])).rows;
    expect(revisions).toHaveLength(3);
    expect(revisions[0]).toMatchObject({ line_id: null, revision_no: 1, kind: 'order', after_supplier_name: '工場A', after_memo: '春の追加分', actor_id: actor, operation_id: operation[0].id });
    expect(revisions.slice(1).map((row) => [row.line_no, row.revision_no, row.kind, row.before_quantity, row.after_quantity, row.actor_id, row.operation_id])).toEqual([
      [1, 1, 'order', null, 5, actor, operation[0].id], [2, 1, 'order', null, 3, actor, operation[0].id],
    ]);

    const after = await snapshot();
    expect(after).toMatchObject({ orders: before.orders + 1, lines: before.lines + 2, revisions: before.revisions + 3,
      create_operations: before.create_operations + 1, operations: before.operations + 1 });
  });

  test('FREQ-526-AC-02: 名称の写しは作成時の物で、あとで商品名を変えても発注書の明細は変わらない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const original = await itemName(c.itemId);
    const result = await create({ actor, lines: [lineOf(c.variantId, 1)] });
    await db().query("update public.items set name = '改名した商品' where id = $1", [c.itemId]);
    const line = (await db().query('select item_name, color_name, size_label from public.purchase_order_lines where purchase_order_id = $1', [result.id])).rows[0];
    expect(line).toEqual({ item_name: original, color_name: c.colorName, size_label: c.sizeLabel });
  });

  test('FREQ-526-AC-02: 色・サイズが無い variant の明細は color_name / size_label が NULL', async () => {
    const actor = await manager();
    const [variantId] = await createManyVariants(1);
    const result = await create({ actor, lines: [lineOf(variantId, 2)] });
    const line = (await db().query('select color_name, size_label from public.purchase_order_lines where purchase_order_id = $1', [result.id])).rows[0];
    expect(line).toEqual({ color_name: null, size_label: 'S1' });

    // 色もサイズも無い variant（商品を作ると同期のトリガーが作る物。無ければこの試験が作る）
    const bareItem = Number((await db().query(`insert into public.items (name, description, price, category, image_url, status)
      values ('fx-bare-' || gen_random_uuid()::text, 'x', 1000, 'TOPS', 'https://example.com/i.png', 'published') returning id`)).rows[0].id);
    const existing = (await db().query('select id from public.item_variants where item_id = $1 and color_id is null and size_id is null', [bareItem])).rows[0];
    const bareVariant = Number(existing?.id
      ?? (await db().query('insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, null, null, true) returning id', [bareItem])).rows[0].id);
    const second = await create({ actor, lines: [lineOf(bareVariant, 1)] });
    expect((await db().query('select color_name, size_label from public.purchase_order_lines where purchase_order_id = $1', [second.id])).rows[0])
      .toEqual({ color_name: null, size_label: null });
  });

  test('FREQ-526-AC-02: 発注先とメモは前後の空白を落として保存し、空白だけのメモは NULL（版は1、段階は ordered）', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const result = await create({ actor, supplier: '  工場A\t', memo: '   ', lines: [lineOf(c.variantId, 1)] });
    const order = (await db().query('select supplier_name, memo, version, stage from public.purchase_orders where id = $1', [result.id])).rows[0];
    expect(order).toEqual({ supplier_name: '工場A', memo: null, version: 1, stage: 'ordered' });
    const header = (await db().query("select after_supplier_name, after_memo from public.purchase_order_revisions where purchase_order_id = $1 and line_id is null", [result.id])).rows[0];
    expect(header).toEqual({ after_supplier_name: '工場A', after_memo: null });
  });

  test('FREQ-526-AC-02: 明細の line_no は _lines の並び順で1から連番（variantId の順ではない）', async () => {
    const actor = await manager();
    const a = await createCatalogFixture(db(), { stock: 0 });
    const b = await createCatalogFixture(db(), { stock: 0 });
    const c = await createCatalogFixture(db(), { stock: 0 });
    const descending = [c, b, a];
    const result = await create({ actor, lines: descending.map((fixture, index) => lineOf(fixture.variantId, index + 1)) });
    const lines = (await db().query('select line_no, variant_id::int as variant_id, provisional_quantity from public.purchase_order_lines where purchase_order_id = $1 order by line_no', [result.id])).rows;
    expect(lines).toEqual(descending.map((fixture, index) => ({ line_no: index + 1, variant_id: fixture.variantId, provisional_quantity: index + 1 })));
    const revisions = (await db().query(`select l.line_no from public.purchase_order_revisions r join public.purchase_order_lines l on l.id = r.line_id
      where r.purchase_order_id = $1 order by l.line_no`, [result.id])).rows.map((row) => row.line_no);
    expect(revisions).toEqual([1, 2, 3]);
  });

  test('FREQ-526-AC-02: 上限ちょうど（100行・数量99999・発注先100字・メモ500字）は通る', async () => {
    const actor = await manager();
    const variants = await createManyVariants(100);
    const result = await create({ actor, supplier: 'あ'.repeat(100), memo: 'い'.repeat(500), lines: variants.map((id) => lineOf(id, 99999)) });
    expect(result.version).toBe(1);
    const count = (await db().query('select count(*)::int as n, min(provisional_quantity) as low, max(line_no) as last from public.purchase_order_lines where purchase_order_id = $1', [result.id])).rows[0];
    expect(count).toEqual({ n: 100, low: 99999, last: 100 });
  });

  test('FREQ-526-AC-02: private 本体から呼んでも、public 入口から呼んでも同じ結果（番号の連番も共通）', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const ymd = await today();
    const base = await todaysMax();
    const viaPrivate = await create({ actor, schema: 'private', lines: [lineOf(c.variantId, 1)] });
    const viaPublic = await create({ actor, schema: 'public', lines: [lineOf(c.variantId, 1)] });
    expect([viaPrivate.number, viaPublic.number]).toEqual([numberOf(ymd, base + 1), numberOf(ymd, base + 2)]);
  });

  // ---- 番号 ----

  test('FREQ-526-AC-02: 同日の2件目は連番の次、別の日の番号は数えない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const ymd = await today();
    const base = await todaysMax();
    await db().query(`insert into public.purchase_orders (number, supplier_name, created_by) values
      ('PO-20200101-0007', 'old', $1),
      ('PO-' || to_char((now() at time zone 'Asia/Tokyo') - interval '1 day', 'YYYYMMDD') || '-0042', 'yesterday', $1),
      ('PO-' || to_char((now() at time zone 'Asia/Tokyo') + interval '1 day', 'YYYYMMDD') || '-0099', 'tomorrow', $1)`, [actor]);

    const first = await create({ actor, lines: [lineOf(c.variantId, 1)] });
    const second = await create({ actor, lines: [lineOf(c.variantId, 2)] });
    expect([first.number, second.number]).toEqual([numberOf(ymd, base + 1), numberOf(ymd, base + 2)]);
    expect(new Set([first.number, second.number]).size).toBe(2);
  });

  test('FREQ-526-AC-02: その日の番号が 9999 まで使われていれば GROUP_G_PO_NUMBER_EXHAUSTED / 55000 で、何も残らない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const ymd = await today();
    await db().query('insert into public.purchase_orders (number, supplier_name, created_by) values ($1, $2, $3)', [numberOf(ymd, 9999), 'last', actor]);
    const before = await snapshot();
    expect(await rejected(() => create({ actor, lines: [lineOf(c.variantId, 1)] }))).toEqual({ code: '55000', message: 'GROUP_G_PO_NUMBER_EXHAUSTED' });
    expect(await snapshot()).toEqual(before);
  });

  // ---- FREQ-526-AC-03: 再送と衝突 ----

  test('FREQ-526-AC-03: 同じ request_key・同内容の再送は同じ発注書・replayed:true・行数増加0（発注先・メモの前後の空白と明細の並びが違っても同じ内容）', async () => {
    const actor = await manager();
    const a = await createCatalogFixture(db(), { stock: 0 });
    const b = await createCatalogFixture(db(), { stock: 0 });
    const key = randomUUID();
    const first = await create({ actor, key, supplier: '工場A', memo: '春', lines: [lineOf(a.variantId, 5), lineOf(b.variantId, 3)] });
    const after = await snapshot();

    const again = await create({ actor, key, supplier: '工場A', memo: '春', lines: [lineOf(a.variantId, 5), lineOf(b.variantId, 3)] });
    expect(again).toEqual({ ...first, replayed: true });
    const spaced = await create({ actor, key, supplier: ' 工場A ', memo: ' 春 ', lines: [lineOf(b.variantId, 3), lineOf(a.variantId, 5)] });
    expect(spaced).toEqual({ ...first, replayed: true });
    const viaPrivate = await create({ actor, key, schema: 'private', supplier: '工場A', memo: '春', lines: [lineOf(a.variantId, 5), lineOf(b.variantId, 3)] });
    expect(viaPrivate).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(after);
    // 保存した操作の結果は replayed:false のまま
    expect((await db().query("select result from private.group_g_operations where operation = 'purchase_order_create' and request_key = $1", [key])).rows[0].result.replayed).toBe(false);
  });

  test('FREQ-526-AC-03: 同じ request_key で内容（発注先・メモ・数量・variant・件数・実行者）が違えば GROUP_G_REQUEST_KEY_CONFLICT / 23505 で、何も増えない', async () => {
    const actor = await manager();
    const other = await manager();
    const a = await createCatalogFixture(db(), { stock: 0 });
    const b = await createCatalogFixture(db(), { stock: 0 });
    const key = randomUUID();
    const base = { actor, key, supplier: '工場A', memo: '春', lines: [lineOf(a.variantId, 5)] };
    await create(base);
    const after = await snapshot();

    const variants: Array<[string, CreateArgs]> = [
      ['発注先', { ...base, supplier: '工場B' }],
      ['メモ', { ...base, memo: '夏' }],
      ['メモを消す', { ...base, memo: null }],
      ['数量', { ...base, lines: [lineOf(a.variantId, 6)] }],
      ['variant', { ...base, lines: [lineOf(b.variantId, 5)] }],
      ['件数', { ...base, lines: [lineOf(a.variantId, 5), lineOf(b.variantId, 1)] }],
      ['実行者', { ...base, actor: other }],
    ];
    for (const [name, args] of variants) {
      expect({ name, ...(await rejected(() => create(args))) }).toEqual({ name, ...CONFLICT });
    }
    expect(await snapshot()).toEqual(after);
  });

  test('FREQ-526-AC-03: 同じ request_key でも別の実行者には再送の結果を見せない（権限が無ければ GROUP_G_FORBIDDEN）', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const key = randomUUID();
    await create({ actor, key, lines: [lineOf(c.variantId, 5)] });
    const outsider = await createActor([]);
    expect(await rejected(() => create({ actor: outsider, key, lines: [lineOf(c.variantId, 5)] }))).toEqual(FORBIDDEN);
  });

  test('FREQ-526-AC-03: request_key が違えば同じ内容でも別の発注書になる', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const first = await create({ actor, lines: [lineOf(c.variantId, 5)] });
    const second = await create({ actor, lines: [lineOf(c.variantId, 5)] });
    expect(second.id).not.toBe(first.id);
    expect(second.replayed).toBe(false);
  });

  // ---- 引数 ----

  test('FREQ-526-AC-02: 引数（行0件・行が配列でない・101行・variant重複・数量の範囲外や型違い・余分や不足の項目・発注先とメモの長さ・存在しないvariant・実行者や要求番号が無い）は 22023 で、何も残らない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const missing = Number((await db().query('select coalesce(max(id), 0) + 1000 as n from public.item_variants')).rows[0].n);
    const ok = [lineOf(c.variantId, 1)];
    const before = await snapshot();

    const cases: Array<[string, CreateArgs]> = [
      ['行0件', { actor, lines: [] }],
      ['行が配列でない（object）', { actor, lines: { variantId: c.variantId, quantity: 1 } }],
      ['行が JSON の null', { actor, lines: null }],
      ['行が文字列', { actor, lines: 'x' }],
      ['行が SQL の NULL', { actor }],
      ['101行', { actor, lines: Array.from({ length: 101 }, (_, i) => lineOf(i + 1, 1)) }],
      ['variant 重複', { actor, lines: [lineOf(c.variantId, 1), lineOf(c.variantId, 2)] }],
      ['数量0', { actor, lines: [lineOf(c.variantId, 0)] }],
      ['数量100000', { actor, lines: [lineOf(c.variantId, 100000)] }],
      ['数量が負', { actor, lines: [lineOf(c.variantId, -1)] }],
      ['数量が小数', { actor, lines: [{ variantId: c.variantId, quantity: 1.5 }] }],
      ['数量が文字列', { actor, lines: [{ variantId: c.variantId, quantity: '5' }] }],
      ['variantId が文字列', { actor, lines: [{ variantId: String(c.variantId), quantity: 1 }] }],
      ['variantId が0', { actor, lines: [lineOf(0, 1)] }],
      ['variantId が負', { actor, lines: [lineOf(-5, 1)] }],
      ['variantId が小数', { actor, lines: [{ variantId: 1.5, quantity: 1 }] }],
      ['項目が余分', { actor, lines: [{ variantId: c.variantId, quantity: 1, price: 100 }] }],
      ['quantity が無い', { actor, lines: [{ variantId: c.variantId }] }],
      ['項目名が違う', { actor, lines: [{ variantId: c.variantId, qty: 1 }] }],
      ['要素が object でない', { actor, lines: [5] }],
      ['要素が配列', { actor, lines: [[c.variantId, 1]] }],
      ['存在しない variant', { actor, lines: [lineOf(c.variantId, 1), lineOf(missing, 1)] }],
      ['発注先が空', { actor, supplier: '', lines: ok }],
      ['発注先が空白だけ', { actor, supplier: ' \t ', lines: ok }],
      ['発注先が NULL', { actor, supplier: null, lines: ok }],
      ['発注先が101字', { actor, supplier: 'あ'.repeat(101), lines: ok }],
      ['メモが501字', { actor, memo: 'い'.repeat(501), lines: ok }],
      ['実行者が NULL', { actor: null, lines: ok }],
      ['要求番号が NULL', { actor, key: null, lines: ok }],
    ];
    for (const [name, args] of cases) {
      expect({ name, ...(await rejected(() => create(args))) }).toEqual({ name, ...INVALID });
    }
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-526-AC-02: 引数の誤りは権限より先に断る（権限の無い実行者でも 22023）が、正しい引数なら権限で断る', async () => {
    const outsider = await createActor([]);
    const c = await createCatalogFixture(db(), { stock: 0 });
    expect(await rejected(() => create({ actor: outsider, lines: [] }))).toEqual(INVALID);
    expect(await rejected(() => create({ actor: outsider, lines: [lineOf(c.variantId, 1)] }))).toEqual(FORBIDDEN);
  });

  // ---- 権限 ----

  test('FREQ-540-AC-07: 無効にした役割・期限切れの役割・役割が無い・存在しない実行者は GROUP_G_FORBIDDEN / 42501 で、何も残らない', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const before = await snapshot();
    const actors = [
      await createActor(['admin'], { inactive: ['admin'] }),
      await createActor(['admin'], { expired: ['admin'] }),
      await createActor([]),
      randomUUID(),
    ];
    for (const actor of actors) {
      expect(await rejected(() => create({ actor, lines: [lineOf(c.variantId, 1)] }))).toEqual(FORBIDDEN);
      expect(await rejected(() => create({ actor, schema: 'private', lines: [lineOf(c.variantId, 1)] }))).toEqual(FORBIDDEN);
    }
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-540-AC-07: admin.items.* だけ・manage だけ・read だけ・在庫と受け取りの権限だけは断られ、manage と read の両方があれば通る（役割をまたいだ和集合も）', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const attempt = (actor: string) => rejected(() => create({ actor, lines: [lineOf(c.variantId, 1)] }));

    await grant('supporter', ['admin.items.read', 'admin.items.manage']);
    expect(await attempt(await createActor(['supporter']))).toEqual(FORBIDDEN);

    await revoke('supporter', ['admin.items.read', 'admin.items.manage']);
    await grant('supporter', ['admin.stock.read', 'admin.stock.manage', 'admin.receiving.manage']);
    expect(await attempt(await createActor(['supporter']))).toEqual(FORBIDDEN);

    await revoke('supporter', ['admin.stock.read', 'admin.stock.manage', 'admin.receiving.manage']);
    await grant('supporter', ['admin.purchase_orders.manage']);
    expect(await attempt(await createActor(['supporter']))).toEqual(FORBIDDEN);

    await revoke('supporter', ['admin.purchase_orders.manage']);
    await grant('supporter', ['admin.purchase_orders.read']);
    expect(await attempt(await createActor(['supporter']))).toEqual(FORBIDDEN);

    // manage が supporter、read が user にある実行者は、有効な役割の和集合で足りる
    await revoke('supporter', ['admin.purchase_orders.read']);
    await grant('supporter', ['admin.purchase_orders.manage']);
    await grant('user', ['admin.purchase_orders.read']);
    expect(await attempt(await createActor(['supporter']))).toEqual(FORBIDDEN);
    const union = await createActor(['supporter', 'user']);
    const result = await create({ actor: union, lines: [lineOf(c.variantId, 1)] });
    expect(result.version).toBe(1);

    // 店長は初期のまま両方を持つ
    expect((await create({ actor: await manager(), lines: [lineOf(c.variantId, 1)] })).replayed).toBe(false);
  });

  test('FREQ-540-AC-07: 実行者の現在の権限を毎回確かめる。manage を外すとその場から断られる', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    expect((await create({ actor, lines: [lineOf(c.variantId, 1)] })).version).toBe(1);
    await revoke('admin', ['admin.purchase_orders.manage']);
    expect(await rejected(() => create({ actor, lines: [lineOf(c.variantId, 1)] }))).toEqual(FORBIDDEN);
  });

  // ---- 在庫・割当・台帳・注文は動かない ----

  test('FREQ-526-AC-02: 在庫・割当・台帳・状態の履歴・注文の行数と各 variant の stock_quantity・割当の残りは、発注の作成の前後で変わらない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 4 });
    const order = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 6, fulfillmentType: 'backorder', reserved: false }] });
    await seedGroupG1Allocation(db(), { orderItemId: order.orderItemIds[0], quantity: 2, kind: 'paid' });
    const before = await snapshot();
    expect(before.allocations).toBeGreaterThan(0);
    // 割当を入れた後の空き在庫（4 のうち割当に使った分は減っている）。作成の前後で同じであることを確かめる
    const stockBefore = Number((await db().query('select stock_quantity from public.item_variants where id = $1', [c.variantId])).rows[0].stock_quantity);
    const untouched = (row: Awaited<ReturnType<typeof snapshot>>) => ({
      movements: row.movements, allocations: row.allocations, allocation_events: row.allocation_events, state_events: row.state_events,
      orders_total: row.orders_total, order_items: row.order_items, stock: row.stock, stock_by_variant: row.stock_by_variant,
      allocation_state: row.allocation_state,
    });

    const key = randomUUID();
    await create({ actor, key, lines: [lineOf(c.variantId, 10)] });
    await create({ actor, lines: [lineOf(c.variantId, 10)] });
    await create({ actor, schema: 'private', lines: [lineOf(c.variantId, 1)] });
    // 再送も動かさない
    expect((await create({ actor, key, lines: [lineOf(c.variantId, 10)] })).replayed).toBe(true);

    const after = await snapshot();
    expect(untouched(after)).toEqual(untouched(before));
    // 増えたのは発注の3表と、発注の操作の記録だけ
    expect(after).toMatchObject({ orders: before.orders + 3, lines: before.lines + 3, revisions: before.revisions + 6,
      create_operations: before.create_operations + 3, operations: before.operations + 3 });
    expect(Number((await db().query('select stock_quantity from public.item_variants where id = $1', [c.variantId])).rows[0].stock_quantity)).toBe(stockBefore);
  });

  // ---- 途中失敗 ----

  test('FREQ-526-AC-02: 途中失敗（明細ごとの revision の INSERT に故障を注入）では、発注書・明細・操作が全部残らない', async () => {
    const actor = await manager();
    const a = await createCatalogFixture(db(), { stock: 0 });
    const b = await createCatalogFixture(db(), { stock: 0 });
    await db().query(`create function public.g2_inject_revision_failure() returns trigger language plpgsql as $$
      begin
        if new.line_id is not null then
          raise exception 'INJECTED_REVISION_FAILURE' using errcode = 'P0001',
            detail = (select count(*)::text from public.purchase_orders where id = new.purchase_order_id) || ','
              || (select count(*)::text from public.purchase_order_lines where purchase_order_id = new.purchase_order_id);
        end if;
        return new;
      end $$`);
    await db().query(`create trigger g2_inject_revision_failure before insert on public.purchase_order_revisions
      for each row execute function public.g2_inject_revision_failure()`);
    const before = await snapshot();
    const key = randomUUID();

    await db().query('savepoint injected');
    let caught: { code?: string; message?: string; detail?: string } = {};
    try {
      await create({ actor, key, lines: [lineOf(a.variantId, 5), lineOf(b.variantId, 3)] });
    } catch (e) {
      caught = e as typeof caught;
    }
    // 故障の時点では発注書 1 件と明細 2 件がもう書かれていた（途中まで書いて失敗した）
    expect(caught).toMatchObject({ code: 'P0001', message: 'INJECTED_REVISION_FAILURE', detail: '1,2' });
    await db().query('rollback to savepoint injected');

    expect(await snapshot()).toEqual(before);
    expect((await db().query("select count(*)::int as n from private.group_g_operations where operation = 'purchase_order_create' and request_key = $1", [key])).rows[0].n).toBe(0);
  });

  test('FREQ-526-AC-02: 最後の操作の記録の INSERT に故障を注入しても、先に書いた発注書・明細・revision は全部残らない（同じ request_key は後で作り直せる）', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    await db().query(`create function public.g2_inject_operation_failure() returns trigger language plpgsql as $$
      begin
        if new.operation = 'purchase_order_create' then
          raise exception 'INJECTED_OPERATION_FAILURE' using errcode = 'P0001',
            detail = (select count(*)::text from public.purchase_order_revisions where operation_id = new.id);
        end if;
        return new;
      end $$`);
    await db().query(`create trigger g2_inject_operation_failure before insert on private.group_g_operations
      for each row execute function public.g2_inject_operation_failure()`);
    const before = await snapshot();
    const key = randomUUID();

    await db().query('savepoint injected');
    let caught: { code?: string; message?: string; detail?: string } = {};
    try {
      await create({ actor, key, lines: [lineOf(c.variantId, 5)] });
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught).toMatchObject({ code: 'P0001', message: 'INJECTED_OPERATION_FAILURE', detail: '2' });
    await db().query('rollback to savepoint injected');
    expect(await snapshot()).toEqual(before);

    await db().query('drop trigger g2_inject_operation_failure on private.group_g_operations');
    const retried = await create({ actor, key, lines: [lineOf(c.variantId, 5)] });
    expect(retried.replayed).toBe(false);
  });

  // ---- 関数の形と ACL ----

  test('FREQ-540-AC-07: private 本体は DEFINER・postgres・search_path 空で service_role だけが EXECUTE でき、public 入口は SQL の INVOKER 委譲（service_role のみ）。ロック helper は誰も EXECUTE できない', async () => {
    const read = async (signature: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
        l.lanname as language, p.proconfig as config, p.provolatile as volatility, p.proretset as set_returning,
        pg_get_function_result(p.oid) as result, p.proargnames as names,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [signature])).rows[0];
    const create = { owner: 'postgres', config: ['search_path=""'], volatility: 'v', set_returning: false, result: 'jsonb',
      names: ['_supplier_name', '_memo', '_lines', '_actor_id', '_request_key'], service_role: true, anon: false, authenticated: false, public_can_execute: false };

    expect(await read(PRIVATE_CREATE)).toEqual({ ...create, definer: true, language: 'plpgsql' });
    expect(await read(PUBLIC_CREATE)).toEqual({ ...create, definer: false, language: 'sql' });
    expect(await read(LOCK_SIGNATURE)).toEqual({
      owner: 'postgres', definer: true, language: 'plpgsql', config: ['search_path=""'], volatility: 'v', set_returning: false,
      result: 'uuid[]', names: ['_purchase_order_ids', '_with_inventory'],
      service_role: false, anon: false, authenticated: false, public_can_execute: false,
    });
  });

  test('FREQ-526-AC-02: ロック helper の本体（pg_proc.prosrc）の最初の文は pg_advisory_xact_lock(190521,1)', async () => {
    const src = (await db().query('select prosrc from pg_proc where oid = $1::regprocedure', [LOCK_SIGNATURE])).rows[0].prosrc as string;
    expect(src.replace(/\s+/g, ' ').match(/\bBEGIN (.+?;)/)?.[1]).toBe('PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);');
    const create = (await db().query('select prosrc from pg_proc where oid = $1::regprocedure', [PRIVATE_CREATE])).rows[0].prosrc as string;
    expect(create.indexOf('lock_group_g_purchase_orders(ARRAY[]::uuid[], false)')).toBeGreaterThan(0);
  });

  test('FREQ-540-AC-07: anon / authenticated は public 入口も private 本体も呼べず（42501）、service_role は public 入口から作れる。ロック helper は service_role でも呼べない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const attempt = async (role: string, sql: string, params: unknown[]) => {
      await db().query('savepoint role_attempt');
      try {
        await db().query(`set local role ${role}`);
        if (role === 'authenticated') await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: randomUUID(), role })]);
        const res = await db().query(sql, params);
        return { rows: res.rows as Array<Record<string, unknown>> };
      } catch (caught) {
        return { code: (caught as { code?: string }).code ?? 'unknown' };
      } finally {
        await db().query('rollback to savepoint role_attempt');
        await db().query('release savepoint role_attempt');
      }
    };
    const params = () => ['工場A', null, JSON.stringify([lineOf(c.variantId, 1)]), actor, randomUUID()];
    const call = (schema: 'public' | 'private') => `select ${schema}.admin_create_purchase_order($1, $2, $3::jsonb, $4, $5) as r`;
    for (const role of ['anon', 'authenticated']) {
      expect(await attempt(role, call('public'), params())).toEqual({ code: '42501' });
      expect(await attempt(role, call('private'), params())).toEqual({ code: '42501' });
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await attempt(role, 'select private.lock_group_g_purchase_orders($1::uuid[], false)', [[]])).toEqual({ code: '42501' });
    }
    const viaService = await attempt('service_role', call('public'), params());
    expect('rows' in viaService).toBe(true);
    const created = (viaService as { rows: Array<{ r: { number: string; version: number; replayed: boolean } }> }).rows[0].r;
    expect(created).toMatchObject({ version: 1, replayed: false });
    expect(created.number).toMatch(/^PO-\d{8}-\d{4}$/);
  });

  // ---- ロック helper ----

  test('FREQ-526-AC-02: ロック helper は呼び手が押さえを持っていなくても、自分で共通 advisory (190521,1) を取る', async () => {
    // 試験の前処理が取った advisory を持ち越さない新しい取引で確かめる（この試験は材料を作らない）
    await db().query('rollback');
    await db().query('begin');
    const advisory = async () => Number((await db().query(`select count(*)::int as n from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'
      and classid = 190521 and objid = 1 and objsubid = 2 and mode = 'ExclusiveLock' and granted`)).rows[0].n);
    expect(await advisory()).toBe(0);
    expect((await db().query('select private.lock_group_g_purchase_orders($1::uuid[], false) as ids', [[]])).rows[0].ids).toEqual([]);
    expect(await advisory()).toBe(1);
  });

  test('FREQ-526-AC-02: ロック helper の _with_inventory は、発注書の行の variant を advisory の後に読んで在庫の閉包（注文 id 昇順）を返す。偽なら空の配列で、関係の無い注文は含めない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    const other = await createCatalogFixture(db(), { stock: 0 });
    const order = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 2, fulfillmentType: 'backorder', reserved: false }] });
    const unrelated = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: other.itemId, variantId: other.variantId, quantity: 1, fulfillmentType: 'backorder', reserved: false }] });
    const created = await create({ actor, lines: [lineOf(c.variantId, 1)] });

    const withoutInventory = (await db().query('select private.lock_group_g_purchase_orders($1::uuid[], false) as ids', [[created.id]])).rows[0].ids;
    expect(withoutInventory).toEqual([]);
    const withInventory = (await db().query('select private.lock_group_g_purchase_orders($1::uuid[], true) as ids', [[created.id]])).rows[0].ids as string[];
    expect(withInventory).toContain(order.orderId);
    expect(withInventory).not.toContain(unrelated.orderId);
    expect([...withInventory].sort()).toEqual(withInventory);
    // G-1 の閉包と同じ結果
    const closure = (await db().query('select private.lock_group_g_inventory($1::bigint[], $2::uuid[], null) as ids', [[c.variantId], []])).rows[0].ids;
    expect(withInventory).toEqual(closure);
    // 対象が無い・NULL でも壊れない
    expect((await db().query('select private.lock_group_g_purchase_orders($1::uuid[], true) as ids', [[randomUUID()]])).rows[0].ids).toEqual([]);
    expect((await db().query('select private.lock_group_g_purchase_orders(null, null) as ids')).rows[0].ids).toEqual([]);
  });
});
