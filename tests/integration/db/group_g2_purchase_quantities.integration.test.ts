/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, withLedgerLock } from './helpers/order-fixtures';
import { seedGroupG1Allocation } from './helpers/group-g1-fixtures';

/**
 * G-2 Task 6（FREQ-527・FREQ-528・FREQ-525-AC-02・FREQ-540-AC-07）: 発注書の数量の確定・訂正・単価、発注先・メモの訂正、残りの打切り。
 * private.admin_confirm_purchase_order_quantities / admin_short_close_purchase_order / admin_update_purchase_order_header と
 * それぞれの公開入口（service_role のみ）。処理順は「引数検証 → ロック → 権限 → 指紋と再送 → 存在 → 版 → 業務規則」。
 * 単価だけの変更も kind=quantity の revision を before_quantity = after_quantity で書く（表示段階は数量が実際に変わる版だけを数える）。
 * 納品済みは受取の関数（Task 7）がまだ無いので、試験内の材料 receiveMaterial が 台帳（restock）・受取・受取行・行の更新を作る。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const WRITERS_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_writers.sql'));
const WRITERS_SQL = WRITERS_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, WRITERS_FILE[0]), 'utf8') : '';

const HEADER_SIGNATURE = 'admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)';
const CONFIRM_SIGNATURE = 'admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)';
const CLOSE_SIGNATURE = 'admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)';
const SIGNATURES = [HEADER_SIGNATURE, CONFIRM_SIGNATURE, CLOSE_SIGNATURE] as const;

const FORBIDDEN = { code: '42501', message: 'GROUP_G_FORBIDDEN' };
const INVALID = { code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' };
const CONFLICT = { code: '23505', message: 'GROUP_G_REQUEST_KEY_CONFLICT' };
const NOT_FOUND = { code: 'P0002', message: 'GROUP_G_PO_NOT_FOUND' };
const VERSION_CONFLICT = { code: '55000', message: 'GROUP_G_PO_VERSION_CONFLICT' };
const REASON_REQUIRED = { code: '22023', message: 'GROUP_G_PO_REASON_REQUIRED' };
const BELOW_RECEIVED = { code: '23514', message: 'GROUP_G_PO_QUANTITY_BELOW_RECEIVED' };
const NOTHING_TO_CLOSE = { code: '55000', message: 'GROUP_G_PO_NOTHING_TO_CLOSE' };

/** コメントの行を外した本文（コメント内の語を拾わないため） */
const withoutComments = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const CODE = withoutComments(WRITERS_SQL);

/** CREATE FUNCTION <name>( から、その ALTER FUNCTION までの本文 */
function functionText(createPrefix: string, alterPrefix: string): string {
  const start = CODE.indexOf(createPrefix);
  const end = CODE.indexOf(alterPrefix, start);
  return start >= 0 && end > start ? CODE.slice(start, end) : '';
}
const HEADER_TEXT = functionText('CREATE FUNCTION private.admin_update_purchase_order_header(', 'ALTER FUNCTION private.admin_update_purchase_order_header(');
const CONFIRM_TEXT = functionText('CREATE FUNCTION private.admin_confirm_purchase_order_quantities(', 'ALTER FUNCTION private.admin_confirm_purchase_order_quantities(');
const CLOSE_TEXT = functionText('CREATE FUNCTION private.admin_short_close_purchase_order(', 'ALTER FUNCTION private.admin_short_close_purchase_order(');

describe('G-2 writers migration の数量・打切りの節（DB なし）', () => {
  const PERMISSION = "private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read'])";

  test.each([
    ['発注先・メモの訂正', HEADER_TEXT, 'purchase_order_header_update'],
    ['数量の確定・訂正', CONFIRM_TEXT, 'purchase_order_quantities'],
    ['残りの打切り', CLOSE_TEXT, 'purchase_order_short_close'],
  ])('FREQ-527-AC-01: %s の処理順は 引数検証 → ロック helper → 権限 → 指紋と再送 → 存在 → 版 → 書込み → 操作の記録（最後）。表に触れるのはロックの呼び出しから', (_name, text, operation) => {
    expect(text).not.toBe('');
    expect(text).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
    const positions = [
      text.indexOf("RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'"),
      text.indexOf('PERFORM private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], false);'),
      text.indexOf(PERMISSION),
      text.indexOf(`op.operation = '${operation}' AND op.request_key = _request_key`),
      text.indexOf("RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002'"),
      text.indexOf("RAISE EXCEPTION 'GROUP_G_PO_VERSION_CONFLICT' USING ERRCODE = '55000'"),
      text.search(/\b(?:UPDATE public\.|INSERT INTO public\.)/),
      text.indexOf('INSERT INTO private.group_g_operations('),
    ];
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text.lastIndexOf('INSERT INTO private.group_g_operations(')).toBeGreaterThan(text.lastIndexOf('INSERT INTO public.'));
    // 本体で最初に public / private の物に触れるのがロック helper の呼び出し（引数検証は表を読まない）
    const body = text.slice(text.indexOf('\nBEGIN\n'));
    expect(body.search(/\b(?:public|private)\./)).toBe(body.indexOf('private.lock_group_g_purchase_orders('));
    // 指紋に版を入れない（版が進んだ後の再送が同じ結果を返す）
    const fingerprint = text.slice(text.indexOf('v_fingerprint := '), text.indexOf("'hex');"));
    expect(fingerprint).toContain(`'operation', '${operation}'`);
    expect(fingerprint).not.toMatch(/version/i);
    expect(fingerprint).toContain("'actor_id', _actor_id");
  });

  test('FREQ-527-AC-01: 単価だけの変更も kind=quantity の revision を before_quantity = after_quantity（現在の数量）で書く。変化の判定は 数量または単価（NULL と 0 は別）', () => {
    expect(CONFIRM_TEXT).toContain('v_before := COALESCE(v_line.confirmed_quantity, v_line.provisional_quantity);');
    expect(CONFIRM_TEXT).toContain('v_changed := v_line.new_quantity <> v_before OR v_line.new_price IS DISTINCT FROM v_line.unit_price_yen;');
    expect(CONFIRM_TEXT).toContain("VALUES(_purchase_order_id, v_line.id, v_version, 'quantity', v_before, v_line.new_quantity, v_line.unit_price_yen,");
    // 最初の確定（段階 ordered）は全行に履歴を書く（確定そのものが履歴）。再確定は変わった行だけ。changedLines は実際に変わった行だけを数える
    expect(CONFIRM_TEXT).toContain("IF v_order.stage = 'ordered' OR v_changed THEN\n      INSERT INTO public.purchase_order_revisions(");
    expect(CONFIRM_TEXT).toContain('IF v_changed THEN\n      v_changed_lines := v_changed_lines + 1;');
    expect(CONFIRM_TEXT.match(/IF v_order\.stage = 'ordered' OR v_changed THEN/g)).toHaveLength(2);
  });

  test('FREQ-527-AC-01: 3本は在庫・台帳・受取・割当・注文を読みも書きもしない。書く表は決まった物だけ', () => {
    for (const text of [HEADER_TEXT, CONFIRM_TEXT, CLOSE_TEXT]) {
      expect(text).not.toMatch(/\b(stock_movements|stock_quantity|order_item_allocations|order_item_allocation_events|order_item_state_events|order_items|order_fulfillments|purchase_order_receipts|purchase_order_receipt_lines)\b/);
      expect(text).not.toMatch(/\bpublic\.orders\b/);
      expect(text).not.toMatch(/\b(DELETE|TRUNCATE|MERGE)\b/);
    }
    const writes = (text: string) => [...text.matchAll(/\b(INSERT INTO|UPDATE) ([a-z_.]+)/g)].map((match) => `${match[1]} ${match[2]}`);
    expect(writes(HEADER_TEXT)).toEqual(['UPDATE public.purchase_orders', 'INSERT INTO public.purchase_order_revisions', 'INSERT INTO private.group_g_operations']);
    expect(writes(CONFIRM_TEXT)).toEqual([
      'INSERT INTO public.purchase_order_revisions', 'UPDATE public.purchase_order_lines', 'UPDATE public.purchase_orders', 'INSERT INTO private.group_g_operations',
    ]);
    expect(writes(CLOSE_TEXT)).toEqual([
      'INSERT INTO public.purchase_order_revisions', 'INSERT INTO public.purchase_order_short_closures', 'UPDATE public.purchase_order_lines',
      'UPDATE public.purchase_orders', 'INSERT INTO private.group_g_operations',
    ]);
  });

  test('FREQ-528-AC-01: 打切りは 確定後は 確定数量 := 納品済み（closed = 未納）、確定前は全行を 0 にして段階を quantity_confirmed へ（closed = 仮数量）。入庫は起こさない', () => {
    expect(CLOSE_TEXT).toContain("IF v_order.stage = 'ordered' THEN");
    expect(CLOSE_TEXT).toContain('v_before := v_line.provisional_quantity;');
    expect(CLOSE_TEXT).toContain('v_after := 0;');
    expect(CLOSE_TEXT).toContain('v_after := v_line.received_quantity;');
    expect(CLOSE_TEXT).toContain('v_closed := v_line.outstanding_quantity;');
    expect(CLOSE_TEXT).toContain("'short_close', v_before, v_after, v_reason");
    expect(CLOSE_TEXT).toContain("RAISE EXCEPTION 'GROUP_G_PO_NOTHING_TO_CLOSE' USING ERRCODE = '55000'");
    expect(CLOSE_TEXT).toContain("UPDATE public.purchase_orders SET stage = 'quantity_confirmed'");
  });

  test('FREQ-540-AC-07: 3本の private 本体と public 入口は service_role だけに EXECUTE を渡し、PUBLIC / anon / authenticated を個別に外す。public 入口は SQL の INVOKER 委譲', () => {
    for (const signature of SIGNATURES) {
      for (const schema of ['private', 'public']) {
        expect(CODE).toContain(`ALTER FUNCTION ${schema}.${signature} OWNER TO postgres;`);
        expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${schema}.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
        expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO service_role;`);
      }
    }
    const delegates: Array<[string, string]> = [
      ['admin_update_purchase_order_header', '(_purchase_order_id, _expected_version, _supplier_name, _memo, _reason, _actor_id, _request_key)'],
      ['admin_confirm_purchase_order_quantities', '(_purchase_order_id, _expected_version, _lines, _reason, _actor_id, _request_key)'],
      ['admin_short_close_purchase_order', '(_purchase_order_id, _expected_version, _line_ids, _reason, _actor_id, _request_key)'],
    ];
    for (const [name, args] of delegates) {
      const delegate = functionText(`CREATE FUNCTION public.${name}(`, `ALTER FUNCTION public.${name}(`);
      expect(delegate).toContain("LANGUAGE sql SECURITY INVOKER SET search_path = ''");
      expect(delegate).toContain(`SELECT private.${name}${args};`);
    }
    expect(CODE).not.toMatch(/ON SCHEMA\s+private/i);
  });

  test('FREQ-540-AC-07: 最後の確かめは 3本ずつの private 本体と public 入口（7本のうち新しい6本）と、書く表の1つに purchase_order_short_closures を足した', () => {
    const section = WRITERS_SQL.slice(WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_BEGIN'), WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_END'));
    for (const signature of SIGNATURES) {
      expect(section).toContain(`'private.${signature}'`);
      expect(section).toContain(`'public.${signature}'`);
    }
    expect(section).toContain("('public.purchase_order_short_closures')");
  });
});

type LineRow = {
  id: string; line_no: number; variant_id: number; provisional_quantity: number; confirmed_quantity: number | null;
  received_quantity: number; unit_price_yen: number | null; outstanding_quantity: number | null; version: number;
};

describeLocalDb('integration: G-2 数量の確定・訂正・打切り', (db) => {
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
    await db().query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p where r.code=$1 and p.code=any($2::text[])
      on conflict do nothing`, [role, codes]);
  }

  async function revoke(role: string, codes: string[]) {
    await db().query(`delete from public.role_permissions where role_id=(select id from public.roles where code=$1)
      and permission_id in (select id from public.permissions where code=any($2::text[]))`, [role, codes]);
  }

  /** 店長（admin）は初期のまま admin.purchase_orders.manage / read と admin.stock.read を持つ */
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

  /** 遅延の確かめ（操作の受付への外部キー・納品数の整合）を取引の中で発火させる */
  async function flush() {
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
  }

  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

  async function operation(): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
       values ($1, 'g2_purchase_quantities_test', gen_random_uuid(), $2, 'test', $3, '{}'::jsonb)`,
      [id, sha256(id), id],
    );
    return id;
  }

  async function insertRow(table: string, values: Record<string, unknown>): Promise<string> {
    const columns = Object.keys(values);
    const res = await db().query(
      `insert into public.${table} (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
      columns.map((column) => values[column]),
    );
    return String(res.rows[0].id);
  }

  // ---- 呼び出し ----

  type Created = { id: string; number: string; version: number; replayed: boolean };
  const lineOf = (variantId: number, quantity: number) => ({ variantId, quantity });

  async function create(actor: string, lines: Array<{ variantId: number; quantity: number }>): Promise<Created> {
    const result = await db().query('select public.admin_create_purchase_order($1, $2, $3::jsonb, $4, $5) as r',
      ['工場A', null, JSON.stringify(lines), actor, randomUUID()]);
    return result.rows[0].r as Created;
  }

  type Schema = 'public' | 'private';
  type ConfirmArgs = {
    actor?: string | null; orderId?: string | null; version?: number | null; lines?: unknown; reason?: string | null; key?: string | null; schema?: Schema;
  };
  type ConfirmResult = { version: number; changedLines: number; replayed: boolean };

  async function confirm(args: ConfirmArgs): Promise<ConfirmResult> {
    const result = await db().query(
      `select ${args.schema ?? 'public'}.admin_confirm_purchase_order_quantities($1::uuid, $2::integer, $3::jsonb, $4::text, $5::uuid, $6::uuid) as r`,
      [args.orderId ?? null, args.version ?? null, args.lines === undefined ? null : JSON.stringify(args.lines), args.reason ?? null,
        args.actor ?? null, args.key === undefined ? randomUUID() : args.key]);
    await flush();
    return result.rows[0].r as ConfirmResult;
  }

  type CloseArgs = {
    actor?: string | null; orderId?: string | null; version?: number | null; lineIds?: Array<string | null> | null; reason?: string | null; key?: string | null; schema?: Schema;
  };
  type CloseResult = { version: number; closedQuantity: number; replayed: boolean };

  async function shortClose(args: CloseArgs): Promise<CloseResult> {
    const result = await db().query(
      `select ${args.schema ?? 'public'}.admin_short_close_purchase_order($1::uuid, $2::integer, $3::uuid[], $4::text, $5::uuid, $6::uuid) as r`,
      [args.orderId ?? null, args.version ?? null, args.lineIds ?? null, args.reason ?? null, args.actor ?? null,
        args.key === undefined ? randomUUID() : args.key]);
    await flush();
    return result.rows[0].r as CloseResult;
  }

  type HeaderArgs = {
    actor?: string | null; orderId?: string | null; version?: number | null; supplier?: string | null; memo?: string | null; reason?: string | null;
    key?: string | null; schema?: Schema;
  };
  type HeaderResult = { version: number; replayed: boolean };

  async function header(args: HeaderArgs): Promise<HeaderResult> {
    const result = await db().query(
      `select ${args.schema ?? 'public'}.admin_update_purchase_order_header($1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::uuid, $7::uuid) as r`,
      [args.orderId ?? null, args.version ?? null, args.supplier ?? null, args.memo ?? null, args.reason ?? null, args.actor ?? null,
        args.key === undefined ? randomUUID() : args.key]);
    await flush();
    return result.rows[0].r as HeaderResult;
  }

  // ---- 読み取り ----

  async function linesOf(orderId: string): Promise<LineRow[]> {
    return (await db().query(`select id, line_no, variant_id::int as variant_id, provisional_quantity, confirmed_quantity, received_quantity,
        unit_price_yen, outstanding_quantity, version
      from public.purchase_order_lines where purchase_order_id = $1 order by line_no`, [orderId])).rows as LineRow[];
  }

  async function orderRow(orderId: string) {
    return (await db().query('select stage, version, supplier_name, memo from public.purchase_orders where id = $1', [orderId])).rows[0] as
      { stage: string; version: number; supplier_name: string; memo: string | null };
  }

  async function revisionsOf(orderId: string, kind: string | null = null) {
    return (await db().query(`select l.line_no, r.revision_no, r.kind, r.before_quantity, r.after_quantity, r.before_unit_price_yen, r.after_unit_price_yen,
        r.before_supplier_name, r.after_supplier_name, r.before_memo, r.after_memo, r.reason, r.actor_id, r.operation_id
      from public.purchase_order_revisions r left join public.purchase_order_lines l on l.id = r.line_id
      where r.purchase_order_id = $1::uuid and ($2::text is null or r.kind = $2::text)
      order by r.revision_no, l.line_no nulls first, r.kind`, [orderId, kind])).rows;
  }

  async function closuresOf(orderId: string) {
    return (await db().query(`select l.line_no, c.closed_quantity, c.reason, c.actor_id, c.created_at, c.revision_id
      from public.purchase_order_short_closures c join public.purchase_order_lines l on l.id = c.line_id
      where l.purchase_order_id = $1 order by c.created_at, l.line_no`, [orderId])).rows;
  }

  async function stageOf(actor: string, orderId: string): Promise<string> {
    return (await db().query('select public.get_admin_purchase_order($1::uuid, $2::uuid) as r', [orderId, actor])).rows[0].r.displayStage as string;
  }

  const snapshot = async () => (await db().query(`select
    (select count(*) from public.purchase_orders)::int as orders,
    (select count(*) from public.purchase_order_lines)::int as lines,
    (select count(*) from public.purchase_order_revisions)::int as revisions,
    (select count(*) from public.purchase_order_short_closures)::int as short_closures,
    (select count(*) from public.purchase_order_receipts)::int as receipts,
    (select count(*) from public.purchase_order_receipt_lines)::int as receipt_lines,
    (select count(*) from private.group_g_operations)::int as operations,
    (select md5(coalesce(string_agg(id::text || ':' || stage || ':' || version::text || ':' || supplier_name || ':' || coalesce(memo, '~'), ',' order by id), ''))
       from public.purchase_orders) as order_state,
    (select md5(coalesce(string_agg(id::text || ':' || coalesce(confirmed_quantity::text, '~') || ':' || received_quantity::text || ':'
       || coalesce(unit_price_yen::text, '~') || ':' || version::text, ',' order by id), '')) from public.purchase_order_lines) as line_state,
    (select count(*) from public.stock_movements)::int as movements,
    (select count(*) from public.order_item_allocations)::int as allocations,
    (select count(*) from public.order_item_allocation_events)::int as allocation_events,
    (select count(*) from public.order_item_state_events)::int as state_events,
    (select count(*) from public.orders)::int as orders_total,
    (select count(*) from public.order_items)::int as order_items,
    (select md5(coalesce(string_agg(id::text || ':' || stock_quantity::text, ',' order by id), '')) from public.item_variants) as stock_by_variant,
    (select md5(coalesce(string_agg(id::text || ':' || remaining_quantity::text || ':' || version::text, ',' order by id), '')) from public.order_item_allocations) as allocation_state`)).rows[0];

  /** 在庫・割当・台帳・状態の履歴・注文・受取の行数と状態（打切り・確定・訂正で動いてはならない物） */
  const untouched = (row: Awaited<ReturnType<typeof snapshot>>) => ({
    movements: row.movements, allocations: row.allocations, allocation_events: row.allocation_events, state_events: row.state_events,
    orders_total: row.orders_total, order_items: row.order_items, stock_by_variant: row.stock_by_variant, allocation_state: row.allocation_state,
    receipts: row.receipts, receipt_lines: row.receipt_lines,
  });

  // ---- 材料 ----

  /** 発注書（行ごとに別の商品・variant、仮数量 quantities）を店長が作る */
  async function setup(quantities: number[]) {
    const actor = await manager();
    const fixtures: Array<Awaited<ReturnType<typeof createCatalogFixture>>> = [];
    for (let index = 0; index < quantities.length; index += 1) fixtures.push(await createCatalogFixture(db(), { stock: 0 }));
    const order = await create(actor, fixtures.map((fixture, index) => lineOf(fixture.variantId, quantities[index])));
    const lines = await linesOf(order.id);
    return { actor, order, lines, fixtures };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const payload = (lines: LineRow[], quantities: number[], prices: Array<number | null> = []) =>
    lines.map((line, index) => ({ lineId: line.id, quantity: quantities[index], unitPriceYen: prices[index] ?? null }));

  /** 数量を確定する（最初の確定）。確定後の版を返す */
  async function confirmFirst(s: Setup, quantities: number[], prices: Array<number | null> = []): Promise<number> {
    return (await confirm({ actor: s.actor, orderId: s.order.id, version: 1, lines: payload(s.lines, quantities, prices) })).version;
  }

  /** 受取の材料: 台帳（restock）・受取・受取行・行の納品済みの更新（共通 advisory はこの試験の取引が持つ）。発注書の版は動かさない */
  async function receiveMaterial(s: Setup, lineIndex: number, quantity: number): Promise<void> {
    const line = s.lines[lineIndex];
    const operationId = await operation();
    const movement = await withLedgerLock(db(), () => db().query(
      "insert into public.stock_movements (variant_id, delta, reason) values ($1, $2, 'restock') returning id", [line.variant_id, quantity]));
    const receiptId = await insertRow('purchase_order_receipts', {
      purchase_order_id: s.order.id, kind: 'receive', received_on: '2026-10-25', actor_id: s.actor, operation_id: operationId,
    });
    await insertRow('purchase_order_receipt_lines', {
      receipt_id: receiptId, line_id: line.id, quantity, stock_movement_id: String(movement.rows[0].id),
    });
    await db().query('update public.purchase_order_lines set received_quantity = received_quantity + $2, version = version + 1 where id = $1', [line.id, quantity]);
  }

  // ---- FREQ-527-AC-01: 数量の確定 ----

  test('FREQ-527-AC-01: 数量確定で全行の確定数量が決まり段階が quantity_confirmed・未納=確定数量・版+1・最初の確定は全行に revision(quantity)（確定そのものが履歴）、changedLines は変わった行だけ、単価NULLと0が区別して残る', async () => {
    const s = await setup([5, 3, 4]);
    const before = await snapshot();
    const key = randomUUID();

    const result = await confirm({ actor: s.actor, orderId: s.order.id, version: 1, key, lines: payload(s.lines, [4, 3, 4], [1200, 0, null]) });
    expect(result).toEqual({ version: 2, changedLines: 2, replayed: false });

    expect(await orderRow(s.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: 2 });
    expect((await linesOf(s.order.id)).map((line) => [line.provisional_quantity, line.confirmed_quantity, line.received_quantity, line.outstanding_quantity, line.unit_price_yen, line.version]))
      .toEqual([[5, 4, 0, 4, 1200, 2], [3, 3, 0, 3, 0, 2], [4, 4, 0, 4, null, 2]]);

    // 最初の確定は全行が履歴に入る（前＝仮数量、後＝確定数量）。変わった行は1行目（数量 5→4 と単価の追加）と2行目（単価 NULL→0）。
    // 3行目は数量も単価も変わらないが、確定そのものの記録として入る（前後とも 4・単価 NULL）
    const revisions = (await revisionsOf(s.order.id, 'quantity')).map((row) => ({
      line_no: row.line_no, revision_no: row.revision_no, before_quantity: row.before_quantity, after_quantity: row.after_quantity,
      before_price: row.before_unit_price_yen, after_price: row.after_unit_price_yen, reason: row.reason,
    }));
    expect(revisions).toEqual([
      { line_no: 1, revision_no: 2, before_quantity: 5, after_quantity: 4, before_price: null, after_price: 1200, reason: null },
      { line_no: 2, revision_no: 2, before_quantity: 3, after_quantity: 3, before_price: null, after_price: 0, reason: null },
      { line_no: 3, revision_no: 2, before_quantity: 4, after_quantity: 4, before_price: null, after_price: null, reason: null },
    ]);
    expect((await revisionsOf(s.order.id, 'quantity')).every((row) => row.actor_id === s.actor)).toBe(true);

    const operations = (await db().query(`select operation, cause_type, cause_id, actor_id, result, fingerprint
      from private.group_g_operations where operation = 'purchase_order_quantities' and request_key = $1`, [key])).rows;
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ cause_type: 'purchase_order', cause_id: s.order.id, actor_id: s.actor, result: { version: 2, changedLines: 2, replayed: false } });
    expect(operations[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const after = await snapshot();
    expect(after).toMatchObject({ orders: before.orders, lines: before.lines, revisions: before.revisions + 3, operations: before.operations + 1 });
    expect(untouched(after)).toEqual(untouched(before));
    expect(await stageOf(s.actor, s.order.id)).toBe('quantity_confirmed');
  });

  test('FREQ-527-AC-01: 最初の確定で何も変えなくても（仮数量のまま・単価なし）、版 +1・全行の確定数量が決まり、確定そのものが全行の履歴に残る（前後とも仮数量・単価なし・入れた理由・実行者）。changedLines は 0。表示段階は quantity_confirmed', async () => {
    const s = await setup([5, 3]);
    const before = await snapshot();
    const result = await confirm({ actor: s.actor, orderId: s.order.id, version: 1, reason: '  仮数量のまま確定  ', lines: payload(s.lines, [5, 3]) });
    expect(result).toEqual({ version: 2, changedLines: 0, replayed: false });
    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.outstanding_quantity, line.unit_price_yen, line.version])).toEqual([[5, 5, null, 2], [3, 3, null, 2]]);
    expect(await orderRow(s.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: 2 });
    const revisions = await revisionsOf(s.order.id, 'quantity');
    expect(revisions.map((row) => [row.line_no, row.revision_no, row.before_quantity, row.after_quantity, row.before_unit_price_yen, row.after_unit_price_yen, row.reason, row.actor_id]))
      .toEqual([[1, 2, 5, 5, null, null, '仮数量のまま確定', s.actor], [2, 2, 3, 3, null, null, '仮数量のまま確定', s.actor]]);
    expect(revisions.every((row) => row.operation_id !== null)).toBe(true);
    expect((await snapshot()).revisions).toBe(before.revisions + 2);
    // 前後が同じ数量の履歴は表示段階の導出で数えない
    expect(await stageOf(s.actor, s.order.id)).toBe('quantity_confirmed');
  });

  test('FREQ-527-AC-01: 再確定（訂正）は変わった行だけに履歴を足す。最初の確定の全行の履歴は消えず、何も変わらない訂正は 22023 で履歴も増えない', async () => {
    const s = await setup([5, 3]);
    const v2 = await confirmFirst(s, [5, 3]);
    const afterFirst = await snapshot();
    expect((await revisionsOf(s.order.id, 'quantity')).map((row) => [row.line_no, row.revision_no])).toEqual([[1, 2], [2, 2]]);
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '同じ', lines: payload(s.lines, [5, 3]) }))).toEqual(INVALID);
    expect(await snapshot()).toEqual(afterFirst);
    const corrected = await confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '1行目だけ増やす', lines: payload(s.lines, [6, 3]) });
    expect(corrected).toEqual({ version: 3, changedLines: 1, replayed: false });
    expect((await revisionsOf(s.order.id, 'quantity')).map((row) => [row.line_no, row.revision_no, row.before_quantity, row.after_quantity]))
      .toEqual([[1, 2, 5, 5], [2, 2, 3, 3], [1, 3, 5, 6]]);
  });

  test('FREQ-527-AC-01: 最初の確定は全行を 0 にもできる（確定数量0・未納0、表示は closed）。理由は任意で、入れれば履歴に残る', async () => {
    const s = await setup([5, 3]);
    const result = await confirm({ actor: s.actor, orderId: s.order.id, version: 1, reason: '  工場が生産できない  ', lines: payload(s.lines, [0, 0]) });
    expect(result).toMatchObject({ version: 2, changedLines: 2 });
    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.outstanding_quantity])).toEqual([[0, 0], [0, 0]]);
    expect((await revisionsOf(s.order.id, 'quantity')).map((row) => [row.before_quantity, row.after_quantity, row.reason])).toEqual([[5, 0, '工場が生産できない'], [3, 0, '工場が生産できない']]);
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
  });

  test('FREQ-527-AC-01: 増やす・減らす・0にする。訂正は変化した行だけ revision を足し、版は1つ進み、理由が全ての行の履歴に入る', async () => {
    const s = await setup([5, 3, 4]);
    const v2 = await confirmFirst(s, [4, 3, 4]);

    const raised = await confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '工場の増産', lines: payload(s.lines, [10, 0, 2]) });
    expect(raised).toEqual({ version: 3, changedLines: 3, replayed: false });
    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.outstanding_quantity, line.version])).toEqual([[10, 10, 3], [0, 0, 3], [2, 2, 3]]);
    expect((await revisionsOf(s.order.id, 'quantity')).filter((row) => row.revision_no === 3).map((row) => [row.line_no, row.before_quantity, row.after_quantity, row.reason]))
      .toEqual([[1, 4, 10, '工場の増産'], [2, 3, 0, '工場の増産'], [3, 4, 2, '工場の増産']]);
    expect(await stageOf(s.actor, s.order.id)).toBe('quantity_confirmed');

    // 1行目と3行目を 0 にする。2行目は変わらない（履歴に入らない）。全行の未納が0で納品も0なので表示は closed
    const zero = await confirm({ actor: s.actor, orderId: s.order.id, version: 3, reason: '全部やめる', lines: payload(s.lines, [0, 0, 0]) });
    expect(zero).toEqual({ version: 4, changedLines: 2, replayed: false });
    expect((await revisionsOf(s.order.id, 'quantity')).filter((row) => row.revision_no === 4).map((row) => row.line_no)).toEqual([1, 3]);
    expect((await linesOf(s.order.id)).map((line) => line.version)).toEqual([4, 3, 4]);
    expect(await orderRow(s.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: 4 });
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
  });

  test('FREQ-527-AC-01: 単価だけの変更（登録・変更・NULL へ戻す）も revision(quantity) に残り、before_quantity = after_quantity（現在の数量）', async () => {
    const s = await setup([6]);
    const v2 = await confirmFirst(s, [6]);
    const added = await confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '見積が届いた', lines: payload(s.lines, [6], [500]) });
    expect(added.changedLines).toBe(1);
    const changed = await confirm({ actor: s.actor, orderId: s.order.id, version: added.version, reason: '値上がり', lines: payload(s.lines, [6], [650]) });
    const cleared = await confirm({ actor: s.actor, orderId: s.order.id, version: changed.version, reason: '見積を取り消し', lines: payload(s.lines, [6], [null]) });
    expect(cleared.version).toBe(5);
    expect((await revisionsOf(s.order.id, 'quantity')).map((row) => [row.revision_no, row.before_quantity, row.after_quantity, row.before_unit_price_yen, row.after_unit_price_yen, row.reason]))
      .toEqual([
        [2, 6, 6, null, null, null], // 最初の確定そのものの履歴（仮数量のまま・単価なし）
        [3, 6, 6, null, 500, '見積が届いた'], [4, 6, 6, 500, 650, '値上がり'], [5, 6, 6, 650, null, '見積を取り消し'],
      ]);
    expect((await linesOf(s.order.id))[0]).toMatchObject({ confirmed_quantity: 6, unit_price_yen: null, version: 5 });
  });

  test('FREQ-527-AC-01: 単価 0 と未入力（NULL）は別物。NULL→0 も 0→NULL も変化として履歴に残り、変わらなければ訂正にならない', async () => {
    const s = await setup([2]);
    const v2 = await confirmFirst(s, [2]);
    const zero = await confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '無償', lines: payload(s.lines, [2], [0]) });
    expect((await linesOf(s.order.id))[0].unit_price_yen).toBe(0);
    expect((await revisionsOf(s.order.id, 'quantity')).at(-1)).toMatchObject({ before_unit_price_yen: null, after_unit_price_yen: 0 });
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: zero.version, reason: '同じ', lines: payload(s.lines, [2], [0]) }))).toEqual(INVALID);
    const none = await confirm({ actor: s.actor, orderId: s.order.id, version: zero.version, reason: '未登録へ', lines: payload(s.lines, [2], [null]) });
    expect(none.changedLines).toBe(1);
    expect((await revisionsOf(s.order.id, 'quantity')).at(-1)).toMatchObject({ before_unit_price_yen: 0, after_unit_price_yen: null });
  });

  test('FREQ-527-AC-01: 上限ちょうど（数量99999・単価9999999・100行）は通る', async () => {
    const actor = await manager();
    const itemId = Number((await db().query(`insert into public.items (name, description, price, category, image_url, status)
      values ('fx-qty-' || gen_random_uuid()::text, '上限', 5000, 'TOPS', 'https://example.com/item.png', 'published') returning id`)).rows[0].id);
    const variants: number[] = [];
    for (let position = 1; position <= 100; position += 1) {
      const sizeId = Number((await db().query('insert into public.item_sizes (item_id, label, position) values ($1, $2, $3) returning id', [itemId, `S${position}`, position])).rows[0].id);
      variants.push(Number((await db().query('insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, null, $2, true) returning id', [itemId, sizeId])).rows[0].id));
    }
    const order = await create(actor, variants.map((variantId) => lineOf(variantId, 99999)));
    const lines = await linesOf(order.id);
    const result = await confirm({ actor, orderId: order.id, version: 1, lines: payload(lines, lines.map(() => 99999), lines.map(() => 9999999)) });
    expect(result).toMatchObject({ version: 2, changedLines: 100 });
    expect((await linesOf(order.id)).every((line) => line.confirmed_quantity === 99999 && line.unit_price_yen === 9999999)).toBe(true);
  });

  test('FREQ-527-AC-01: 訂正は理由が要る（無い・空白だけは GROUP_G_PO_REASON_REQUIRED）。納品済み未満は GROUP_G_PO_QUANTITY_BELOW_RECEIVED で、前の版の revision は消えない', async () => {
    const s = await setup([5, 3]);
    const v2 = await confirmFirst(s, [5, 3], [100, 200]);
    await receiveMaterial(s, 0, 2);
    const before = await snapshot();
    const earlier = await revisionsOf(s.order.id);
    expect(earlier.filter((row) => row.revision_no === 2)).toHaveLength(2);

    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: v2, lines: payload(s.lines, [4, 3], [100, 200]) }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '  \t ', lines: payload(s.lines, [4, 3], [100, 200]) }))).toEqual(REASON_REQUIRED);
    // 納品済み 2 に対して 1 は不可、0 も不可。ちょうど 2 は可
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '減らす', lines: payload(s.lines, [1, 3], [100, 200]) }))).toEqual(BELOW_RECEIVED);
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '減らす', lines: payload(s.lines, [0, 3], [100, 200]) }))).toEqual(BELOW_RECEIVED);
    // 何も変わらない訂正は 22023
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '同じ', lines: payload(s.lines, [5, 3], [100, 200]) }))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);

    const ok = await confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '納品済みまで減らす', lines: payload(s.lines, [2, 3], [100, 200]) });
    expect(ok).toEqual({ version: 3, changedLines: 1, replayed: false });
    expect((await linesOf(s.order.id))[0]).toMatchObject({ confirmed_quantity: 2, received_quantity: 2, outstanding_quantity: 0 });
    const later = await revisionsOf(s.order.id);
    expect(later).toHaveLength(earlier.length + 1);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
    expect(later.at(-1)).toMatchObject({ kind: 'quantity', revision_no: 3, before_quantity: 5, after_quantity: 2, reason: '納品済みまで減らす' });
  });

  test('FREQ-527-AC-01: 最初の確定は理由が空でも通る（理由は任意）。ただし範囲外の理由（201字）は 22023', async () => {
    const s = await setup([5]);
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: 1, reason: 'あ'.repeat(201), lines: payload(s.lines, [5]) }))).toEqual(INVALID);
    const ok = await confirm({ actor: s.actor, orderId: s.order.id, version: 1, reason: 'あ'.repeat(200), lines: payload(s.lines, [4]) });
    expect(ok.version).toBe(2);
    expect((await revisionsOf(s.order.id, 'quantity'))[0].reason).toBe('あ'.repeat(200));
  });

  test('FREQ-527-AC-01: 引数（行の形・数量や単価の範囲と型・行の重複・不足・他の発注書の行・理由の長さ・NULL）は 22023 で、何も残らない', async () => {
    const s = await setup([5, 3, 4]);
    const other = await setup([1, 1, 1]);
    const ok = payload(s.lines, [1, 1, 1]);
    const before = await snapshot();
    const withLine = (index: number, change: Record<string, unknown>) => ok.map((line, position) => (position === index ? { ...line, ...change } : line));
    const base = { actor: s.actor, orderId: s.order.id, version: 1 };

    const cases: Array<[string, ConfirmArgs]> = [
      ['行が SQL の NULL', { ...base }],
      ['行が JSON の null', { ...base, lines: null }],
      ['行が object', { ...base, lines: { lineId: s.lines[0].id, quantity: 1, unitPriceYen: null } }],
      ['行が文字列', { ...base, lines: 'x' }],
      ['行が0件', { ...base, lines: [] }],
      ['行が101件', { ...base, lines: Array.from({ length: 101 }, () => ok[0]) }],
      ['行が足りない（2/3）', { ...base, lines: ok.slice(0, 2) }],
      ['行が重複（3件のうち同じ行が2回）', { ...base, lines: [ok[0], ok[0], ok[2]] }],
      ['行が多すぎる（同じ行を足して4件）', { ...base, lines: [...ok, ok[0]] }],
      ['他の発注書の行が混じる', { ...base, lines: [ok[0], ok[1], { ...ok[2], lineId: other.lines[0].id }] }],
      ['全て他の発注書の行', { ...base, lines: payload(other.lines, [1, 1, 1]) }],
      ['存在しない行', { ...base, lines: [ok[0], ok[1], { ...ok[2], lineId: randomUUID() }] }],
      ['要素が object でない', { ...base, lines: [5, ok[1], ok[2]] }],
      ['要素が配列', { ...base, lines: [[1], ok[1], ok[2]] }],
      ['項目が余分', { ...base, lines: withLine(0, { extra: 1 }) }],
      ['unitPriceYen が無い', { ...base, lines: withLine(0, { unitPriceYen: undefined }) }],
      ['quantity が無い', { ...base, lines: withLine(0, { quantity: undefined }) }],
      ['項目名が違う', { ...base, lines: [{ lineId: s.lines[0].id, qty: 1, unitPriceYen: null }, ok[1], ok[2]] }],
      ['lineId が uuid でない', { ...base, lines: withLine(0, { lineId: 'x' }) }],
      ['lineId が数値', { ...base, lines: withLine(0, { lineId: 5 }) }],
      ['数量が負', { ...base, lines: withLine(0, { quantity: -1 }) }],
      ['数量が100000', { ...base, lines: withLine(0, { quantity: 100000 }) }],
      ['数量が小数', { ...base, lines: withLine(0, { quantity: 1.5 }) }],
      ['数量が文字列', { ...base, lines: withLine(0, { quantity: '5' }) }],
      ['数量が null', { ...base, lines: withLine(0, { quantity: null }) }],
      ['単価が負', { ...base, lines: withLine(0, { unitPriceYen: -1 }) }],
      ['単価が10000000', { ...base, lines: withLine(0, { unitPriceYen: 10000000 }) }],
      ['単価が小数', { ...base, lines: withLine(0, { unitPriceYen: 1.5 }) }],
      ['単価が文字列', { ...base, lines: withLine(0, { unitPriceYen: '100' }) }],
      ['単価が真偽値', { ...base, lines: withLine(0, { unitPriceYen: true }) }],
      ['理由が201字', { ...base, lines: ok, reason: 'あ'.repeat(201) }],
      ['発注書の id が NULL', { ...base, orderId: null, lines: ok }],
      ['版が NULL', { ...base, version: null, lines: ok }],
      ['版が0', { ...base, version: 0, lines: ok }],
      ['実行者が NULL', { ...base, actor: null, lines: ok }],
      ['要求番号が NULL', { ...base, key: null, lines: ok }],
    ];
    for (const [name, args] of cases) {
      expect({ name, ...(await rejected(() => confirm(args))) }).toEqual({ name, ...INVALID });
    }
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-527-AC-01: 引数の誤りは権限より先に断る（権限の無い実行者でも 22023）が、正しい引数なら権限（42501）が存在の確かめ（P0002）より先', async () => {
    const outsider = await createActor([]);
    const s = await setup([2]);
    expect(await rejected(() => confirm({ actor: outsider, orderId: s.order.id, version: 1, lines: [] }))).toEqual(INVALID);
    expect(await rejected(() => confirm({ actor: outsider, orderId: s.order.id, version: 1, lines: payload(s.lines, [1]) }))).toEqual(FORBIDDEN);
    expect(await rejected(() => confirm({ actor: outsider, orderId: randomUUID(), version: 1, lines: payload(s.lines, [1]) }))).toEqual(FORBIDDEN);
    expect(await rejected(() => confirm({ actor: s.actor, orderId: randomUUID(), version: 1, lines: payload(s.lines, [1]) }))).toEqual(NOT_FOUND);
  });

  // ---- FREQ-527-AC-02: 版・確定前の取消・未納の発注済みへの計上 ----

  test('FREQ-527-AC-02: 版が違うと GROUP_G_PO_VERSION_CONFLICT で何も変わらない（確定・訂正・打切り・発注先の訂正の4つとも）。同じ版の再読込でやり直せる', async () => {
    const s = await setup([5, 3]);
    const before = await snapshot();
    const ids = s.lines.map((line) => line.id);
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: 2, lines: payload(s.lines, [4, 3]) }))).toEqual(VERSION_CONFLICT);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: 2, lineIds: ids, reason: '取消' }))).toEqual(VERSION_CONFLICT);
    expect(await rejected(() => header({ actor: s.actor, orderId: s.order.id, version: 2, supplier: '工場B', reason: '改称' }))).toEqual(VERSION_CONFLICT);
    expect(await snapshot()).toEqual(before);

    const v2 = await confirmFirst(s, [4, 3]);
    // 古い版（1）のままの訂正・打切り・発注先の訂正は断る
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: 1, reason: '訂正', lines: payload(s.lines, [5, 3]) }))).toEqual(VERSION_CONFLICT);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: 1, lineIds: [ids[0]], reason: '打切り' }))).toEqual(VERSION_CONFLICT);
    expect(await rejected(() => header({ actor: s.actor, orderId: s.order.id, version: 1, supplier: '工場B', reason: '改称' }))).toEqual(VERSION_CONFLICT);
    expect(await orderRow(s.order.id)).toMatchObject({ version: v2, supplier_name: '工場A' });
    const again = await confirm({ actor: s.actor, orderId: s.order.id, version: v2, reason: '訂正', lines: payload(s.lines, [5, 3]) });
    expect(again.version).toBe(3);
  });

  test('FREQ-527-AC-02: 確定前の受取はできない（確定前の行は確定数量も未納も NULL で、納品済みを足す更新は表の CHECK が断る）。確定すると未納が発注済みに入る', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 5, fulfillmentType: 'backorder', reserved: false }] });
    const order = await create(actor, [lineOf(c.variantId, 10)]);
    const lines = await linesOf(order.id);
    expect(lines[0]).toMatchObject({ confirmed_quantity: null, outstanding_quantity: null });

    expect(await rejected(() => db().query('update public.purchase_order_lines set received_quantity = 1, version = version + 1 where id = $1', [lines[0].id])))
      .toEqual({ code: '23514', message: expect.stringContaining('purchase_order_lines_unconfirmed_received_check') });

    const stock = async () => {
      const rows = (await db().query('select * from public.list_admin_inventory($1::uuid)', [actor])).rows;
      const row = rows.find((candidate) => candidate.variant_id === String(c.variantId));
      return row && { order_quantity: row.order_quantity, on_order: row.on_order, required: row.required };
    };
    // 仮数量10は数えない
    expect(await stock()).toEqual({ order_quantity: 5, on_order: 0, required: 5 });
    await confirm({ actor, orderId: order.id, version: 1, lines: payload(lines, [3], [900]) });
    // 確定数量3の未納3が発注済みに入る
    expect(await stock()).toEqual({ order_quantity: 5, on_order: 3, required: 2 });
  });

  test('FREQ-527-AC-02: 確定前の発注書は全行を渡せば打切り（取消）でき、一部の行だけは 22023（一部の行や他の発注書の行を混ぜても同じ）', async () => {
    const s = await setup([5, 3]);
    const other = await setup([1, 1]);
    const before = await snapshot();
    const ids = s.lines.map((line) => line.id);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: 1, lineIds: [ids[0]], reason: '一部' }))).toEqual(INVALID);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: 1, lineIds: [ids[0], other.lines[0].id], reason: '混ぜる' }))).toEqual(INVALID);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: 1, lineIds: [ids[0], ids[1], other.lines[0].id], reason: '多い' }))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);

    const cancelled = await shortClose({ actor: s.actor, orderId: s.order.id, version: 1, lineIds: [ids[1], ids[0]], reason: '発注をやめる' });
    expect(cancelled).toEqual({ version: 2, closedQuantity: 8, replayed: false });
  });

  // ---- 再送 ----

  test('FREQ-527-AC-01: 同じ要求番号・同じ内容の再送は同じ結果（replayed:true）・行数増加0。版が進んだ後に古い版で再送しても保存した結果を返す。内容（行・理由・実行者）が違えば 23505', async () => {
    const s = await setup([5, 3]);
    const other = await manager();
    const key = randomUUID();
    const first = await confirm({ actor: s.actor, orderId: s.order.id, version: 1, key, lines: payload(s.lines, [4, 3], [100, null]) });
    const after = await snapshot();

    // 明細の並びが違っても同じ内容。理由の前後の空白も同じ
    const reordered = await confirm({ actor: s.actor, orderId: s.order.id, version: 1, key, lines: [...payload(s.lines, [4, 3], [100, null])].reverse() });
    expect(reordered).toEqual({ ...first, replayed: true });
    // 版が進んだ（2）後に古い版（1）で再送しても、保存した結果を返す
    const stale = await confirm({ actor: s.actor, orderId: s.order.id, version: 1, key, lines: payload(s.lines, [4, 3], [100, null]), schema: 'private' });
    expect(stale).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(after);
    expect((await db().query("select result from private.group_g_operations where operation = 'purchase_order_quantities' and request_key = $1", [key])).rows[0].result.replayed).toBe(false);

    const variants: Array<[string, ConfirmArgs]> = [
      ['数量', { lines: payload(s.lines, [5, 3], [100, null]) }],
      ['単価', { lines: payload(s.lines, [4, 3], [100, 0]) }],
      ['理由', { lines: payload(s.lines, [4, 3], [100, null]), reason: '別の理由' }],
      ['実行者', { lines: payload(s.lines, [4, 3], [100, null]), actor: other }],
    ];
    for (const [name, args] of variants) {
      expect({ name, ...(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: 1, key, ...args }))) }).toEqual({ name, ...CONFLICT });
    }
    expect(await snapshot()).toEqual(after);
  });

  test('FREQ-528-AC-01: 打切りの再送は同じ結果で何も増えず、内容が違えば 23505。発注先の訂正も同じ', async () => {
    const s = await setup([10, 4]);
    const v2 = await confirmFirst(s, [10, 4]);
    await receiveMaterial(s, 0, 6);
    const ids = s.lines.map((line) => line.id);
    const key = randomUUID();
    const first = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[0]], reason: '打切り', key });
    const after = await snapshot();
    expect(await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[0]], reason: '打切り', key })).toEqual({ ...first, replayed: true });
    expect(await shortClose({ actor: s.actor, orderId: s.order.id, version: first.version, lineIds: [ids[0]], reason: ' 打切り ', key, schema: 'private' })).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(after);
    for (const args of [{ lineIds: [ids[0], ids[1]] }, { reason: '別の理由' }]) {
      expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[0]], reason: '打切り', key, ...args }))).toEqual(CONFLICT);
    }

    const headerKey = randomUUID();
    const renamed = await header({ actor: s.actor, orderId: s.order.id, version: first.version, supplier: '工場B', memo: '改称', reason: '社名変更', key: headerKey });
    const afterHeader = await snapshot();
    expect(await header({ actor: s.actor, orderId: s.order.id, version: first.version, supplier: ' 工場B ', memo: ' 改称 ', reason: '社名変更', key: headerKey })).toEqual({ ...renamed, replayed: true });
    expect(await rejected(() => header({ actor: s.actor, orderId: s.order.id, version: first.version, supplier: '工場C', memo: '改称', reason: '社名変更', key: headerKey }))).toEqual(CONFLICT);
    expect(await snapshot()).toEqual(afterHeader);
  });

  test('FREQ-527-AC-01: 同じ要求番号でも別の操作（数量・打切り・発注先）の受付は別の枠。別の実行者には再送の結果を見せない（権限が無ければ GROUP_G_FORBIDDEN）', async () => {
    const s = await setup([5]);
    const key = randomUUID();
    await confirm({ actor: s.actor, orderId: s.order.id, version: 1, key, lines: payload(s.lines, [5], [100]) });
    // 同じ key の別操作は受け付けられる
    await header({ actor: s.actor, orderId: s.order.id, version: 2, supplier: '工場B', reason: '改称', key });
    const outsider = await createActor([]);
    expect(await rejected(() => confirm({ actor: outsider, orderId: s.order.id, version: 1, key, lines: payload(s.lines, [5], [100]) }))).toEqual(FORBIDDEN);
  });

  // ---- FREQ-528: 残りを打ち切る ----

  test('FREQ-528-AC-01: 確定10・納品6 の行を打ち切ると 発注数量6・納品済み6・未納0、short_closures に closed_quantity=4・理由・実行者・時刻、revision before=10 after=6', async () => {
    const s = await setup([10]);
    const v2 = await confirmFirst(s, [10]);
    await receiveMaterial(s, 0, 6);
    const before = await snapshot();
    const lineBefore = (await linesOf(s.order.id))[0];

    const result = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [s.lines[0].id], reason: '工場の都合' });
    expect(result).toEqual({ version: 3, closedQuantity: 4, replayed: false });

    const line = (await linesOf(s.order.id))[0];
    expect(line).toMatchObject({ confirmed_quantity: 6, received_quantity: 6, outstanding_quantity: 0, version: lineBefore.version + 1 });
    expect(await orderRow(s.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: 3 });

    const closures = await closuresOf(s.order.id);
    expect(closures).toHaveLength(1);
    expect(closures[0]).toMatchObject({ line_no: 1, closed_quantity: 4, reason: '工場の都合', actor_id: s.actor });
    expect(closures[0].created_at).toBeInstanceOf(Date);
    const revision = (await revisionsOf(s.order.id, 'short_close'))[0];
    expect(revision).toMatchObject({ line_no: 1, revision_no: 3, before_quantity: 10, after_quantity: 6, reason: '工場の都合', actor_id: s.actor });
    expect(closures[0].revision_id).toBe((await db().query("select id from public.purchase_order_revisions where purchase_order_id = $1 and kind = 'short_close'", [s.order.id])).rows[0].id);

    const operation = (await db().query(`select cause_type, cause_id, actor_id, result from private.group_g_operations
      where operation = 'purchase_order_short_close' and cause_id = $1`, [s.order.id])).rows;
    expect(operation).toEqual([{ cause_type: 'purchase_order', cause_id: s.order.id, actor_id: s.actor, result: { version: 3, closedQuantity: 4, replayed: false } }]);

    const after = await snapshot();
    expect(after).toMatchObject({ short_closures: before.short_closures + 1, revisions: before.revisions + 1, operations: before.operations + 1 });
    expect(untouched(after)).toEqual(untouched(before));
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
  });

  test('FREQ-528-AC-01: 複数行の打切りは選んだ行だけ（確定=納品の行や選ばない行は動かない）。closedQuantity は未納の合計', async () => {
    const s = await setup([10, 8, 5]);
    const v2 = await confirmFirst(s, [10, 8, 5]);
    await receiveMaterial(s, 0, 6);
    const ids = s.lines.map((line) => line.id);
    const result = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[1], ids[0]], reason: '二行を打ち切る' });
    expect(result.closedQuantity).toBe(4 + 8);
    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.received_quantity, line.outstanding_quantity])).toEqual([[6, 6, 0], [0, 0, 0], [5, 0, 5]]);
    expect((await closuresOf(s.order.id)).map((row) => [row.line_no, row.closed_quantity])).toEqual([[1, 4], [2, 8]]);
    expect((await revisionsOf(s.order.id, 'short_close')).map((row) => [row.line_no, row.before_quantity, row.after_quantity])).toEqual([[1, 10, 6], [2, 8, 0]]);
    // 残りの行（3行目）に未納があるので表示は partially_received（受取が1つ以上・未納が残る）
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');
  });

  test('FREQ-528-AC-02: 未納0の行を含む打切りは GROUP_G_PO_NOTHING_TO_CLOSE で何も変わらない。理由が無ければ GROUP_G_PO_REASON_REQUIRED、空・重複は 22023', async () => {
    const s = await setup([4, 3]);
    const v2 = await confirmFirst(s, [4, 3]);
    await receiveMaterial(s, 0, 4);
    const ids = s.lines.map((line) => line.id);
    const before = await snapshot();
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[0], ids[1]], reason: '全部' }))).toEqual(NOTHING_TO_CLOSE);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[0]], reason: '納品済みの行' }))).toEqual(NOTHING_TO_CLOSE);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[1]] }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[1]], reason: '   ' }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [], reason: '空' }))).toEqual(INVALID);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[1], ids[1]], reason: '重複' }))).toEqual(INVALID);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[1], null], reason: 'NULL' }))).toEqual(INVALID);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: null, reason: 'NULL' }))).toEqual(INVALID);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [randomUUID()], reason: '存在しない行' }))).toEqual(INVALID);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [ids[1]], reason: 'あ'.repeat(201) }))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-528-AC-02: 他の発注書の行を混ぜた打切りは 22023（確定後も）。理由が空の打切りは権限より前に断る', async () => {
    const s = await setup([4]);
    const other = await setup([4]);
    const v2 = await confirmFirst(s, [4]);
    await confirmFirst(other, [4]);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [other.lines[0].id], reason: '他の発注書' }))).toEqual(INVALID);
    const outsider = await createActor([]);
    expect(await rejected(() => shortClose({ actor: outsider, orderId: s.order.id, version: v2, lineIds: [s.lines[0].id] }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => shortClose({ actor: outsider, orderId: s.order.id, version: v2, lineIds: [s.lines[0].id], reason: '権限なし' }))).toEqual(FORBIDDEN);
  });

  test('FREQ-528-AC-02: 誤った打切りは理由付き再確定で元の数量へ戻せ、元の short_closure と revision は残る（戻した記録が新しい版として足される）', async () => {
    const s = await setup([10]);
    const v2 = await confirmFirst(s, [10]);
    await receiveMaterial(s, 0, 6);
    const closed = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [s.lines[0].id], reason: '間違えて打切り' });
    const closedAt = await closuresOf(s.order.id);

    // 理由なしの再確定は断る。理由つきなら 10 へ戻せる
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: closed.version, lines: payload(s.lines, [10]) }))).toEqual(REASON_REQUIRED);
    const restored = await confirm({ actor: s.actor, orderId: s.order.id, version: closed.version, reason: '打切りは誤り', lines: payload(s.lines, [10]) });
    expect(restored).toEqual({ version: 4, changedLines: 1, replayed: false });
    expect((await linesOf(s.order.id))[0]).toMatchObject({ confirmed_quantity: 10, received_quantity: 6, outstanding_quantity: 4 });

    expect(await closuresOf(s.order.id)).toEqual(closedAt);
    expect((await revisionsOf(s.order.id, 'short_close')).map((row) => [row.revision_no, row.before_quantity, row.after_quantity, row.reason])).toEqual([[3, 10, 6, '間違えて打切り']]);
    expect((await revisionsOf(s.order.id, 'quantity')).at(-1)).toMatchObject({ revision_no: 4, before_quantity: 6, after_quantity: 10, reason: '打切りは誤り' });
    // 戻したので、受取が1つ以上あり未納が残る = partially_received
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');
  });

  // ---- 発注全体の取消 ----

  test('FREQ-528-AC-02: 発注全体の取消（確定前）: 全行を打ち切ると 確定数量0・段階 quantity_confirmed・表示 closed・short_closures に仮数量・revision(short_close, before=仮数量, after=0, 理由)', async () => {
    const s = await setup([5, 3, 4]);
    const before = await snapshot();
    const result = await shortClose({ actor: s.actor, orderId: s.order.id, version: 1, lineIds: s.lines.map((line) => line.id), reason: '発注を取り消す' });
    expect(result).toEqual({ version: 2, closedQuantity: 12, replayed: false });

    expect(await orderRow(s.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: 2 });
    expect((await linesOf(s.order.id)).map((line) => [line.provisional_quantity, line.confirmed_quantity, line.received_quantity, line.outstanding_quantity, line.version])).toEqual([[5, 0, 0, 0, 2], [3, 0, 0, 0, 2], [4, 0, 0, 0, 2]]);
    expect((await closuresOf(s.order.id)).map((row) => [row.line_no, row.closed_quantity, row.reason])).toEqual([[1, 5, '発注を取り消す'], [2, 3, '発注を取り消す'], [3, 4, '発注を取り消す']]);
    expect((await revisionsOf(s.order.id, 'short_close')).map((row) => [row.line_no, row.revision_no, row.before_quantity, row.after_quantity, row.reason, row.actor_id]))
      .toEqual([[1, 2, 5, 0, '発注を取り消す', s.actor], [2, 2, 3, 0, '発注を取り消す', s.actor], [3, 2, 4, 0, '発注を取り消す', s.actor]]);
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
    const after = await snapshot();
    expect(after).toMatchObject({ short_closures: before.short_closures + 3, revisions: before.revisions + 3 });
    expect(untouched(after)).toEqual(untouched(before));
  });

  test('FREQ-528-AC-02: 取消した発注書も理由付きの訂正で数量を入れ直せる（確定前の取消は取り消せないのではなく、訂正で戻す）', async () => {
    const s = await setup([5, 3]);
    await shortClose({ actor: s.actor, orderId: s.order.id, version: 1, lineIds: s.lines.map((line) => line.id), reason: '一旦取り消す' });
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: 2, lines: payload(s.lines, [5, 3]) }))).toEqual(REASON_REQUIRED);
    const again = await confirm({ actor: s.actor, orderId: s.order.id, version: 2, reason: '取消は誤り', lines: payload(s.lines, [5, 3], [1000, 2000]) });
    expect(again).toEqual({ version: 3, changedLines: 2, replayed: false });
    expect(await stageOf(s.actor, s.order.id)).toBe('quantity_confirmed');
  });

  test('FREQ-528-AC-02: 確定後の全体の取消は 受取なしの全行が closed、受取ありは残数だけ終了し受取の記録が残る（入庫・台帳・割当は動かない）', async () => {
    const s = await setup([5, 4]);
    const v2 = await confirmFirst(s, [5, 4]);
    await receiveMaterial(s, 0, 2);
    const before = await snapshot();
    const result = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: s.lines.map((line) => line.id), reason: '全体を打ち切る' });
    expect(result).toEqual({ version: 3, closedQuantity: 3 + 4, replayed: false });
    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.received_quantity, line.outstanding_quantity])).toEqual([[2, 2, 0], [0, 0, 0]]);
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
    const after = await snapshot();
    // 受取（1件・受取行1件）と台帳・在庫は打切りの前後で同じ
    expect(untouched(after)).toEqual(untouched(before));
    expect(after.receipts).toBe(before.receipts);
    expect(after.receipt_lines).toBe(before.receipt_lines);
    expect((await db().query('select count(*)::int as n from public.purchase_order_receipt_lines rl join public.purchase_order_lines l on l.id = rl.line_id where l.purchase_order_id = $1', [s.order.id])).rows[0].n).toBe(1);
  });

  // ---- 発注必要数・表示段階 ----

  test('FREQ-525-AC-02: 打切りで発注済みが減り、list_admin_inventory の required が増える', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 0 });
    await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 5, fulfillmentType: 'backorder', reserved: false }] });
    const order = await create(actor, [lineOf(c.variantId, 10)]);
    const lines = await linesOf(order.id);
    const s: Setup = { actor, order, lines, fixtures: [{ ...c }] };
    const numbers = async () => {
      const rows = (await db().query('select * from public.list_admin_inventory($1::uuid)', [actor])).rows;
      const row = rows.find((candidate) => candidate.variant_id === String(c.variantId));
      return row && { on_hand: row.on_hand, order_quantity: row.order_quantity, on_order: row.on_order, required: row.required };
    };
    expect(await numbers()).toEqual({ on_hand: 0, order_quantity: 5, on_order: 0, required: 5 });

    const v2 = await confirmFirst(s, [6]);
    expect(await numbers()).toEqual({ on_hand: 0, order_quantity: 5, on_order: 6, required: 0 });

    await receiveMaterial(s, 0, 2);
    expect(await numbers()).toEqual({ on_hand: 2, order_quantity: 5, on_order: 4, required: 0 });

    await shortClose({ actor, orderId: order.id, version: v2, lineIds: [lines[0].id], reason: '残りを打ち切る' });
    // 確定数量が納品済み 2 まで下がり、未納 0。発注必要数は 5 − 2 − 0 = 3 に戻って増える
    expect(await numbers()).toEqual({ on_hand: 2, order_quantity: 5, on_order: 0, required: 3 });
  });

  test('FREQ-526-AC-05: 表示段階 closed は誤った打切りを再確定で戻して全て受け取ると received になる（sticky でない）', async () => {
    const s = await setup([10]);
    const v2 = await confirmFirst(s, [10]);
    await receiveMaterial(s, 0, 6);
    const closed = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [s.lines[0].id], reason: '誤った打切り' });
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');

    await confirm({ actor: s.actor, orderId: s.order.id, version: closed.version, reason: '戻す', lines: payload(s.lines, [10]) });
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');
    await receiveMaterial(s, 0, 4);
    expect((await linesOf(s.order.id))[0]).toMatchObject({ confirmed_quantity: 10, received_quantity: 10, outstanding_quantity: 0 });
    expect(await stageOf(s.actor, s.order.id)).toBe('received');
  });

  test('FREQ-526-AC-05: 打切りの後に単価だけを足しても表示段階は closed のまま（price-only の版は before_quantity = after_quantity で、打切りを戻さない）。数量が実際に変わると打切りは戻る', async () => {
    const s = await setup([10]);
    const v2 = await confirmFirst(s, [10]);
    await receiveMaterial(s, 0, 6);
    const closed = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [s.lines[0].id], reason: '打切り' });
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');

    // 単価だけ（数量は現在の 6 のまま）
    const priced = await confirm({ actor: s.actor, orderId: s.order.id, version: closed.version, reason: '単価の登録', lines: payload(s.lines, [6], [500]) });
    expect(priced).toMatchObject({ version: 4, changedLines: 1 });
    const priceRevision = (await revisionsOf(s.order.id, 'quantity')).at(-1);
    expect(priceRevision).toMatchObject({ revision_no: 4, before_quantity: 6, after_quantity: 6, before_unit_price_yen: null, after_unit_price_yen: 500 });
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
    // 単価をもう一度直しても同じ
    const repriced = await confirm({ actor: s.actor, orderId: s.order.id, version: priced.version, reason: '値上がり', lines: payload(s.lines, [6], [650]) });
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');

    // 数量が実際に変わる訂正（6 → 8）は打切りを戻し、未納 2 が残るので partially_received
    const raised = await confirm({ actor: s.actor, orderId: s.order.id, version: repriced.version, reason: '数量を戻す', lines: payload(s.lines, [8], [650]) });
    expect((await revisionsOf(s.order.id, 'quantity')).at(-1)).toMatchObject({ before_quantity: 6, after_quantity: 8, before_unit_price_yen: 650, after_unit_price_yen: 650 });
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');
    // 納品済みまで減らす訂正（8 → 6）も数量が変わる版なので、打切りは戻ったまま。未納0・納品あり・打切りなし = received
    await confirm({ actor: s.actor, orderId: s.order.id, version: raised.version, reason: '減らす', lines: payload(s.lines, [6], [650]) });
    expect(await stageOf(s.actor, s.order.id)).toBe('received');
  });

  test('FREQ-526-AC-05: 別の行の数量訂正は、打切り済みの行の打切りを戻さない（行ごとに最新の数量の版を見る。発注書全体の最新の版ではない）', async () => {
    const s = await setup([4, 4]);
    const v2 = await confirmFirst(s, [4, 4]);
    await receiveMaterial(s, 0, 2);
    await receiveMaterial(s, 1, 1);
    // 2行目（確定4・納品1）だけを打ち切る: 確定数量1・未納0。1行目の未納が2残るので partially_received
    const closed = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [s.lines[1].id], reason: '2行目を打ち切る' });
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');
    // 1行目を納品済み(2)まで減らす訂正（数量が変わる版）。2行目の打切りが有効なまま、全行の未納が0 = closed
    await confirm({ actor: s.actor, orderId: s.order.id, version: closed.version, reason: '1行目を減らす', lines: payload(s.lines, [2, 1]) });
    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.received_quantity, line.outstanding_quantity])).toEqual([[2, 2, 0], [1, 1, 0]]);
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
  });

  // ---- 発注先・メモの訂正 ----

  test('FREQ-527-AC-01: 発注先・メモの訂正は 理由が要り、前後の空白を落として保存し、revision(header) に 前後の発注先とメモを残して版を1つ進める。段階・明細は動かさない', async () => {
    const s = await setup([5]);
    const before = await snapshot();
    const lineBefore = await linesOf(s.order.id);
    expect(await rejected(() => header({ actor: s.actor, orderId: s.order.id, version: 1, supplier: '工場B', memo: '新しいメモ' }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => header({ actor: s.actor, orderId: s.order.id, version: 1, supplier: '工場B', memo: '新しいメモ', reason: '  ' }))).toEqual(REASON_REQUIRED);

    const result = await header({ actor: s.actor, orderId: s.order.id, version: 1, supplier: '  工場B\t', memo: ' 新しいメモ ', reason: '社名変更' });
    expect(result).toEqual({ version: 2, replayed: false });
    expect(await orderRow(s.order.id)).toEqual({ stage: 'ordered', version: 2, supplier_name: '工場B', memo: '新しいメモ' });
    expect(await linesOf(s.order.id)).toEqual(lineBefore);

    const revisions = (await revisionsOf(s.order.id, 'header')).map((row) => ({
      line_no: row.line_no, revision_no: row.revision_no, before_supplier_name: row.before_supplier_name, after_supplier_name: row.after_supplier_name,
      before_memo: row.before_memo, after_memo: row.after_memo, reason: row.reason, actor_id: row.actor_id,
    }));
    expect(revisions).toEqual([{ line_no: null, revision_no: 2, before_supplier_name: '工場A', after_supplier_name: '工場B', before_memo: null, after_memo: '新しいメモ', reason: '社名変更', actor_id: s.actor }]);

    const after = await snapshot();
    expect(after).toMatchObject({ revisions: before.revisions + 1, operations: before.operations + 1, line_state: before.line_state });
    expect(untouched(after)).toEqual(untouched(before));
    expect((await db().query("select cause_type, cause_id, result from private.group_g_operations where operation = 'purchase_order_header_update' and cause_id = $1", [s.order.id])).rows)
      .toEqual([{ cause_type: 'purchase_order', cause_id: s.order.id, result: { version: 2, replayed: false } }]);
  });

  test('FREQ-527-AC-01: 発注先・メモの訂正は どちらか片方だけでも通り（メモを空にすると NULL）、両方が変わらなければ 22023。発注先が空・長すぎる・メモが長すぎるも 22023', async () => {
    const s = await setup([5]);
    const first = await header({ actor: s.actor, orderId: s.order.id, version: 1, supplier: '工場A', memo: 'メモ', reason: 'メモを足す' });
    expect(await orderRow(s.order.id)).toMatchObject({ supplier_name: '工場A', memo: 'メモ' });
    const second = await header({ actor: s.actor, orderId: s.order.id, version: first.version, supplier: '工場A', memo: '   ', reason: 'メモを消す' });
    expect(await orderRow(s.order.id)).toMatchObject({ supplier_name: '工場A', memo: null });
    expect((await revisionsOf(s.order.id, 'header')).at(-1)).toMatchObject({ before_memo: 'メモ', after_memo: null, before_supplier_name: '工場A', after_supplier_name: '工場A' });

    const before = await snapshot();
    const unchanged = { actor: s.actor, orderId: s.order.id, version: second.version, reason: '同じ' };
    expect(await rejected(() => header({ ...unchanged, supplier: ' 工場A ', memo: null }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, supplier: '', memo: null }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, supplier: null, memo: null }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, supplier: 'あ'.repeat(101), memo: null }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, supplier: '工場B', memo: 'い'.repeat(501) }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, supplier: '工場B', memo: null, reason: 'あ'.repeat(201) }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, orderId: null, supplier: '工場B' }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, version: 0, supplier: '工場B' }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, actor: null, supplier: '工場B' }))).toEqual(INVALID);
    expect(await rejected(() => header({ ...unchanged, key: null, supplier: '工場B' }))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);

    // 上限ちょうど（発注先100字・メモ500字・理由200字）は通る
    const edge = await header({ actor: s.actor, orderId: s.order.id, version: second.version, supplier: 'あ'.repeat(100), memo: 'い'.repeat(500), reason: 'う'.repeat(200) });
    expect(edge.version).toBe(second.version + 1);
  });

  test('FREQ-527-AC-01: 発注先・メモの訂正は どの段階の発注書にもできる（数量確定後・打切り後・完了後も）。存在しない発注書は P0002', async () => {
    const s = await setup([5]);
    const v2 = await confirmFirst(s, [5]);
    const closed = await shortClose({ actor: s.actor, orderId: s.order.id, version: v2, lineIds: [s.lines[0].id], reason: '全部打ち切る' });
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
    const result = await header({ actor: s.actor, orderId: s.order.id, version: closed.version, supplier: '工場B', reason: '完了後の訂正' });
    expect(result.version).toBe(closed.version + 1);
    expect(await stageOf(s.actor, s.order.id)).toBe('closed');
    expect(await rejected(() => header({ actor: s.actor, orderId: randomUUID(), version: 1, supplier: '工場B', reason: 'x' }))).toEqual(NOT_FOUND);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: randomUUID(), version: 1, lineIds: [s.lines[0].id], reason: 'x' }))).toEqual(NOT_FOUND);
  });

  // ---- 権限 ----

  test('FREQ-540-AC-07: 3つの書込みは manage と read の両方が要る。items.*・在庫・受け取りの権限だけ、manage だけ、read だけ、無効・期限切れ・役割なし・存在しない実行者は 42501', async () => {
    const s = await setup([5, 3]);
    const ids = s.lines.map((line) => line.id);
    const before = await snapshot();
    // 同じ接続の savepoint を使うので、順に実行する
    const attempts = async (actor: string) => [
      await rejected(() => header({ actor, orderId: s.order.id, version: 1, supplier: '工場B', reason: '改称' })),
      await rejected(() => confirm({ actor, orderId: s.order.id, version: 1, lines: payload(s.lines, [4, 3]) })),
      await rejected(() => shortClose({ actor, orderId: s.order.id, version: 1, lineIds: ids, reason: '取消' })),
    ];
    const allForbidden = async (actor: string) => expect(await attempts(actor)).toEqual([FORBIDDEN, FORBIDDEN, FORBIDDEN]);

    await allForbidden(await createActor(['admin'], { inactive: ['admin'] }));
    await allForbidden(await createActor(['admin'], { expired: ['admin'] }));
    await allForbidden(await createActor([]));
    await allForbidden(randomUUID());

    await grant('supporter', ['admin.items.read', 'admin.items.manage']);
    await allForbidden(await createActor(['supporter']));
    await revoke('supporter', ['admin.items.read', 'admin.items.manage']);
    await grant('supporter', ['admin.stock.read', 'admin.stock.manage', 'admin.receiving.manage']);
    await allForbidden(await createActor(['supporter']));
    await revoke('supporter', ['admin.stock.read', 'admin.stock.manage', 'admin.receiving.manage']);
    await grant('supporter', ['admin.purchase_orders.manage']);
    await allForbidden(await createActor(['supporter']));
    await revoke('supporter', ['admin.purchase_orders.manage']);
    await grant('supporter', ['admin.purchase_orders.read']);
    await allForbidden(await createActor(['supporter']));
    expect(await snapshot()).toEqual(before);

    // manage が supporter、read が user にある実行者は、有効な役割の和集合で足りる
    await revoke('supporter', ['admin.purchase_orders.read']);
    await grant('supporter', ['admin.purchase_orders.manage']);
    await grant('user', ['admin.purchase_orders.read']);
    await allForbidden(await createActor(['supporter']));
    const union = await createActor(['supporter', 'user']);
    expect((await header({ actor: union, orderId: s.order.id, version: 1, supplier: '工場B', reason: '改称' })).version).toBe(2);
    expect((await confirm({ actor: union, orderId: s.order.id, version: 2, lines: payload(s.lines, [4, 3]) })).version).toBe(3);
    expect((await shortClose({ actor: union, orderId: s.order.id, version: 3, lineIds: ids, reason: '取消' })).version).toBe(4);
  });

  test('FREQ-540-AC-07: 実行者の現在の権限を毎回確かめる。manage を外すとその場から断られる', async () => {
    const s = await setup([5]);
    expect((await confirmFirst(s, [5], [100]))).toBe(2);
    await revoke('admin', ['admin.purchase_orders.manage']);
    expect(await rejected(() => header({ actor: s.actor, orderId: s.order.id, version: 2, supplier: '工場B', reason: '改称' }))).toEqual(FORBIDDEN);
    expect(await rejected(() => confirm({ actor: s.actor, orderId: s.order.id, version: 2, reason: '訂正', lines: payload(s.lines, [4], [100]) }))).toEqual(FORBIDDEN);
    expect(await rejected(() => shortClose({ actor: s.actor, orderId: s.order.id, version: 2, lineIds: [s.lines[0].id], reason: '取消' }))).toEqual(FORBIDDEN);
  });

  // ---- 途中失敗 ----

  test('FREQ-527-AC-01: 途中失敗（履歴・打切り・操作の記録の INSERT に故障を注入）では、先に書いた行・版・履歴が全部残らず、同じ要求番号は後で作り直せる', async () => {
    const s = await setup([5, 3]);
    const v2 = await confirmFirst(s, [5, 3], [100, 200]);
    await receiveMaterial(s, 0, 1);
    const ids = s.lines.map((line) => line.id);
    // 表ごとに別の関数にする（plpgsql は NEW の項目を、条件が偽でも解決するため、別の表の項目は書けない）
    await db().query(`create function public.g2_inject_revision_failure() returns trigger language plpgsql as $$
      begin
        if new.line_id = '${ids[1]}'::uuid then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
            detail = (select count(*)::text from public.purchase_order_revisions where operation_id = new.operation_id);
        elsif new.kind = 'header' then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
            detail = (select version::text from public.purchase_orders where id = new.purchase_order_id);
        end if;
        return new;
      end $$`);
    await db().query(`create function public.g2_inject_closure_failure() returns trigger language plpgsql as $$
      begin
        if new.line_id = '${ids[1]}'::uuid then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
            detail = (select count(*)::text from public.purchase_order_short_closures where line_id = '${ids[0]}'::uuid);
        end if;
        return new;
      end $$`);
    await db().query(`create function public.g2_inject_operation_failure() returns trigger language plpgsql as $$
      begin
        if new.operation in ('purchase_order_quantities', 'purchase_order_short_close', 'purchase_order_header_update') then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001', detail = new.operation;
        end if;
        return new;
      end $$`);
    const before = await snapshot();
    const keys = { confirm: randomUUID(), close: randomUUID(), header: randomUUID() };
    const calls = {
      confirm: () => confirm({ actor: s.actor, orderId: s.order.id, version: v2, key: keys.confirm, reason: '訂正', lines: payload(s.lines, [4, 2], [150, 250]) }),
      close: () => shortClose({ actor: s.actor, orderId: s.order.id, version: v2, key: keys.close, lineIds: ids, reason: '打切り' }),
      header: () => header({ actor: s.actor, orderId: s.order.id, version: v2, key: keys.header, supplier: '工場B', reason: '改称' }),
    };
    const failed = async (run: () => Promise<unknown>) => {
      await db().query('savepoint injected');
      let caught: { code?: string; message?: string; detail?: string } = {};
      try { await run(); } catch (e) { caught = e as typeof caught; }
      await db().query('rollback to savepoint injected');
      await db().query('release savepoint injected');
      return caught;
    };

    // 1) 2行目の履歴で失敗: 1行目の履歴（1件目）と行の更新は書かれた後
    await db().query("create trigger g2_inject_revision before insert on public.purchase_order_revisions for each row execute function public.g2_inject_revision_failure()");
    expect(await failed(calls.confirm)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '1' });
    expect(await snapshot()).toEqual(before);
    // 発注先の訂正: 発注書の更新は書かれた後（版は 3 になっていた）
    expect(await failed(calls.header)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: String(v2 + 1) });
    expect(await snapshot()).toEqual(before);
    // 打切り: 履歴は 2行目で失敗
    expect(await failed(calls.close)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '1' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_revision on public.purchase_order_revisions');

    // 2) 打切りの行（2行目）で失敗: 1行目の打切りは書かれた後
    await db().query("create trigger g2_inject_closure before insert on public.purchase_order_short_closures for each row execute function public.g2_inject_closure_failure()");
    expect(await failed(calls.close)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '1' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_closure on public.purchase_order_short_closures');

    // 3) 最後の操作の記録で失敗: 3つとも、先に書いた物が全部残らない
    await db().query("create trigger g2_inject_operation before insert on private.group_g_operations for each row execute function public.g2_inject_operation_failure()");
    expect(await failed(calls.confirm)).toMatchObject({ code: 'P0001', detail: 'purchase_order_quantities' });
    expect(await failed(calls.close)).toMatchObject({ code: 'P0001', detail: 'purchase_order_short_close' });
    expect(await failed(calls.header)).toMatchObject({ code: 'P0001', detail: 'purchase_order_header_update' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_operation on private.group_g_operations');

    // 同じ要求番号で後から作り直せる（失敗が受付を残していない）
    expect((await calls.confirm()).replayed).toBe(false);
  });

  // ---- 動かさない物 ----

  test('FREQ-528-AC-01: 確定・訂正・打切り・発注先の訂正は、在庫・割当・台帳・状態の履歴・注文・受取の行数と状態を1つも動かさない', async () => {
    const actor = await manager();
    const c = await createCatalogFixture(db(), { stock: 4 });
    const order = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 6, fulfillmentType: 'backorder', reserved: false }] });
    await seedGroupG1Allocation(db(), { orderItemId: order.orderItemIds[0], quantity: 2, kind: 'paid' });
    const po = await create(actor, [lineOf(c.variantId, 10)]);
    const lines = await linesOf(po.id);
    const s: Setup = { actor, order: po, lines, fixtures: [{ ...c }] };
    // 受け取り（試験内の材料）は数量の確定の後でないとできない（確定前の行は納品済みを持てない）
    const v2 = await confirmFirst(s, [8], [100]);
    await receiveMaterial(s, 0, 3);
    const before = await snapshot();
    expect(before.allocations).toBeGreaterThan(0);
    expect(before.receipts).toBeGreaterThan(0);
    const stockBefore = Number((await db().query('select stock_quantity from public.item_variants where id = $1', [c.variantId])).rows[0].stock_quantity);

    const v3 = (await confirm({ actor, orderId: po.id, version: v2, reason: '増やす', lines: payload(lines, [10], [120]) })).version;
    const v4 = (await header({ actor, orderId: po.id, version: v3, supplier: '工場B', reason: '改称' })).version;
    await shortClose({ actor, orderId: po.id, version: v4, lineIds: [lines[0].id], reason: '打切り' });

    const after = await snapshot();
    expect(untouched(after)).toEqual(untouched(before));
    expect(Number((await db().query('select stock_quantity from public.item_variants where id = $1', [c.variantId])).rows[0].stock_quantity)).toBe(stockBefore);
    // 増えたのは操作の受付3件（訂正・発注先の訂正・打切り）と、発注書の履歴・打切りだけ
    expect(after).toMatchObject({ operations: before.operations + 3, short_closures: before.short_closures + 1 });
  });

  // ---- 関数の形と ACL ----

  test('FREQ-540-AC-07: 3本の private 本体は DEFINER・postgres・search_path 空で service_role だけが EXECUTE でき、public 入口は SQL の INVOKER 委譲（service_role のみ）', async () => {
    const read = async (signature: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
        l.lanname as language, p.proconfig as config, p.provolatile as volatility, p.proretset as set_returning,
        pg_get_function_result(p.oid) as result, p.proargnames as names,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [signature])).rows[0];
    const common = { owner: 'postgres', config: ['search_path=""'], volatility: 'v', set_returning: false, result: 'jsonb', service_role: true, anon: false, authenticated: false, public_can_execute: false };
    const names: Record<string, string[]> = {
      [HEADER_SIGNATURE]: ['_purchase_order_id', '_expected_version', '_supplier_name', '_memo', '_reason', '_actor_id', '_request_key'],
      [CONFIRM_SIGNATURE]: ['_purchase_order_id', '_expected_version', '_lines', '_reason', '_actor_id', '_request_key'],
      [CLOSE_SIGNATURE]: ['_purchase_order_id', '_expected_version', '_line_ids', '_reason', '_actor_id', '_request_key'],
    };
    for (const signature of SIGNATURES) {
      expect(await read(`private.${signature}`)).toEqual({ ...common, definer: true, language: 'plpgsql', names: names[signature] });
      expect(await read(`public.${signature}`)).toEqual({ ...common, definer: false, language: 'sql', names: names[signature] });
    }
  });

  test('FREQ-540-AC-07: 書き手の一覧は 65 本(Task 7 の受け取りの 2 本・Task 8 の原本の 3 本を含む)で、3本の private 本体を含み、public 入口は含まない', async () => {
    const list = (await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows;
    expect(list).toHaveLength(65);
    const oids = new Set(list.map((row) => row.oid));
    for (const signature of SIGNATURES) {
      const privateOid = (await db().query('select $1::regprocedure::oid::text as oid', [`private.${signature}`])).rows[0].oid;
      const publicOid = (await db().query('select $1::regprocedure::oid::text as oid', [`public.${signature}`])).rows[0].oid;
      expect(oids.has(privateOid)).toBe(true);
      expect(oids.has(publicOid)).toBe(false);
    }
  });

  test('FREQ-540-AC-07: anon / authenticated は public 入口も private 本体も呼べず（42501）、service_role は public 入口から3つとも実行できる', async () => {
    const s = await setup([5, 3]);
    const ids = s.lines.map((line) => line.id);
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
    const calls = (schema: Schema, version: number): Array<[string, unknown[]]> => [
      [`select ${schema}.admin_update_purchase_order_header($1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::uuid, $7::uuid) as r`,
        [s.order.id, version, '工場B', null, '改称', s.actor, randomUUID()]],
      [`select ${schema}.admin_confirm_purchase_order_quantities($1::uuid, $2::integer, $3::jsonb, $4::text, $5::uuid, $6::uuid) as r`,
        [s.order.id, version, JSON.stringify(payload(s.lines, [4, 3])), null, s.actor, randomUUID()]],
      [`select ${schema}.admin_short_close_purchase_order($1::uuid, $2::integer, $3::uuid[], $4::text, $5::uuid, $6::uuid) as r`,
        [s.order.id, version, ids, '取消', s.actor, randomUUID()]],
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const schema of ['public', 'private'] as const) {
        for (const [sql, params] of calls(schema, 1)) expect(await attempt(role, sql, params)).toEqual({ code: '42501' });
      }
    }
    // service_role は public 入口から3つとも実行できる（attempt は毎回 savepoint まで戻すので、どれも版 1 の発注書に対して実行される）
    const [headerCall, confirmCall, closeCall] = calls('public', 1);
    const results = [await attempt('service_role', ...headerCall), await attempt('service_role', ...confirmCall), await attempt('service_role', ...closeCall)];
    const rows = results.map((result) => (result.rows ? result.rows[0].r : result));
    expect(rows).toEqual([
      { version: 2, replayed: false },
      { version: 2, changedLines: 1, replayed: false },
      { version: 2, closedQuantity: 8, replayed: false },
    ]);
  });
});
