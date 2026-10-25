/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture } from './helpers/order-fixtures';
import { G2_ALLOWLIST, G3C_ALLOWLIST, runWithAllowlist } from './helpers/group-g-allowlist';

/**
 * G-2 Task 8（FREQ-530・FREQ-540-AC-07）: 見積書・請求書の原本の予約・確定・訂正・無効化・検索。
 * private.admin_reserve_purchase_order_attachment / admin_attach_purchase_order_document / admin_revise_purchase_order_document（writers）と
 * private.search_purchase_order_documents（foundation）、それぞれの公開入口（service_role のみ）。
 * 処理順は「引数検証 → ロック → 権限 → 指紋と再送 → 存在 → 業務規則 → 書込み → 操作の記録（最後）」。置き場（Storage）はこの試験では使わない
 * （検査済みの種類・大きさ・ハッシュは呼び手が渡す。置き場との結び付きは単体試験と E2E が見る）。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const readMigration = (suffix: string): string => {
  const files = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith(suffix));
  return files.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, files[0]), 'utf8') : '';
};
const FOUNDATION_SQL = readMigration('_group_g2_purchasing_foundation.sql');
const WRITERS_SQL = readMigration('_group_g2_purchasing_writers.sql');

const RESERVE_SIGNATURE = 'admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)';
const ATTACH_SIGNATURE = 'admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)';
const REVISE_SIGNATURE = 'admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)';
const SEARCH_SIGNATURE = 'search_purchase_order_documents(date,date,bigint,bigint,text,text,text,boolean,integer,integer,uuid)';
const WRITER_SIGNATURES = [RESERVE_SIGNATURE, ATTACH_SIGNATURE, REVISE_SIGNATURE] as const;

const FORBIDDEN = { code: '42501', message: 'GROUP_G_FORBIDDEN' };
const INVALID = { code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' };
const CONFLICT = { code: '23505', message: 'GROUP_G_REQUEST_KEY_CONFLICT' };
const NOT_FOUND = { code: 'P0002', message: 'GROUP_G_PO_NOT_FOUND' };
const REASON_REQUIRED = { code: '22023', message: 'GROUP_G_PO_REASON_REQUIRED' };
const RESERVATION_INVALID = { code: '55000', message: 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID' };
const ALREADY_ATTACHED = { code: '55000', message: 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED' };
const REPLACEMENT_INVALID = { code: '22023', message: 'GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID' };
const IMMUTABLE = { code: '55000', message: 'GROUP_G_HISTORY_IMMUTABLE' };

const SHA = createHash('sha256').update('sample document').digest('hex');
const SHA_OTHER = createHash('sha256').update('other document').digest('hex');

/** コメントの行を外した本文（コメント内の語を拾わないため） */
const withoutComments = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const FOUNDATION = withoutComments(FOUNDATION_SQL);
const WRITERS = withoutComments(WRITERS_SQL);

/** CREATE FUNCTION <name>( から、その ALTER FUNCTION までの本文 */
function functionText(code: string, createPrefix: string, alterPrefix: string): string {
  const start = code.indexOf(createPrefix);
  const end = code.indexOf(alterPrefix, start);
  return start >= 0 && end > start ? code.slice(start, end) : '';
}
const RESERVE_TEXT = functionText(WRITERS, 'CREATE FUNCTION private.admin_reserve_purchase_order_attachment(', 'ALTER FUNCTION private.admin_reserve_purchase_order_attachment(');
const ATTACH_TEXT = functionText(WRITERS, 'CREATE FUNCTION private.admin_attach_purchase_order_document(', 'ALTER FUNCTION private.admin_attach_purchase_order_document(');
const REVISE_TEXT = functionText(WRITERS, 'CREATE FUNCTION private.admin_revise_purchase_order_document(', 'ALTER FUNCTION private.admin_revise_purchase_order_document(');
const SEARCH_TEXT = functionText(FOUNDATION, 'CREATE FUNCTION private.search_purchase_order_documents(', 'ALTER FUNCTION private.search_purchase_order_documents(');

/**
 * DO $tag$ … $tag; の全体。
 * G-3 以降へ: 書き手の閉じた一覧が 65 本を超える・この移行の関数を置き換える時は、この確かめを今の DB で流す試験
 * （group_g2_migration_asserts と、finalAssertBlock を使う G-2 の DB 試験）を、その変更と同じコミットで直す。
 */
function finalAssertBlock(sql: string, tag: string): string {
  const start = sql.indexOf(`DO ${tag}`);
  const end = sql.indexOf(`${tag};`, start + 1);
  return start >= 0 && end > start ? sql.slice(start, end + tag.length + 1) : '';
}

describe('G-2 migration の原本の節（DB なし）', () => {
  const PERMISSION = "private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read'])";

  test.each([
    ['予約', RESERVE_TEXT, 'purchase_order_attachment_reserve'],
    ['確定', ATTACH_TEXT, 'purchase_order_attachment_attach'],
    ['訂正・無効化', REVISE_TEXT, 'purchase_order_attachment_revise'],
  ])('FREQ-530-AC-02: 原本の%sの処理順は 引数検証 → ロック helper → 権限 → 指紋と再送 → 存在 → 書込み → 操作の記録（最後）。表に触れるのはロックの呼び出しから', (_name, text, operation) => {
    expect(text).not.toBe('');
    expect(text).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
    const positions = [
      text.indexOf("RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'"),
      text.indexOf('PERFORM private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], false);'),
      text.indexOf(PERMISSION),
      text.indexOf(`op.operation = '${operation}' AND op.request_key = _request_key`),
      text.indexOf("RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002'"),
      text.search(/\bINSERT INTO public\./),
      text.indexOf('INSERT INTO private.group_g_operations('),
    ];
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text.lastIndexOf('INSERT INTO private.group_g_operations(')).toBeGreaterThan(text.lastIndexOf('INSERT INTO public.'));
    const body = text.slice(text.indexOf('\nBEGIN\n'));
    expect(body.search(/\b(?:public|private)\./)).toBe(body.indexOf('private.lock_group_g_purchase_orders('));
    const fingerprint = text.slice(text.indexOf('v_fingerprint := '), text.indexOf("'hex');"));
    expect(fingerprint).toContain(`'operation', '${operation}'`);
    expect(fingerprint).toContain("'actor_id', _actor_id");
  });

  test('FREQ-530-AC-01: 3本は 置き場・在庫・台帳・受取・割当・注文・発注書の表を読みも書きもしない。更新・削除は一切無く、書く表は決まった物だけ（追記だけ）', () => {
    for (const text of [RESERVE_TEXT, ATTACH_TEXT, REVISE_TEXT]) {
      expect(text).not.toMatch(/\bstorage\./);
      expect(text).not.toMatch(/\b(stock_movements|stock_quantity|order_item_allocations|order_item_allocation_events|order_item_state_events|order_items|order_fulfillments|purchase_order_receipts|purchase_order_receipt_lines|purchase_order_lines|purchase_order_revisions)\b/);
      expect(text).not.toMatch(/\bpublic\.orders\b/);
      expect(text).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|MERGE)\b/);
    }
    const writes = (text: string) => [...text.matchAll(/\bINSERT INTO ([a-z_.]+)/g)].map((match) => match[1]);
    expect(writes(RESERVE_TEXT)).toEqual(['public.purchase_order_attachment_reservations', 'private.group_g_operations']);
    expect(writes(ATTACH_TEXT)).toEqual(['public.purchase_order_attachments', 'public.purchase_order_attachment_revisions', 'private.group_g_operations']);
    expect(writes(REVISE_TEXT)).toEqual(['public.purchase_order_attachment_revisions', 'private.group_g_operations']);
  });

  test('FREQ-530-AC-02: 予約は 24時間後の期限と 保存キー <発注書id>/<乱数のuuid>.<拡張子>（pdf・jpg・jpeg・png）を作る。確定は期限を見ない', () => {
    expect(RESERVE_TEXT).toContain("v_expires := pg_catalog.now() + INTERVAL '24 hours';");
    expect(RESERVE_TEXT).toContain("v_path := _purchase_order_id::text || '/' || pg_catalog.gen_random_uuid()::text || '.' || v_extension;");
    expect(RESERVE_TEXT).toContain("v_extension NOT IN ('pdf', 'jpg', 'jpeg', 'png')");
    expect(ATTACH_TEXT).not.toMatch(/expires_at/);
    expect(ATTACH_TEXT).toContain("'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID' USING ERRCODE = '55000'");
    expect(ATTACH_TEXT).toContain("'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED' USING ERRCODE = '55000'");
    // 差し替え元は予約が持つ: 予約が確かめて残し（22023）、確定は引数で受けず、予約から版1へ写す
    expect(RESERVE_TEXT).toContain("'GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID' USING ERRCODE = '22023'");
    expect(ATTACH_TEXT).not.toContain('REPLACEMENT_INVALID');
    expect(ATTACH_TEXT).not.toMatch(/_replaces_attachment_id/);
    expect(ATTACH_TEXT).toContain('v_reservation.replaces_attachment_id');
  });

  test('FREQ-540-AC-07: 3本の private 本体と public 入口は service_role だけに EXECUTE を渡し、PUBLIC / anon / authenticated を個別に外す。public 入口は SQL の INVOKER 委譲', () => {
    for (const signature of [...WRITER_SIGNATURES]) {
      for (const schema of ['private', 'public']) {
        expect(WRITERS).toContain(`ALTER FUNCTION ${schema}.${signature} OWNER TO postgres;`);
        expect(WRITERS).toContain(`REVOKE ALL ON FUNCTION ${schema}.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
        expect(WRITERS).toContain(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO service_role;`);
      }
    }
    for (const schema of ['private', 'public']) {
      const signature = SEARCH_SIGNATURE.replaceAll(',', ', ');
      expect(FOUNDATION).toContain(`ALTER FUNCTION ${schema}.${signature} OWNER TO postgres;`);
      expect(FOUNDATION).toContain(`REVOKE ALL ON FUNCTION ${schema}.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(FOUNDATION).toContain(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO service_role;`);
    }
    const delegates: Array<[string, string]> = [
      ['admin_reserve_purchase_order_attachment', '(_purchase_order_id, _kind, _file_name, _replaces_attachment_id, _actor_id, _request_key)'],
      ['admin_attach_purchase_order_document', '(_reservation_id, _purchase_order_id, _mime_type, _size_bytes, _sha256, _sha256_source, _transaction_date, _amount_yen, _currency, _counterparty, _actor_id, _request_key)'],
      ['admin_revise_purchase_order_document', '(_attachment_id, _purchase_order_id, _transaction_date, _amount_yen, _currency, _counterparty, _voided, _reason, _actor_id, _request_key)'],
    ];
    for (const [name, args] of delegates) {
      const delegate = functionText(WRITERS, `CREATE FUNCTION public.${name}(`, `ALTER FUNCTION public.${name}(`);
      expect(delegate).toContain("LANGUAGE sql SECURITY INVOKER SET search_path = ''");
      expect(delegate).toContain(`SELECT private.${name}${args};`);
    }
    expect(WRITERS).not.toMatch(/ON SCHEMA\s+private/i);
    expect(FOUNDATION).not.toMatch(/ON SCHEMA\s+private/i);
  });

  test('FREQ-540-AC-07: 検索関数は STABLE・最初に admin.purchase_orders.read を _actor_id で確かめ（42501）、その後に引数（22023）。何も書かず、storage_path を返さない', () => {
    expect(SEARCH_TEXT).not.toBe('');
    expect(SEARCH_TEXT).toContain('LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path');
    const body = SEARCH_TEXT.slice(SEARCH_TEXT.indexOf('\nBEGIN\n'));
    expect(body.indexOf("private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.read'])")).toBeGreaterThan(0);
    expect(body.indexOf("'GROUP_G_FORBIDDEN' USING ERRCODE = '42501'")).toBeLessThan(body.indexOf("'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023'"));
    expect(body.search(/\b(?:public|private)\./)).toBe(body.indexOf('private.group_g_actor_has_permissions('));
    expect(SEARCH_TEXT).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b\s+(?:INTO\s+)?(?:public|private)\./);
    expect(SEARCH_TEXT).not.toContain('storage_path');
    expect(SEARCH_TEXT).toContain('pg_catalog.strpos(pg_catalog.lower(r.counterparty), pg_catalog.lower(_counterparty))');
    expect(SEARCH_TEXT).toContain('pg_catalog.starts_with(pg_catalog.lower(po.number), pg_catalog.lower(_purchase_order_number))');
    expect(SEARCH_TEXT).toContain('ORDER BY m.tdate DESC, m.rcreated DESC, m.rid');
    expect(SEARCH_TEXT).not.toMatch(/\bLIKE\b|\bILIKE\b/);
  });

  test('FREQ-540-AC-07: 書き手の一覧は 65 本で、原本の3本を末尾に足した。最後の確かめ（writers は 65 本と6つの関数、foundation は検索の2つの関数）も合わせた', () => {
    const section = WRITERS_SQL.slice(WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_BEGIN'), WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_END'));
    expect(section).toContain('<> 65');
    for (const signature of WRITER_SIGNATURES) {
      expect(section).toContain(`'private.${signature}'`);
      expect(section).toContain(`'public.${signature}'`);
    }
    expect(section).toContain("('public.purchase_order_attachment_revisions')");
    const reads = FOUNDATION_SQL.slice(FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_BEGIN'), FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_END'));
    expect(reads).toContain("'private.search_purchase_order_documents(date,date,bigint,bigint,text,text,text,boolean,integer,integer,uuid)'");
    expect(reads).toContain("'public.search_purchase_order_documents(date,date,bigint,bigint,text,text,text,boolean,integer,integer,uuid)'");
  });

  test('FREQ-530-AC-01: 移行は UTF-8・BOMなし・LF・ASCII のみ', () => {
    for (const sql of [FOUNDATION_SQL, WRITERS_SQL]) {
      expect(sql).not.toBe('');
      expect(sql.charCodeAt(0)).not.toBe(0xfeff);
      expect(sql).not.toContain('\r');
      expect([...sql].filter((char) => char.charCodeAt(0) > 127)).toEqual([]);
    }
  });
});

type Row = Record<string, unknown>;

describeLocalDb('integration: G-2 原本の予約・確定・訂正・検索', (db) => {
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

  /** 店長（admin）は初期のまま admin.purchase_orders.manage / read を持つ */
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

  /** 遅延の確かめ（操作の受付への外部キー）を取引の中で発火させる */
  async function flush() {
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency, order_item_allocations_operation_id_fkey, order_item_allocation_events_operation_id_fkey, order_item_state_events_operation_id_fkey, stock_movements_allocation_operation_id_fkey, group_g_po_line_received, purchase_order_revisions_operation_id_fkey, purchase_order_receipts_operation_id_fkey, purchase_order_attachment_reservations_operation_id_fkey, purchase_order_attachments_operation_id_fkey, purchase_order_attachment_revisions_operation_id_fkey immediate');
    await db().query('set constraints all deferred');
  }

  // ---- 呼び出し ----

  type Schema = 'public' | 'private';
  const pick = <T,>(args: Record<string, unknown>, name: string, fallback: T): T => (name in args ? (args[name] as T) : fallback);

  type ReserveResult = { reservationId: string; storagePath: string; expiresAt: string; replayed: boolean };
  async function reserve(orderId: string | null, actor: string | null, args: Record<string, unknown> = {}): Promise<ReserveResult> {
    const result = await db().query(
      `select ${pick<Schema>(args, 'schema', 'public')}.admin_reserve_purchase_order_attachment($1::uuid, $2::text, $3::text, $4::uuid, $5::uuid, $6::uuid) as r`,
      [orderId, pick(args, 'kind', 'invoice'), pick(args, 'fileName', 'invoice.pdf'), pick(args, 'replaces', null), actor, pick(args, 'key', randomUUID())]);
    await flush();
    return result.rows[0].r as ReserveResult;
  }

  type AttachResult = { attachmentId: string; revisionNo: number; replayed: boolean };
  async function attach(reservationId: string | null, orderId: string | null, actor: string | null, args: Record<string, unknown> = {}): Promise<AttachResult> {
    const result = await db().query(
      `select ${pick<Schema>(args, 'schema', 'public')}.admin_attach_purchase_order_document($1::uuid, $2::uuid, $3::text, $4::bigint, $5::text, $6::text, $7::date, $8::bigint, $9::text, $10::text, $11::uuid, $12::uuid) as r`,
      [reservationId, orderId, pick(args, 'mime', 'application/pdf'), pick(args, 'size', 2048), pick(args, 'sha', SHA), pick(args, 'source', 'browser'),
        pick(args, 'date', '2026-10-26'), pick(args, 'amount', 6000), pick(args, 'currency', 'JPY'), pick(args, 'counterparty', '工場A'),
        actor, pick(args, 'key', randomUUID())]);
    await flush();
    return result.rows[0].r as AttachResult;
  }

  async function revise(attachmentId: string | null, orderId: string | null, actor: string | null, args: Record<string, unknown> = {}): Promise<AttachResult> {
    const result = await db().query(
      `select ${pick<Schema>(args, 'schema', 'public')}.admin_revise_purchase_order_document($1::uuid, $2::uuid, $3::date, $4::bigint, $5::text, $6::text, $7::boolean, $8::text, $9::uuid, $10::uuid) as r`,
      [attachmentId, orderId, pick(args, 'date', '2026-10-27'), pick(args, 'amount', 7000), pick(args, 'currency', 'JPY'), pick(args, 'counterparty', '工場B'),
        pick(args, 'voided', false), pick(args, 'reason', '宛先の誤り'), actor, pick(args, 'key', randomUUID())]);
    await flush();
    return result.rows[0].r as AttachResult;
  }

  async function search(actor: string | null, args: Record<string, unknown> = {}): Promise<Row[]> {
    const result = await db().query(
      `select * from ${pick<Schema>(args, 'schema', 'public')}.search_purchase_order_documents($1::date, $2::date, $3::bigint, $4::bigint, $5::text, $6::text, $7::text, $8::boolean, $9::integer, $10::integer, $11::uuid)`,
      [pick(args, 'from', null), pick(args, 'to', null), pick(args, 'min', null), pick(args, 'max', null), pick(args, 'counterparty', null), pick(args, 'number', null),
        pick(args, 'kind', null), pick(args, 'history', false), pick(args, 'limit', 100), pick(args, 'offset', 0), actor]);
    return result.rows;
  }

  async function detailOf(actor: string, orderId: string): Promise<Row> {
    return (await db().query('select public.get_admin_purchase_order($1::uuid, $2::uuid) as r', [orderId, actor])).rows[0].r as Row;
  }

  // ---- 材料 ----

  async function createOrder(actor: string): Promise<{ id: string; number: string }> {
    const fixture = await createCatalogFixture(db(), { stock: 0 });
    const result = await db().query('select public.admin_create_purchase_order($1, $2, $3::jsonb, $4, $5) as r',
      ['工場A', null, JSON.stringify([{ variantId: fixture.variantId, quantity: 5 }]), actor, randomUUID()]);
    await flush();
    return result.rows[0].r as { id: string; number: string };
  }

  async function setup() {
    const actor = await manager();
    const order = await createOrder(actor);
    const other = await createOrder(actor);
    return { actor, order, other };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** 予約して確定する（既定は請求書・2026-10-26・6000円・工場A） */
  async function addDocument(s: Setup, args: Record<string, unknown> = {}, orderId = s.order.id) {
    const reserved = await reserve(orderId, s.actor, { kind: pick(args, 'kind', 'invoice'), fileName: pick(args, 'fileName', 'invoice.pdf'), replaces: pick(args, 'replaces', null) });
    const attached = await attach(reserved.reservationId, orderId, s.actor, args);
    return { reserved, attached };
  }

  const snapshot = async () => (await db().query(`select
    (select count(*) from public.purchase_order_attachment_reservations)::int as reservations,
    (select count(*) from public.purchase_order_attachments)::int as attachments,
    (select count(*) from public.purchase_order_attachment_revisions)::int as revisions,
    (select count(*) from private.group_g_operations)::int as operations,
    (select md5(coalesce(string_agg(r::text, ',' order by r.id), '')) from public.purchase_order_attachment_reservations r) as reservation_state,
    (select md5(coalesce(string_agg(a::text, ',' order by a.id), '')) from public.purchase_order_attachments a) as attachment_state,
    (select md5(coalesce(string_agg(v::text, ',' order by v.id), '')) from public.purchase_order_attachment_revisions v) as revision_state,
    (select md5(coalesce(string_agg(id::text || ':' || stage || ':' || version::text, ',' order by id), '')) from public.purchase_orders) as order_state,
    (select count(*) from public.purchase_order_revisions)::int as order_revisions,
    (select count(*) from public.stock_movements)::int as movements,
    (select md5(coalesce(string_agg(id::text || ':' || stock_quantity::text, ',' order by id), '')) from public.item_variants) as stock_by_variant,
    (select count(*) from public.order_item_allocations)::int as allocations`)).rows[0];

  // ---- FREQ-530-AC-02: 予約 ----

  test('FREQ-530-AC-02: 予約は 24時間の期限と 保存キー <発注書id>/<乱数のuuid>.<拡張子> を作り、操作の記録を残す。予約だけでは添付は増えない', async () => {
    const s = await setup();
    const before = await snapshot();
    const key = randomUUID();
    const reserved = await reserve(s.order.id, s.actor, { key, fileName: '  請求書 10月.PDF  ' });
    expect(reserved.replayed).toBe(false);
    expect(reserved.storagePath).toMatch(new RegExp(`^${s.order.id}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`));

    const row = (await db().query(`select kind, original_file_name, storage_path, created_by, purchase_order_id,
        extract(epoch from (expires_at - created_at))::int as seconds
      from public.purchase_order_attachment_reservations where id = $1`, [reserved.reservationId])).rows[0];
    expect(row).toMatchObject({ kind: 'invoice', original_file_name: '請求書 10月.PDF', storage_path: reserved.storagePath, created_by: s.actor, purchase_order_id: s.order.id, seconds: 86400 });
    expect(new Date(reserved.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000);

    const operations = (await db().query(`select operation, cause_type, cause_id, actor_id, result from private.group_g_operations
      where operation = 'purchase_order_attachment_reserve' and request_key = $1`, [key])).rows;
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ cause_type: 'purchase_order', cause_id: s.order.id, actor_id: s.actor });

    const after = await snapshot();
    expect(after).toMatchObject({ reservations: before.reservations + 1, attachments: before.attachments, revisions: before.revisions, operations: before.operations + 1 });
    expect(after.order_state).toBe(before.order_state);
    expect(after.order_revisions).toBe(before.order_revisions);
  });

  test.each([
    ['pdf', 'a.pdf', 'pdf'], ['PDF', 'a.PDF', 'pdf'], ['jpg', 'photo.jpg', 'jpg'], ['jpeg', 'photo.JPEG', 'jpeg'], ['png', 'scan.Png', 'png'], ['ドット付きの名前', 'a.b.c.pdf', 'pdf'],
  ])('FREQ-530-AC-02: 拡張子 %s（%s）は保存キーの拡張子 %s（小文字）になる', async (_name, fileName, extension) => {
    const s = await setup();
    expect((await reserve(s.order.id, s.actor, { fileName })).storagePath.endsWith(`.${extension}`)).toBe(true);
  });

  test.each([
    ['拡張子が無い', { fileName: 'invoice' }],
    ['拡張子が許していない（txt）', { fileName: 'invoice.txt' }],
    ['二重拡張子で最後が許していない', { fileName: 'invoice.pdf.exe' }],
    ['ドットで終わる', { fileName: 'invoice.' }],
    ['ファイル名が空', { fileName: '' }],
    ['ファイル名が空白だけ', { fileName: '   ' }],
    ['ファイル名が256字', { fileName: `${'a'.repeat(252)}.pdf` }],
    ['ファイル名に改行', { fileName: 'in\nvoice.pdf' }],
    ['ファイル名に制御文字', { fileName: 'in\u0001voice.pdf' }],
    ['ファイル名が NULL', { fileName: null }],
    ['種類が quote・invoice 以外', { kind: 'memo' }],
    ['種類が NULL', { kind: null }],
  ])('FREQ-530-AC-02: 予約の引数 %s は 22023 で、何も残らない', async (_name, args) => {
    const s = await setup();
    const before = await snapshot();
    expect(await rejected(() => reserve(s.order.id, s.actor, args))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-530-AC-02: 予約の引数 NULL（発注書・実行者・要求番号）は 22023。ファイル名はちょうど255字まで通る', async () => {
    const s = await setup();
    expect(await rejected(() => reserve(null, s.actor))).toEqual(INVALID);
    expect(await rejected(() => reserve(s.order.id, null))).toEqual(INVALID);
    expect(await rejected(() => reserve(s.order.id, s.actor, { key: null }))).toEqual(INVALID);
    expect((await reserve(s.order.id, s.actor, { fileName: `${'a'.repeat(251)}.pdf` })).storagePath.endsWith('.pdf')).toBe(true);
  });

  test('FREQ-530-AC-02: 存在しない発注書への予約は P0002（引数・権限の確かめの後）', async () => {
    const s = await setup();
    expect(await rejected(() => reserve(randomUUID(), s.actor))).toEqual(NOT_FOUND);
  });

  // ---- FREQ-530-AC-02: 確定 ----

  test('FREQ-530-AC-02: 予約 → 確定で 添付1・版1が保存され、種類・原ファイル名・保存キー・種類・大きさ・ハッシュ・出どころ・取引日・金額・取引先・実行者が残り、予約は添付に結ばれる。発注書は動かない', async () => {
    const s = await setup();
    const reserved = await reserve(s.order.id, s.actor, { kind: 'quote', fileName: 'quote.pdf' });
    const before = await snapshot();
    const key = randomUUID();
    const result = await attach(reserved.reservationId, s.order.id, s.actor, { key, size: 4096, sha: SHA, source: 'browser', date: '2026-10-20', amount: 12345, counterparty: '  工場C  ' });
    expect(result).toEqual({ attachmentId: expect.any(String), revisionNo: 1, replayed: false });

    const attachment = (await db().query(`select * from public.purchase_order_attachments where id = $1`, [result.attachmentId])).rows[0];
    expect(attachment).toMatchObject({
      purchase_order_id: s.order.id, reservation_id: reserved.reservationId, kind: 'quote', original_file_name: 'quote.pdf', storage_path: reserved.storagePath,
      mime_type: 'application/pdf', sha256: SHA, sha256_source: 'browser', uploaded_by: s.actor,
    });
    expect(Number(attachment.size_bytes)).toBe(4096);
    const revision = (await db().query(`select revision_no, transaction_date::text as day, amount_yen::int as amount, currency, counterparty, voided, reason, replaces_attachment_id, actor_id
      from public.purchase_order_attachment_revisions where attachment_id = $1`, [result.attachmentId])).rows;
    expect(revision).toEqual([{ revision_no: 1, day: '2026-10-20', amount: 12345, currency: 'JPY', counterparty: '工場C', voided: false, reason: null, replaces_attachment_id: null, actor_id: s.actor }]);

    const operation = (await db().query(`select cause_type, cause_id, actor_id, result from private.group_g_operations
      where operation = 'purchase_order_attachment_attach' and request_key = $1`, [key])).rows;
    expect(operation).toHaveLength(1);
    expect(operation[0]).toMatchObject({ cause_type: 'purchase_order', cause_id: s.order.id, actor_id: s.actor, result: { attachmentId: result.attachmentId, revisionNo: 1, replayed: false } });

    const after = await snapshot();
    expect(after).toMatchObject({ reservations: before.reservations, attachments: before.attachments + 1, revisions: before.revisions + 1, operations: before.operations + 1 });
    expect(after.reservation_state).toBe(before.reservation_state);
    expect(after.order_state).toBe(before.order_state);
    expect(after.order_revisions).toBe(before.order_revisions);
    expect(after.movements).toBe(before.movements);
    expect(after.stock_by_variant).toBe(before.stock_by_variant);
    expect(after.allocations).toBe(before.allocations);
  });

  test('FREQ-530-AC-02: sha256_source は browser と server のどちらも保存できる。他の値は 22023', async () => {
    const s = await setup();
    for (const source of ['browser', 'server']) {
      const { attached } = await addDocument(s, { source });
      const stored = (await db().query('select sha256_source from public.purchase_order_attachments where id = $1', [attached.attachmentId])).rows[0];
      expect(stored.sha256_source).toBe(source);
    }
    const reserved = await reserve(s.order.id, s.actor);
    const before = await snapshot();
    for (const source of ['Browser', 'client', '', null]) expect(await rejected(() => attach(reserved.reservationId, s.order.id, s.actor, { source }))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);
  });

  test.each([
    ['PDF', 'application/pdf'], ['JPEG', 'image/jpeg'], ['PNG', 'image/png'],
  ])('FREQ-530-AC-02: 種類 %s（%s）と、大きさ 1 と 20971520 は保存できる', async (_name, mime) => {
    const s = await setup();
    for (const size of [1, 20971520]) {
      const { attached } = await addDocument(s, { mime, size });
      const stored = (await db().query('select mime_type, size_bytes from public.purchase_order_attachments where id = $1', [attached.attachmentId])).rows[0];
      expect({ mime: stored.mime_type, size: Number(stored.size_bytes) }).toEqual({ mime, size });
    }
  });

  test.each([
    ['種類が許していない', { mime: 'text/plain' }],
    ['種類が NULL', { mime: null }],
    ['大きさが 0', { size: 0 }],
    ['大きさが 20 MiB を超える', { size: 20971521 }],
    ['大きさが負', { size: -1 }],
    ['大きさが NULL', { size: null }],
    ['ハッシュが大文字', { sha: SHA.toUpperCase() }],
    ['ハッシュが63桁', { sha: SHA.slice(1) }],
    ['ハッシュが16進でない', { sha: 'z'.repeat(64) }],
    ['ハッシュが NULL', { sha: null }],
    ['取引日が 2000-01-01 より前', { date: '1999-12-31' }],
    ['取引日が NULL', { date: null }],
    ['取引日が infinity', { date: 'infinity' }],
    ['金額が負', { amount: -1 }],
    ['金額が上限超え', { amount: 100000000000 }],
    ['金額が NULL', { amount: null }],
    ['通貨が JPY でない', { currency: 'USD' }],
    ['通貨が小文字', { currency: 'jpy' }],
    ['通貨が NULL', { currency: null }],
    ['取引先が空', { counterparty: '' }],
    ['取引先が空白だけ', { counterparty: '   ' }],
    ['取引先が101字', { counterparty: 'あ'.repeat(101) }],
    ['取引先が NULL', { counterparty: null }],
  ])('FREQ-530-AC-02: 確定の引数 %s は 22023 で、何も残らない（予約は消えず、その後に正しい値で確定できる）', async (_name, args) => {
    const s = await setup();
    const reserved = await reserve(s.order.id, s.actor);
    const before = await snapshot();
    expect(await rejected(() => attach(reserved.reservationId, s.order.id, s.actor, args))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);
    expect((await attach(reserved.reservationId, s.order.id, s.actor)).revisionNo).toBe(1);
  });

  test('FREQ-530-AC-02: 確定の引数 NULL（予約・発注書・実行者・要求番号）は 22023。上限ちょうど（金額 99999999999・取引日 2000-01-01・取引先100字・金額 0）は通る', async () => {
    const s = await setup();
    const reserved = await reserve(s.order.id, s.actor);
    expect(await rejected(() => attach(null, s.order.id, s.actor))).toEqual(INVALID);
    expect(await rejected(() => attach(reserved.reservationId, null, s.actor))).toEqual(INVALID);
    expect(await rejected(() => attach(reserved.reservationId, s.order.id, null))).toEqual(INVALID);
    expect(await rejected(() => attach(reserved.reservationId, s.order.id, s.actor, { key: null }))).toEqual(INVALID);
    expect((await attach(reserved.reservationId, s.order.id, s.actor, { amount: 99999999999, date: '2000-01-01', counterparty: 'あ'.repeat(100) })).revisionNo).toBe(1);
    const zero = await addDocument(s, { amount: 0, date: '2099-12-31' });
    expect(zero.attached.revisionNo).toBe(1);
  });

  test('FREQ-530-AC-02: 予約だけの間は添付として見えず、詳細の pendingUploads に出る（expired: false）。確定すると pendingUploads から消えて attachments に出る', async () => {
    const s = await setup();
    const reserved = await reserve(s.order.id, s.actor, { kind: 'quote', fileName: 'quote.pdf' });
    const waiting = await detailOf(s.actor, s.order.id);
    expect(waiting.attachments).toEqual([]);
    expect(waiting.pendingUploads).toEqual([{
      reservationId: reserved.reservationId, kind: 'quote', fileName: 'quote.pdf', createdAt: expect.any(String), expiresAt: expect.any(String), expired: false, replacesAttachmentId: null,
    }]);

    await attach(reserved.reservationId, s.order.id, s.actor);
    const done = await detailOf(s.actor, s.order.id);
    expect(done.pendingUploads).toEqual([]);
    expect((done.attachments as Row[])).toHaveLength(1);
  });

  test('FREQ-530-AC-02: 24時間を過ぎた予約は pendingUploads に expired: true で出て、行は消えず、期限後でも確定できる', async () => {
    const s = await setup();
    const operationId = randomUUID();
    await db().query(`insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
      values ($1, 'g2_documents_test', gen_random_uuid(), $2, 'test', $3, '{}'::jsonb)`, [operationId, SHA, operationId]);
    const reservationId = randomUUID();
    await db().query(`insert into public.purchase_order_attachment_reservations
        (id, purchase_order_id, kind, original_file_name, storage_path, created_by, operation_id, expires_at, created_at)
      values ($1, $2, 'invoice', 'old.pdf', $3, $4, $5, now() - interval '1 hour', now() - interval '25 hours')`,
    [reservationId, s.order.id, `${s.order.id}/${randomUUID()}.pdf`, s.actor, operationId]);
    await flush();

    const expired = await detailOf(s.actor, s.order.id);
    expect(expired.pendingUploads).toEqual([expect.objectContaining({ reservationId, fileName: 'old.pdf', expired: true })]);
    expect((await db().query('select count(*)::int as n from public.purchase_order_attachment_reservations where id = $1', [reservationId])).rows[0].n).toBe(1);

    const attached = await attach(reservationId, s.order.id, s.actor);
    expect(attached.revisionNo).toBe(1);
    expect((await detailOf(s.actor, s.order.id)).pendingUploads).toEqual([]);
  });

  test('FREQ-530-AC-02: 同じ要求番号・同じ内容の再送は同じ結果（replayed: true）で何も増えない。内容が違えば 23505。予約も同じ（同じ保存キー）', async () => {
    const s = await setup();
    const reserveKey = randomUUID();
    const reserved = await reserve(s.order.id, s.actor, { key: reserveKey });
    const replayedReserve = await reserve(s.order.id, s.actor, { key: reserveKey });
    expect(replayedReserve).toEqual({ ...reserved, replayed: true });
    expect(await rejected(() => reserve(s.order.id, s.actor, { key: reserveKey, fileName: 'other.pdf' }))).toEqual(CONFLICT);
    expect(await rejected(() => reserve(s.order.id, s.actor, { key: reserveKey, kind: 'quote' }))).toEqual(CONFLICT);

    const attachKey = randomUUID();
    const first = await attach(reserved.reservationId, s.order.id, s.actor, { key: attachKey });
    const before = await snapshot();
    expect(await attach(reserved.reservationId, s.order.id, s.actor, { key: attachKey })).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
    for (const different of [{ amount: 1 }, { counterparty: '別' }, { sha: SHA_OTHER }, { date: '2026-10-27' }, { size: 1 }, { source: 'server' }]) {
      expect(await rejected(() => attach(reserved.reservationId, s.order.id, s.actor, { key: attachKey, ...different }))).toEqual(CONFLICT);
    }
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-530-AC-02: 別の要求番号での二重確定は GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED で、何も増えない', async () => {
    const s = await setup();
    const { reserved } = await addDocument(s);
    const before = await snapshot();
    expect(await rejected(() => attach(reserved.reservationId, s.order.id, s.actor))).toEqual(ALREADY_ATTACHED);
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-530-AC-02: 要求番号は操作ごとの別の枠（予約・確定・訂正で同じ番号を使っても衝突しない）', async () => {
    const s = await setup();
    const key = randomUUID();
    const reserved = await reserve(s.order.id, s.actor, { key });
    const attached = await attach(reserved.reservationId, s.order.id, s.actor, { key });
    expect((await revise(attached.attachmentId, s.order.id, s.actor, { key })).revisionNo).toBe(2);
  });

  test('FREQ-530-AC-02: 別の発注書の予約・存在しない予約は GROUP_G_PO_DOCUMENT_RESERVATION_INVALID。存在しない発注書は P0002', async () => {
    const s = await setup();
    const reserved = await reserve(s.order.id, s.actor);
    const before = await snapshot();
    expect(await rejected(() => attach(reserved.reservationId, s.other.id, s.actor))).toEqual(RESERVATION_INVALID);
    expect(await rejected(() => attach(randomUUID(), s.order.id, s.actor))).toEqual(RESERVATION_INVALID);
    expect(await rejected(() => attach(reserved.reservationId, randomUUID(), s.actor))).toEqual(NOT_FOUND);
    expect(await snapshot()).toEqual(before);
    expect((await attach(reserved.reservationId, s.order.id, s.actor)).revisionNo).toBe(1);
  });

  // ---- FREQ-530-AC-02: 訂正・無効化 ----

  test('FREQ-530-AC-02: 訂正は revision_no 2 を追記し、理由が必須。前の版は残り、添付の本体は変わらない。詳細の current は最新の版', async () => {
    const s = await setup();
    const { attached } = await addDocument(s);
    const attachmentBefore = (await db().query('select a::text as row from public.purchase_order_attachments a where id = $1', [attached.attachmentId])).rows[0].row;
    const before = await snapshot();
    const key = randomUUID();
    const result = await revise(attached.attachmentId, s.order.id, s.actor, { key, date: '2026-10-28', amount: 6600, counterparty: ' 工場B ', reason: '  税込に直す  ' });
    expect(result).toEqual({ attachmentId: attached.attachmentId, revisionNo: 2, replayed: false });

    const revisions = (await db().query(`select revision_no, transaction_date::text as day, amount_yen::int as amount, currency, counterparty, voided, reason, replaces_attachment_id, actor_id
      from public.purchase_order_attachment_revisions where attachment_id = $1 order by revision_no`, [attached.attachmentId])).rows;
    expect(revisions).toEqual([
      { revision_no: 1, day: '2026-10-26', amount: 6000, currency: 'JPY', counterparty: '工場A', voided: false, reason: null, replaces_attachment_id: null, actor_id: s.actor },
      { revision_no: 2, day: '2026-10-28', amount: 6600, currency: 'JPY', counterparty: '工場B', voided: false, reason: '税込に直す', replaces_attachment_id: null, actor_id: s.actor },
    ]);
    expect((await db().query('select a::text as row from public.purchase_order_attachments a where id = $1', [attached.attachmentId])).rows[0].row).toBe(attachmentBefore);
    const after = await snapshot();
    expect(after).toMatchObject({ attachments: before.attachments, revisions: before.revisions + 1, operations: before.operations + 1, reservation_state: before.reservation_state, order_state: before.order_state });
    const [current] = (await detailOf(s.actor, s.order.id)).attachments as Array<{ current: Row; revisionCount: number }>;
    expect(current.revisionCount).toBe(2);
    expect(current.current).toMatchObject({ revisionNo: 2, amountYen: 6600, counterparty: '工場B', voided: false, reason: '税込に直す' });
    expect((await db().query(`select result from private.group_g_operations where operation = 'purchase_order_attachment_revise' and request_key = $1`, [key])).rows[0].result)
      .toEqual({ attachmentId: attached.attachmentId, revisionNo: 2, replayed: false });
  });

  test('FREQ-530-AC-02: 理由が無い・空白だけは GROUP_G_PO_REASON_REQUIRED、201字は 22023。変化なし（同じ内容）は 22023', async () => {
    const s = await setup();
    const { attached } = await addDocument(s);
    const before = await snapshot();
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { reason: null }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { reason: '   ' }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { reason: 'あ'.repeat(201) }))).toEqual(INVALID);
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { date: '2026-10-26', amount: 6000, counterparty: '工場A', voided: false }))).toEqual(INVALID);
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { date: '2026-10-26', amount: 6000, counterparty: ' 工場A ', voided: false }))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);
    expect((await revise(attached.attachmentId, s.order.id, s.actor, { reason: 'あ'.repeat(200) })).revisionNo).toBe(2);
  });

  test.each([
    ['取引日が 2000-01-01 より前', { date: '1999-12-31' }],
    ['取引日が NULL', { date: null }],
    ['金額が負', { amount: -1 }],
    ['金額が上限超え', { amount: 100000000000 }],
    ['金額が NULL', { amount: null }],
    ['通貨が JPY でない', { currency: 'USD' }],
    ['取引先が空白だけ', { counterparty: '  ' }],
    ['取引先が101字', { counterparty: 'あ'.repeat(101) }],
    ['無効かどうかが NULL', { voided: null }],
    ['要求番号が NULL', { key: null }],
  ])('FREQ-530-AC-02: 訂正の引数 %s は 22023 で、何も残らない', async (_name, args) => {
    const s = await setup();
    const { attached } = await addDocument(s);
    const before = await snapshot();
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, args))).toEqual(INVALID);
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-530-AC-02: 無効化は voided=true の版を足し、理由が必須。無効でも検索・詳細に残り、訂正で有効に戻せる。revision_no は最大 + 1', async () => {
    const s = await setup();
    const { attached } = await addDocument(s);
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { date: '2026-10-26', amount: 6000, counterparty: '工場A', voided: true, reason: null }))).toEqual(REASON_REQUIRED);
    const voided = await revise(attached.attachmentId, s.order.id, s.actor, { date: '2026-10-26', amount: 6000, counterparty: '工場A', voided: true, reason: '二重に登録した' });
    expect(voided.revisionNo).toBe(2);
    let [current] = (await detailOf(s.actor, s.order.id)).attachments as Array<{ current: Row }>;
    expect(current.current).toMatchObject({ revisionNo: 2, voided: true, reason: '二重に登録した' });
    expect((await scoped(s)).map((row) => [row.original_file_name, row.voided])).toEqual([['invoice.pdf', true]]);

    const restored = await revise(attached.attachmentId, s.order.id, s.actor, { date: '2026-10-26', amount: 6000, counterparty: '工場A', voided: false, reason: '誤って無効にした' });
    expect(restored.revisionNo).toBe(3);
    [current] = (await detailOf(s.actor, s.order.id)).attachments as Array<{ current: Row }>;
    expect(current.current).toMatchObject({ revisionNo: 3, voided: false });
    expect((await db().query('select count(*)::int as n from public.purchase_order_attachment_revisions where attachment_id = $1', [attached.attachmentId])).rows[0].n).toBe(3);
  });

  test('FREQ-530-AC-02: 他の発注書の添付・存在しない添付の訂正は 22023。存在しない発注書は P0002。同じ要求番号の再送は同じ結果で、内容が違えば 23505', async () => {
    const s = await setup();
    const { attached } = await addDocument(s);
    expect(await rejected(() => revise(attached.attachmentId, s.other.id, s.actor))).toEqual(INVALID);
    expect(await rejected(() => revise(randomUUID(), s.order.id, s.actor))).toEqual(INVALID);
    expect(await rejected(() => revise(attached.attachmentId, randomUUID(), s.actor))).toEqual(NOT_FOUND);
    const key = randomUUID();
    const first = await revise(attached.attachmentId, s.order.id, s.actor, { key });
    const before = await snapshot();
    expect(await revise(attached.attachmentId, s.order.id, s.actor, { key })).toEqual({ ...first, replayed: true });
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { key, reason: '別の理由' }))).toEqual(CONFLICT);
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor, { key, voided: true }))).toEqual(CONFLICT);
    expect(await snapshot()).toEqual(before);
  });

  // ---- FREQ-530-AC-02: 差し替え ----

  test('FREQ-530-AC-02: 差し替えは新しい添付で、replaces_attachment_id が版1に残り、旧添付と旧版は1文字も変わらない。訂正した後も詳細の replacesAttachmentId は版1から読める', async () => {
    const s = await setup();
    const old = await addDocument(s, { amount: 6000 });
    const revisedOld = await revise(old.attached.attachmentId, s.order.id, s.actor);
    expect(revisedOld.revisionNo).toBe(2);
    const oldRows = async () => (await db().query(`select
      (select string_agg(a::text, ',' order by a.id) from public.purchase_order_attachments a where a.id = $1) as attachment,
      (select string_agg(v::text, ',' order by v.revision_no) from public.purchase_order_attachment_revisions v where v.attachment_id = $1) as revisions,
      (select string_agg(r::text, ',') from public.purchase_order_attachment_reservations r where r.id = $2) as reservation`, [old.attached.attachmentId, old.reserved.reservationId])).rows[0];
    const oldBefore = await oldRows();

    // 差し替え元は予約の時に渡し、確定は予約から写す（確定の関数は差し替え元の引数を持たない）
    const reserved = await reserve(s.order.id, s.actor, { fileName: 'new.pdf', replaces: old.attached.attachmentId });
    const reservationRow = async () => (await db().query('select r::text as row from public.purchase_order_attachment_reservations r where r.id = $1', [reserved.reservationId])).rows[0].row as string;
    const reservationBefore = await reservationRow();
    const replacement = await attach(reserved.reservationId, s.order.id, s.actor, { amount: 6600 });
    expect(replacement.attachmentId).not.toBe(old.attached.attachmentId);
    expect((await db().query('select revision_no, replaces_attachment_id from public.purchase_order_attachment_revisions where attachment_id = $1', [replacement.attachmentId])).rows)
      .toEqual([{ revision_no: 1, replaces_attachment_id: old.attached.attachmentId }]);
    expect(await oldRows()).toEqual(oldBefore);
    // 予約の行は確定しても1文字も変わらない（差し替え元もそのまま）
    expect(await reservationRow()).toBe(reservationBefore);

    await revise(replacement.attachmentId, s.order.id, s.actor, { reason: '訂正' });
    const attachments = (await detailOf(s.actor, s.order.id)).attachments as Array<{ id: string; current: { revisionNo: number; replacesAttachmentId: string | null } }>;
    const replaced = attachments.find((attachment) => attachment.id === replacement.attachmentId)!;
    expect(replaced.current).toMatchObject({ revisionNo: 2, replacesAttachmentId: old.attached.attachmentId });
    expect(attachments.find((attachment) => attachment.id === old.attached.attachmentId)!.current.replacesAttachmentId).toBeNull();
  });

  test('FREQ-530-AC-02: 他の発注書の添付・存在しない添付を差し替え元にした予約は GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID（22023）で、予約も操作の記録も残らない。同じ要求番号で正しい差し替え元にすれば予約できる', async () => {
    const s = await setup();
    const foreign = await addDocument(s, {}, s.other.id);
    const own = await addDocument(s);
    const before = await snapshot();
    const key = randomUUID();
    expect(await rejected(() => reserve(s.order.id, s.actor, { key, replaces: foreign.attached.attachmentId }))).toEqual(REPLACEMENT_INVALID);
    expect(await rejected(() => reserve(s.order.id, s.actor, { key, replaces: randomUUID() }))).toEqual(REPLACEMENT_INVALID);
    expect(await snapshot()).toEqual(before);
    const reserved = await reserve(s.order.id, s.actor, { key, replaces: own.attached.attachmentId });
    expect(reserved.replayed).toBe(false);
    expect((await attach(reserved.reservationId, s.order.id, s.actor)).revisionNo).toBe(1);
  });

  test('FREQ-530-AC-02: 差し替えの予約は、権限・存在の確かめの後に差し替え元を確かめる（権限が無ければ 42501、発注書が無ければ P0002 が先）', async () => {
    const s = await setup();
    const foreign = await addDocument(s, {}, s.other.id);
    expect(await rejected(() => reserve(randomUUID(), s.actor, { replaces: foreign.attached.attachmentId }))).toEqual(NOT_FOUND);
    expect(await rejected(() => reserve(s.order.id, randomUUID(), { replaces: foreign.attached.attachmentId }))).toEqual(FORBIDDEN);
  });

  test('FREQ-530-AC-02: 差し替え元は予約に残り、保存の途中で止まって頁を読み直しても（詳細の pendingUploads から）変わらず読める。確定すると版1へ写り、一覧から消える', async () => {
    const s = await setup();
    const old = await addDocument(s);
    const reserved = await reserve(s.order.id, s.actor, { fileName: 'new.pdf', replaces: old.attached.attachmentId });
    expect((await db().query('select replaces_attachment_id from public.purchase_order_attachment_reservations where id = $1', [reserved.reservationId])).rows)
      .toEqual([{ replaces_attachment_id: old.attached.attachmentId }]);

    // 頁を読み直す = 詳細を読み直す。何度読んでも差し替え元が残っている
    for (let round = 0; round < 2; round += 1) {
      expect((await detailOf(s.actor, s.order.id)).pendingUploads).toEqual([expect.objectContaining({
        reservationId: reserved.reservationId, fileName: 'new.pdf', replacesAttachmentId: old.attached.attachmentId,
      })]);
    }
    // 再開（同じ予約への確定）は差し替え元を引数で受けず、予約のものを版1に写す
    const replacement = await attach(reserved.reservationId, s.order.id, s.actor, { amount: 7000 });
    expect((await db().query('select replaces_attachment_id from public.purchase_order_attachment_revisions where attachment_id = $1 and revision_no = 1', [replacement.attachmentId])).rows)
      .toEqual([{ replaces_attachment_id: old.attached.attachmentId }]);
    const after = await detailOf(s.actor, s.order.id);
    expect(after.pendingUploads).toEqual([]);
    expect((after.attachments as Array<{ id: string; current: { replacesAttachmentId: string | null } }>).find((attachment) => attachment.id === replacement.attachmentId)!.current.replacesAttachmentId)
      .toBe(old.attached.attachmentId);
  });

  test('FREQ-530-AC-02: 差し替えでない予約は replaces_attachment_id が NULL のまま確定され、版1にも付かない。差し替えと新規で同じ要求番号を使うと内容が違うので 23505', async () => {
    const s = await setup();
    const old = await addDocument(s);
    const key = randomUUID();
    const plain = await reserve(s.order.id, s.actor, { key, fileName: 'plain.pdf' });
    expect((await db().query('select replaces_attachment_id from public.purchase_order_attachment_reservations where id = $1', [plain.reservationId])).rows).toEqual([{ replaces_attachment_id: null }]);
    expect(await reserve(s.order.id, s.actor, { key, fileName: 'plain.pdf' })).toEqual({ ...plain, replayed: true });
    expect(await rejected(() => reserve(s.order.id, s.actor, { key, fileName: 'plain.pdf', replaces: old.attached.attachmentId }))).toEqual(CONFLICT);
    const attached = await attach(plain.reservationId, s.order.id, s.actor);
    expect((await db().query('select replaces_attachment_id from public.purchase_order_attachment_revisions where attachment_id = $1', [attached.attachmentId])).rows).toEqual([{ replaces_attachment_id: null }]);

    // 差し替えの予約の再送も同じ予約を返し、予約は増えない
    const replaceKey = randomUUID();
    const first = await reserve(s.order.id, s.actor, { key: replaceKey, fileName: 'next.pdf', replaces: old.attached.attachmentId });
    const before = await snapshot();
    expect(await reserve(s.order.id, s.actor, { key: replaceKey, fileName: 'next.pdf', replaces: old.attached.attachmentId })).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
    expect(await rejected(() => reserve(s.order.id, s.actor, { key: replaceKey, fileName: 'next.pdf', replaces: attached.attachmentId }))).toEqual(CONFLICT);
  });

  // ---- FREQ-530-AC-02: 検索 ----

  /**
   * 検索用の材料: 4つの書類。並びは 取引日の新しい順。既定は発注書2つ（a・b が s.order、c・d が s.other）。
   * single: true なら 4 つとも s.order に置く（s.other は空）。
   * 同じ DB には他の試験（発注書の並行の試験など）が確定した原本の行が残ることがあるので、検索の結果や件数を比べる試験は、
   * その発注書にしか当たらない発注書番号の全桁を検索に足す（scoped）か、頁をたどって集めた結果をこの試験の発注書の行に絞る（searchOwn）。
   */
  async function searchData(options: { single?: boolean } = {}) {
    const s = await setup();
    const a = await addDocument(s, { fileName: 'a.pdf', kind: 'invoice', date: '2026-10-26', amount: 6000, counterparty: '工場A' });
    const b = await addDocument(s, { fileName: 'b.pdf', kind: 'quote', date: '2026-09-15', amount: 1000, counterparty: 'Alpha_100%' });
    const otherId = options.single ? s.order.id : s.other.id;
    const c = await addDocument(s, { fileName: 'c.pdf', kind: 'invoice', date: '2026-10-01', amount: 99999, counterparty: 'beta\\corp' }, otherId);
    const d = await addDocument(s, { fileName: 'd.pdf', kind: 'quote', date: '2026-10-26', amount: 6000, counterparty: 'ALPHA corp' }, otherId);
    return { s, a, b, c, d };
  }
  const names = (rows: Row[]) => rows.map((row) => row.original_file_name as string);
  const sorted = (rows: Row[]) => names(rows).sort();
  type Scope = { actor: string; order: { id: string; number: string }; other: { id: string; number: string } };
  /** 検索を、その発注書の番号の全桁（その発注書にしか当たらない）で絞る。total・頁・件数も、この発注書だけの数になる */
  const scoped = (s: Scope, args: Record<string, unknown> = {}) => search(s.actor, { number: s.order.number, ...args });
  /**
   * 発注書番号の前方一致・種類のように、他の発注書にも当たる検索に使う。1 頁の上限（100 件）に頼らないよう、total まで頁をたどって
   * 全件を集めてから、この試験の発注書（s.order・s.other）の行だけに絞る（同じ DB に何件の他の行が残っていても結果は変わらない）。
   */
  async function searchOwn(s: Scope, args: Record<string, unknown> = {}): Promise<Row[]> {
    const collected: Row[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await search(s.actor, { ...args, limit: 100, offset });
      collected.push(...page);
      if (page.length === 0 || offset + page.length >= Number(page[0].total)) break;
    }
    return collected.filter((row) => [s.order.id, s.other.id].includes(String(row.purchase_order_id)));
  }

  test('FREQ-530-AC-02: 検索の結果は 18列だけ（storage_path を含まない）。既定は各添付の最新の版だけ。並びは 取引日 DESC・版の記録 DESC・版の id', async () => {
    const { s } = await searchData({ single: true });
    const rows = await scoped(s);
    expect(Object.keys(rows[0])).toEqual(['total', 'attachment_id', 'purchase_order_id', 'purchase_order_number', 'kind', 'original_file_name', 'mime_type', 'size_bytes',
      'revision_no', 'is_current', 'transaction_date', 'amount_yen', 'currency', 'counterparty', 'voided', 'reason', 'replaces_attachment_id', 'created_at']);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => Number(row.total) === 4 && row.is_current === true && row.revision_no === 1)).toBe(true);
    const expected = (await db().query(`select a.original_file_name as name from public.purchase_order_attachment_revisions r
      join public.purchase_order_attachments a on a.id = r.attachment_id
      where a.purchase_order_id = $1
      order by r.transaction_date desc, r.created_at desc, r.id`, [s.order.id])).rows.map((row) => row.name);
    expect(names(rows)).toEqual(expected);
    expect(names(rows).slice(2)).toEqual(['c.pdf', 'b.pdf']);
    const first = rows[0];
    expect(first).toMatchObject({ kind: expect.stringMatching(/^(invoice|quote)$/), mime_type: 'application/pdf', currency: 'JPY', voided: false, reason: null, replaces_attachment_id: null });
    expect(Number(first.size_bytes)).toBe(2048);
    expect(String(first.purchase_order_number)).toMatch(/^PO-\d{8}-\d{4}$/);
  });

  test('FREQ-530-AC-02: 取引日の範囲は両端を含む', async () => {
    const { s } = await searchData({ single: true });
    expect(sorted(await scoped(s, { from: '2026-10-01', to: '2026-10-26' }))).toEqual(['a.pdf', 'c.pdf', 'd.pdf']);
    expect(sorted(await scoped(s, { from: '2026-10-26' }))).toEqual(['a.pdf', 'd.pdf']);
    expect(sorted(await scoped(s, { to: '2026-09-15' }))).toEqual(['b.pdf']);
    expect(sorted(await scoped(s, { from: '2026-10-02', to: '2026-10-25' }))).toEqual([]);
    expect(sorted(await scoped(s, { from: '2026-10-27' }))).toEqual([]);
  });

  test('FREQ-530-AC-02: 金額の範囲は両端を含む', async () => {
    const { s } = await searchData({ single: true });
    expect(sorted(await scoped(s, { min: 1000, max: 6000 }))).toEqual(['a.pdf', 'b.pdf', 'd.pdf']);
    expect(sorted(await scoped(s, { min: 6001 }))).toEqual(['c.pdf']);
    expect(sorted(await scoped(s, { max: 999 }))).toEqual([]);
    expect(sorted(await scoped(s, { min: 99999, max: 99999 }))).toEqual(['c.pdf']);
  });

  test('FREQ-530-AC-02: 取引先は大文字小文字を区別しない部分一致で、% _ \\ は文字として扱う', async () => {
    const { s } = await searchData({ single: true });
    expect(sorted(await scoped(s, { counterparty: 'alpha' }))).toEqual(['b.pdf', 'd.pdf']);
    expect(sorted(await scoped(s, { counterparty: 'ALPHA CORP' }))).toEqual(['d.pdf']);
    expect(sorted(await scoped(s, { counterparty: '工場' }))).toEqual(['a.pdf']);
    expect(sorted(await scoped(s, { counterparty: 'ha_1' }))).toEqual(['b.pdf']);
    expect(sorted(await scoped(s, { counterparty: '0%' }))).toEqual(['b.pdf']);
    expect(sorted(await scoped(s, { counterparty: '%' }))).toEqual(['b.pdf']);
    expect(sorted(await scoped(s, { counterparty: '_' }))).toEqual(['b.pdf']);
    expect(sorted(await scoped(s, { counterparty: '\\' }))).toEqual(['c.pdf']);
    expect(sorted(await scoped(s, { counterparty: 'a%a' }))).toEqual([]);
    expect(sorted(await scoped(s, { counterparty: 'zzz' }))).toEqual([]);
  });

  test('FREQ-530-AC-02: 発注書番号は前方一致（大文字小文字を区別しない）。種類で絞る。組合せは AND', async () => {
    const { s } = await searchData();
    const mine = s.order.number;
    const theirs = s.other.number;
    // 全桁の番号と、どの番号にも当たらない前方一致は、他の試験の行が同じ DB にあっても同じ結果。
    // 前方が日付までの番号・種類だけの検索は、同じ日の他の発注書にも当たるので、この試験の発注書の行に絞って比べる
    expect(sorted(await search(s.actor, { number: mine }))).toEqual(['a.pdf', 'b.pdf']);
    expect(sorted(await search(s.actor, { number: theirs.toLowerCase() }))).toEqual(['c.pdf', 'd.pdf']);
    expect(sorted(await searchOwn(s, { number: mine.slice(0, 11) }))).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']);
    expect(sorted(await search(s.actor, { number: mine.slice(3) }))).toEqual([]);
    expect(sorted(await searchOwn(s, { number: 'PO-' }))).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']);
    expect(sorted(await searchOwn(s, { kind: 'quote' }))).toEqual(['b.pdf', 'd.pdf']);
    expect(sorted(await searchOwn(s, { kind: 'invoice' }))).toEqual(['a.pdf', 'c.pdf']);
    expect(sorted(await searchOwn(s, { kind: 'quote', counterparty: 'alpha', from: '2026-10-01' }))).toEqual(['d.pdf']);
    expect(sorted(await search(s.actor, { kind: 'invoice', number: theirs, min: 50000, max: 100000, from: '2026-10-01', to: '2026-10-01', counterparty: 'BETA' }))).toEqual(['c.pdf']);
    expect(sorted(await search(s.actor, { kind: 'quote', number: theirs, counterparty: '工場' }))).toEqual([]);
  });

  test('FREQ-530-AC-02: 既定は最新の版だけ。includeHistory で訂正前の取引日・金額・取引先でも見つかり、訂正前の版は is_current=false', async () => {
    const { s, a } = await searchData({ single: true });
    await revise(a.attached.attachmentId, s.order.id, s.actor, { date: '2026-11-02', amount: 7700, counterparty: '新工場', reason: '訂正' });
    // 既定: 最新の版だけ
    expect(sorted(await scoped(s, { counterparty: '新工場' }))).toEqual(['a.pdf']);
    expect(await scoped(s, { counterparty: '工場A' })).toEqual([]);
    expect(await scoped(s, { from: '2026-10-26', to: '2026-10-26', kind: 'invoice' })).toEqual([]);
    expect(await scoped(s, { min: 6000, max: 6000, kind: 'invoice' })).toEqual([]);
    // 履歴を含める: 訂正前の値でも見つかる
    const byOldParty = await scoped(s, { counterparty: '工場A', history: true });
    expect(byOldParty.map((row) => [row.original_file_name, row.revision_no, row.is_current, row.counterparty])).toEqual([['a.pdf', 1, false, '工場A']]);
    const byOldDate = await scoped(s, { from: '2026-10-26', to: '2026-10-26', kind: 'invoice', history: true });
    expect(byOldDate.map((row) => [row.revision_no, row.is_current])).toEqual([[1, false]]);
    const byOldAmount = await scoped(s, { min: 6000, max: 6000, kind: 'invoice', history: true });
    expect(byOldAmount.map((row) => [row.revision_no, row.is_current])).toEqual([[1, false]]);
    // 新しい値でも見つかり、最新の版は is_current=true
    const all = await scoped(s, { history: true });
    expect(all).toHaveLength(5);
    expect(all.filter((row) => row.original_file_name === 'a.pdf').map((row) => [row.revision_no, row.is_current]).sort()).toEqual([[1, false], [2, true]]);
    expect(all.every((row) => Number(row.total) === 5)).toBe(true);
  });

  test('FREQ-530-AC-02: 同じ取引日の版は 版の記録の新しい方が先（created_at DESC）', async () => {
    const s = await setup();
    const { attached } = await addDocument(s, { date: '2026-10-26' });
    const operationId = randomUUID();
    await db().query(`insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
      values ($1, 'g2_documents_test', gen_random_uuid(), $2, 'test', $3, '{}'::jsonb)`, [operationId, SHA, operationId]);
    await db().query(`insert into public.purchase_order_attachment_revisions
        (attachment_id, revision_no, transaction_date, amount_yen, currency, counterparty, voided, reason, actor_id, operation_id, created_at)
      values ($1, 2, '2026-10-26', 6000, 'JPY', '工場A', true, '後から無効', $2, $3, now() + interval '1 hour')`, [attached.attachmentId, s.actor, operationId]);
    await flush();
    const rows = await scoped(s, { history: true });
    expect(rows.map((row) => row.revision_no)).toEqual([2, 1]);
  });

  test('FREQ-530-AC-02: ページ送り（limit・offset）。total は頁を切る前の件数', async () => {
    const { s } = await searchData({ single: true });
    const all = names(await scoped(s));
    const page1 = await scoped(s, { limit: 1, offset: 0 });
    const page2 = await scoped(s, { limit: 1, offset: 1 });
    const page5 = await scoped(s, { limit: 3, offset: 3 });
    expect([names(page1), names(page2), names(page5)]).toEqual([[all[0]], [all[1]], [all[3]]]);
    expect([page1, page2, page5].every((rows) => rows.every((row) => Number(row.total) === 4))).toBe(true);
    expect(await scoped(s, { limit: 5, offset: 10 })).toEqual([]);
  });

  test.each([
    ['limit が 0', { limit: 0 }], ['limit が 101', { limit: 101 }], ['limit が NULL', { limit: null }], ['offset が負', { offset: -1 }], ['offset が NULL', { offset: null }],
    ['includeHistory が NULL', { history: null }], ['種類が quote・invoice 以外', { kind: 'memo' }],
  ])('FREQ-530-AC-02: 検索の引数 %s は 22023', async (_name, args) => {
    const { s } = await searchData();
    expect(await rejected(() => search(s.actor, args))).toEqual(INVALID);
  });

  test('FREQ-530-AC-02: 検索は何も書かない（表・操作の記録の行数と中身が変わらない）。公開入口と private 本体は同じ結果', async () => {
    const { s } = await searchData({ single: true });
    const before = await snapshot();
    const viaPublic = await scoped(s, { history: true });
    const viaPrivate = await scoped(s, { history: true, schema: 'private' });
    expect(viaPublic).toHaveLength(4);
    expect(viaPrivate).toEqual(viaPublic);
    expect(await snapshot()).toEqual(before);
  });

  // ---- FREQ-530-AC-01: 追記専用 ----

  test('FREQ-530-AC-01: 関数経由でも既存の添付・版・予約を書き換えられない（どの操作の後も、既存の行は1文字も変わらず、行は増えるだけ）', async () => {
    const s = await setup();
    const first = await addDocument(s);
    const rowsOf = async () => (await db().query(`select
      (select string_agg(r::text, '|' order by r.id) from public.purchase_order_attachment_reservations r) as reservations,
      (select string_agg(a::text, '|' order by a.id) from public.purchase_order_attachments a) as attachments,
      (select string_agg(v::text, '|' order by v.id) from public.purchase_order_attachment_revisions v) as revisions`)).rows[0];
    const original = await rowsOf();
    await revise(first.attached.attachmentId, s.order.id, s.actor);
    await revise(first.attached.attachmentId, s.order.id, s.actor, { voided: true, reason: '無効', date: '2026-10-27', amount: 7000, counterparty: '工場B' });
    const second = await addDocument(s);
    await reserve(s.order.id, s.actor);
    const later = await rowsOf();
    for (const column of ['reservations', 'attachments', 'revisions'] as const) {
      const originalRows = String(original[column]).split('|');
      const laterRows = String(later[column]).split('|');
      for (const row of originalRows) expect(laterRows).toContain(row);
      expect(laterRows.length).toBeGreaterThan(originalRows.length);
    }
    expect(second.attached.attachmentId).not.toBe(first.attached.attachmentId);
  });

  test.each([
    ['purchase_order_attachment_reservations', 'original_file_name'],
    ['purchase_order_attachment_reservations', 'replaces_attachment_id'],
    ['purchase_order_attachments', 'original_file_name'],
    ['purchase_order_attachment_revisions', 'counterparty'],
  ])('FREQ-530-AC-01: %s は owner の UPDATE・DELETE・TRUNCATE も GROUP_G_HISTORY_IMMUTABLE で断る', async (table, column) => {
    const s = await setup();
    await addDocument(s);
    await flush();
    expect(await rejected(() => db().query(`update public.${table} set ${column} = ${column}`))).toEqual(IMMUTABLE);
    expect(await rejected(() => db().query(`delete from public.${table}`))).toEqual(IMMUTABLE);
    expect(await rejected(() => db().query(`truncate public.${table} cascade`))).toMatchObject({ code: expect.stringMatching(/^(55000|0A000)$/) });
    expect((await db().query(`select count(*)::int as n from public.${table}`)).rows[0].n).toBeGreaterThan(0);
  });

  test('FREQ-530-AC-01: service_role も表を直接書けない（INSERT・UPDATE・DELETE は 42501）。読めるのは添付と予約の表だけ（版の表は読めない）。anon・authenticated は何も読めない', async () => {
    const s = await setup();
    const { attached } = await addDocument(s);
    const attempt = async (role: string, sql: string, params: unknown[] = []) => {
      await db().query('savepoint role_attempt');
      try {
        await db().query(`set local role ${role}`);
        const result = await db().query(sql, params);
        return { rows: result.rows.length };
      } catch (caught) {
        return { code: (caught as { code?: string }).code ?? 'unknown' };
      } finally {
        await db().query('rollback to savepoint role_attempt');
        await db().query('release savepoint role_attempt');
      }
    };
    // 同じ DB に他の試験が確定した行があっても数えない: この試験の添付と、その予約の 1 行だけを読む
    expect(await attempt('service_role', 'select id from public.purchase_order_attachments where id = $1', [attached.attachmentId])).toEqual({ rows: 1 });
    expect(await attempt('service_role', 'select id from public.purchase_order_attachment_reservations where purchase_order_id = $1', [s.order.id])).toEqual({ rows: 1 });
    expect(await attempt('service_role', 'select id from public.purchase_order_attachment_revisions')).toEqual({ code: '42501' });
    for (const table of ['purchase_order_attachment_reservations', 'purchase_order_attachments', 'purchase_order_attachment_revisions']) {
      expect(await attempt('service_role', `update public.${table} set id = id`)).toEqual({ code: '42501' });
      expect(await attempt('service_role', `delete from public.${table}`)).toEqual({ code: '42501' });
      expect(await attempt('service_role', `truncate public.${table}`)).toEqual({ code: '42501' });
      for (const role of ['anon', 'authenticated']) expect(await attempt(role, `select 1 from public.${table}`)).toEqual({ code: '42501' });
    }
    expect(await attempt('service_role', `insert into public.purchase_order_attachment_revisions (attachment_id, revision_no, transaction_date, amount_yen, currency, counterparty, actor_id, operation_id)
      values ($1, 9, '2026-10-26', 1, 'JPY', 'x', $2, $3)`, [attached.attachmentId, s.actor, randomUUID()])).toEqual({ code: '42501' });
  });

  // ---- FREQ-530-AC-03: 保存キーを外へ出さない ----

  test('FREQ-530-AC-03: storage_path は詳細にも検索にも出ない（保存キーも保存キーの列名も）。予約中・確定後・訂正後のどれでも', async () => {
    const s = await setup();
    const reserved = await reserve(s.order.id, s.actor);
    const check = async () => {
      const detail = JSON.stringify(await detailOf(s.actor, s.order.id));
      const found = JSON.stringify(await scoped(s, { history: true }));
      for (const text of [detail, found]) {
        expect(text).not.toContain(reserved.storagePath);
        expect(text).not.toContain(reserved.storagePath.split('/')[1]);
        expect(text.toLowerCase()).not.toContain('storage_path');
        expect(text).not.toContain('storagePath');
      }
    };
    await check();
    const attached = await attach(reserved.reservationId, s.order.id, s.actor);
    await check();
    await revise(attached.attachmentId, s.order.id, s.actor);
    await check();
  });

  // ---- FREQ-540-AC-07: 権限 ----

  test('FREQ-540-AC-07: 3つの書込みは manage と read の両方が要る。items.*・在庫・受け取りの権限だけ、manage だけ、read だけ、無効・期限切れ・役割なし・存在しない実行者は 42501', async () => {
    const s = await setup();
    const { reserved, attached } = await addDocument(s);
    const before = await snapshot();
    const attempts = async (actor: string | null) => [
      await rejected(() => reserve(s.order.id, actor)),
      await rejected(() => attach(reserved.reservationId, s.order.id, actor, { key: randomUUID() })),
      await rejected(() => revise(attached.attachmentId, s.order.id, actor)),
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
    const unionReserved = await reserve(s.order.id, union);
    expect((await attach(unionReserved.reservationId, s.order.id, union)).revisionNo).toBe(1);
    expect((await revise(attached.attachmentId, s.order.id, union)).revisionNo).toBe(2);
  });

  test('FREQ-540-AC-07: 実行者の現在の権限を毎回確かめる。manage を外すとその場から断られる', async () => {
    const s = await setup();
    const { attached } = await addDocument(s);
    await revoke('admin', ['admin.purchase_orders.manage']);
    expect(await rejected(() => reserve(s.order.id, s.actor))).toEqual(FORBIDDEN);
    expect(await rejected(() => revise(attached.attachmentId, s.order.id, s.actor))).toEqual(FORBIDDEN);
  });

  test('FREQ-540-AC-07: 検索は purchase_orders.read を持たない実行者に GROUP_G_FORBIDDEN / 42501（無効・期限切れ・役割なし・存在しない実行者・NULL・manage だけ・items.*・在庫・受け取りだけ）。read だけの人は検索できる', async () => {
    const { s: data } = await searchData({ single: true });
    const inactive = await createActor(['admin'], { inactive: ['admin'] });
    const expired = await createActor(['admin'], { expired: ['admin'] });
    const noRoles = await createActor([]);
    expect(await rejected(() => search(null))).toEqual(FORBIDDEN);
    expect(await rejected(() => search(randomUUID()))).toEqual(FORBIDDEN);
    expect(await rejected(() => search(inactive))).toEqual(FORBIDDEN);
    expect(await rejected(() => search(expired))).toEqual(FORBIDDEN);
    expect(await rejected(() => search(noRoles))).toEqual(FORBIDDEN);
    await grant('supporter', ['admin.items.read', 'admin.items.manage', 'admin.stock.read', 'admin.stock.manage', 'admin.receiving.manage', 'admin.purchase_orders.manage']);
    const noRead = await createActor(['supporter']);
    expect(await rejected(() => search(noRead))).toEqual(FORBIDDEN);
    expect(await rejected(() => search(noRead, { schema: 'private' }))).toEqual(FORBIDDEN);
    // 権限の確かめが引数の確かめより先: 権限が無ければ範囲外の引数でも 42501
    expect(await rejected(() => search(noRead, { limit: 0 }))).toEqual(FORBIDDEN);
    await grant('supporter', ['admin.purchase_orders.read']);
    expect(await search(noRead, { number: data.order.number })).toHaveLength(4);
  });

  test('FREQ-540-AC-07: 実行者の現在の権限を毎回確かめる。read を外すと検索もその場から断られる', async () => {
    const { s } = await searchData({ single: true });
    expect(await scoped(s)).toHaveLength(4);
    await revoke('admin', ['admin.purchase_orders.read']);
    expect(await rejected(() => search(s.actor))).toEqual(FORBIDDEN);
  });

  // ---- 途中失敗 ----

  test('FREQ-530-AC-02: 途中失敗（版・添付・予約・操作の記録の INSERT に故障を注入）では、先に書いた行が全部残らず、同じ要求番号は後で作り直せる', async () => {
    const s = await setup();
    const { attached } = await addDocument(s);
    const reserved = await reserve(s.order.id, s.actor);
    await db().query(`create function public.g2_inject_doc_revision_failure() returns trigger language plpgsql as $$
      begin
        raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
          detail = (select count(*)::text from public.purchase_order_attachments where reservation_id = '${reserved.reservationId}'::uuid);
      end $$`);
    await db().query(`create function public.g2_inject_doc_operation_failure() returns trigger language plpgsql as $$
      begin
        if new.operation like 'purchase_order_attachment_%' then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001', detail = new.operation;
        end if;
        return new;
      end $$`);
    const keys = { reserve: randomUUID(), attach: randomUUID(), revise: randomUUID() };
    const calls = {
      reserve: () => reserve(s.order.id, s.actor, { key: keys.reserve, fileName: 'x.pdf' }),
      attach: () => attach(reserved.reservationId, s.order.id, s.actor, { key: keys.attach }),
      revise: () => revise(attached.attachmentId, s.order.id, s.actor, { key: keys.revise }),
    };
    const before = await snapshot();
    const failed = async (run: () => Promise<unknown>) => {
      await db().query('savepoint injected');
      let caught: { code?: string; message?: string; detail?: string } = {};
      try { await run(); } catch (e) { caught = e as typeof caught; }
      await db().query('rollback to savepoint injected');
      await db().query('release savepoint injected');
      return caught;
    };

    // 確定: 版の INSERT で失敗（添付は書かれた後）
    await db().query('create trigger g2_inject_doc_revision before insert on public.purchase_order_attachment_revisions for each row execute function public.g2_inject_doc_revision_failure()');
    expect(await failed(calls.attach)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '1' });
    expect(await snapshot()).toEqual(before);
    expect(await failed(calls.revise)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_doc_revision on public.purchase_order_attachment_revisions');

    // 3つとも、最後の操作の記録で失敗: 先に書いた物が全部残らない
    await db().query('create trigger g2_inject_doc_operation before insert on private.group_g_operations for each row execute function public.g2_inject_doc_operation_failure()');
    expect(await failed(calls.reserve)).toMatchObject({ code: 'P0001', detail: 'purchase_order_attachment_reserve' });
    expect(await failed(calls.attach)).toMatchObject({ code: 'P0001', detail: 'purchase_order_attachment_attach' });
    expect(await failed(calls.revise)).toMatchObject({ code: 'P0001', detail: 'purchase_order_attachment_revise' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_doc_operation on private.group_g_operations');

    // 同じ要求番号で後から作り直せる（失敗が受付を残していない）
    expect((await calls.reserve()).replayed).toBe(false);
    expect((await calls.attach()).replayed).toBe(false);
    expect((await calls.revise()).replayed).toBe(false);
  });

  test('FREQ-530-AC-01: 3本は在庫・台帳・割当・状態の履歴・注文・発注書（版も）・受取を一切動かさない', async () => {
    const s = await setup();
    const before = await snapshot();
    const first = await addDocument(s);
    await revise(first.attached.attachmentId, s.order.id, s.actor);
    await revise(first.attached.attachmentId, s.order.id, s.actor, { voided: true, reason: '無効', counterparty: '工場C' });
    await reserve(s.order.id, s.actor);
    const after = await snapshot();
    for (const key of ['order_state', 'order_revisions', 'movements', 'stock_by_variant', 'allocations'] as const) expect(after[key]).toEqual(before[key]);
    expect(after).toMatchObject({ reservations: before.reservations + 2, attachments: before.attachments + 1, revisions: before.revisions + 3, operations: before.operations + 5 });
  });

  // ---- 関数の形と ACL ----

  test('FREQ-540-AC-07: 3本の private 本体と検索は DEFINER・postgres・search_path 空で service_role だけが EXECUTE でき、public 入口は SQL の INVOKER 委譲（service_role のみ）', async () => {
    const read = async (signature: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
        l.lanname as language, p.proconfig as config, p.provolatile as volatility, p.proretset as set_returning,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute,
        p.proargnames as names
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [signature])).rows[0];
    const common = { owner: 'postgres', config: ['search_path=""'], service_role: true, anon: false, authenticated: false, public_can_execute: false };
    const names: Record<string, string[]> = {
      [RESERVE_SIGNATURE]: ['_purchase_order_id', '_kind', '_file_name', '_replaces_attachment_id', '_actor_id', '_request_key'],
      [ATTACH_SIGNATURE]: ['_reservation_id', '_purchase_order_id', '_mime_type', '_size_bytes', '_sha256', '_sha256_source', '_transaction_date', '_amount_yen', '_currency', '_counterparty', '_actor_id', '_request_key'],
      [REVISE_SIGNATURE]: ['_attachment_id', '_purchase_order_id', '_transaction_date', '_amount_yen', '_currency', '_counterparty', '_voided', '_reason', '_actor_id', '_request_key'],
    };
    for (const signature of WRITER_SIGNATURES) {
      expect(await read(`private.${signature}`)).toEqual({ ...common, definer: true, language: 'plpgsql', volatility: 'v', set_returning: false, names: names[signature] });
      expect(await read(`public.${signature}`)).toEqual({ ...common, definer: false, language: 'sql', volatility: 'v', set_returning: false, names: names[signature] });
    }
    const searchNames = ['_date_from', '_date_to', '_amount_min', '_amount_max', '_counterparty', '_purchase_order_number', '_kind', '_include_history', '_limit', '_offset', '_actor_id'];
    const privateSearch = await read(`private.${SEARCH_SIGNATURE}`);
    const publicSearch = await read(`public.${SEARCH_SIGNATURE}`);
    expect(privateSearch).toMatchObject({ ...common, definer: true, language: 'plpgsql', volatility: 's', set_returning: true });
    expect(publicSearch).toMatchObject({ ...common, definer: false, language: 'sql', volatility: 's', set_returning: true });
    expect((privateSearch.names as string[]).slice(0, 11)).toEqual(searchNames);
  });

  test('FREQ-540-AC-07: 書き手の一覧は G-3 の現在の本数（G-2 の65本 + 発送票の書き手）で、3本の private 本体を含み、public 入口と検索は含まない', async () => {
    const list = (await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows;
    expect(list).toHaveLength(G3C_ALLOWLIST.length);
    const oids = new Set(list.map((row) => row.oid));
    for (const signature of WRITER_SIGNATURES) {
      const privateOid = (await db().query('select $1::regprocedure::oid::text as oid', [`private.${signature}`])).rows[0].oid;
      const publicOid = (await db().query('select $1::regprocedure::oid::text as oid', [`public.${signature}`])).rows[0].oid;
      expect(oids.has(privateOid)).toBe(true);
      expect(oids.has(publicOid)).toBe(false);
    }
    for (const schema of ['private', 'public']) {
      const searchOid = (await db().query('select $1::regprocedure::oid::text as oid', [`${schema}.${SEARCH_SIGNATURE}`])).rows[0].oid;
      expect(oids.has(searchOid)).toBe(false);
    }
  });

  test('FREQ-540-AC-07: anon / authenticated は public 入口も private 本体も呼べず（42501）、service_role は public 入口から 予約・確定・訂正・検索を実行できる', async () => {
    const s = await setup();
    const reserved = await reserve(s.order.id, s.actor);
    const { attached } = await addDocument(s);
    const attempt = async (role: string, sql: string, params: unknown[]): Promise<{ rows?: Row[]; code?: string }> => {
      await db().query('savepoint role_attempt');
      try {
        await db().query(`set local role ${role}`);
        if (role === 'authenticated') await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: randomUUID(), role })]);
        const res = await db().query(sql, params);
        return { rows: res.rows as Row[] };
      } catch (caught) {
        return { code: (caught as { code?: string }).code ?? 'unknown' };
      } finally {
        await db().query('rollback to savepoint role_attempt');
        await db().query('release savepoint role_attempt');
      }
    };
    const calls = (schema: Schema): Array<[string, unknown[]]> => [
      [`select ${schema}.admin_reserve_purchase_order_attachment($1::uuid, $2::text, $3::text, $4::uuid, $5::uuid, $6::uuid) as r`, [s.order.id, 'invoice', 'a.pdf', null, s.actor, randomUUID()]],
      [`select ${schema}.admin_attach_purchase_order_document($1::uuid, $2::uuid, $3::text, $4::bigint, $5::text, $6::text, $7::date, $8::bigint, $9::text, $10::text, $11::uuid, $12::uuid) as r`,
        [reserved.reservationId, s.order.id, 'application/pdf', 100, SHA, 'browser', '2026-10-26', 100, 'JPY', '工場A', s.actor, randomUUID()]],
      [`select ${schema}.admin_revise_purchase_order_document($1::uuid, $2::uuid, $3::date, $4::bigint, $5::text, $6::text, $7::boolean, $8::text, $9::uuid, $10::uuid) as r`,
        [attached.attachmentId, s.order.id, '2026-10-27', 200, 'JPY', '工場B', false, '訂正', s.actor, randomUUID()]],
      [`select * from ${schema}.search_purchase_order_documents(null, null, null, null, null, $2::text, null, false, 10, 0, $1::uuid)`, [s.actor, s.order.number]],
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const schema of ['public', 'private'] as const) {
        for (const [sql, params] of calls(schema)) expect(await attempt(role, sql, params)).toEqual({ code: '42501' });
      }
    }
    const results = [];
    for (const [sql, params] of calls('public')) results.push(await attempt('service_role', sql, params));
    expect(results.map((result) => result.rows?.length ?? result.code)).toEqual([1, 1, 1, 1]);
    expect(results[1].rows?.[0]).toMatchObject({ r: { revisionNo: 1, replayed: false } });
    expect(results[2].rows?.[0]).toMatchObject({ r: { revisionNo: 2, replayed: false } });
  });

  // ---- 移行の最後の確かめ ----

  describe('移行の最後の確かめ', () => {
    const READS = finalAssertBlock(FOUNDATION_SQL, '$g2a_final_purchase_reads$');
    const OBJECTS = finalAssertBlock(WRITERS_SQL, '$g2b_final_objects$');
    const TABLE_ACL = finalAssertBlock(WRITERS_SQL, '$g2b_final_table_acl$');

    async function run(block: string) {
      await db().query('savepoint final_assert');
      try {
        await db().query(block);
        return null;
      } catch (error) {
        const e = error as { code: string; message: string; detail: string };
        return { code: e.code, message: e.message, detail: e.detail };
      } finally {
        await db().query('rollback to savepoint final_assert');
        await db().query('release savepoint final_assert');
      }
    }
    async function runAfter(block: string, sql: string) {
      await db().query('savepoint tamper');
      try {
        await db().query(sql);
        return await run(block);
      } finally {
        await db().query('rollback to savepoint tamper');
        await db().query('release savepoint tamper');
      }
    }
    const failed = (detail: string) => ({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });
    /** G2B の確かめは G-2 の65本を固定で持つ。流す前に、取引の中の書き手の一覧を G-2 の65本へ入れ替える（戻すのは savepoint への rollback） */
    async function runWithG2Allowlist(block: string) {
      await db().query('savepoint final_assert_g2');
      try {
        await runWithAllowlist(db(), G2_ALLOWLIST, block);
        return null;
      } catch (error) {
        const e = error as { code: string; message: string; detail: string };
        return { code: e.code, message: e.message, detail: e.detail };
      } finally {
        await db().query('rollback to savepoint final_assert_g2');
        await db().query('release savepoint final_assert_g2');
      }
    }

    test('FREQ-540-AC-07: 今の DB で 3つの確かめ（検索の関数・書き手の関数と65本・書く表の権限）が通る（書き手は一覧を G-2 の65本へ入れ替えてから）', async () => {
      expect(READS).not.toBe('');
      expect(OBJECTS).not.toBe('');
      expect(TABLE_ACL).not.toBe('');
      expect(await run(READS)).toBeNull();
      expect(await runWithG2Allowlist(OBJECTS)).toBeNull();
      expect(await run(TABLE_ACL)).toBeNull();
      // 今の DB の一覧（G-3 の書き手が加わった本数）のままでは、固定の65本の確かめは止まる
      expect(await run(OBJECTS)).toEqual(failed('purchase_writer_allowlist_missing'));
    });

    test.each([
      ['検索の公開入口を anon に開ける', `grant execute on function public.${SEARCH_SIGNATURE} to anon`],
      ['検索の private 本体を PUBLIC に開ける', `grant execute on function private.${SEARCH_SIGNATURE} to public`],
      ['検索の private 本体から service_role を外す', `revoke execute on function private.${SEARCH_SIGNATURE} from service_role`],
      ['検索の private 本体を VOLATILE にする', `alter function private.${SEARCH_SIGNATURE} volatile`],
      ['検索の公開入口を DEFINER にする', `alter function public.${SEARCH_SIGNATURE} security definer`],
      ['検索の公開入口の search_path を外す', `alter function public.${SEARCH_SIGNATURE} reset search_path`],
      ['検索の公開入口を落とす', `drop function public.${SEARCH_SIGNATURE}`],
    ])('FREQ-540-AC-07: 検索の確かめは崩れを拾う: %s', async (_name, sql) => {
      expect(await runAfter(READS, sql)).toEqual(failed('purchase_read_functions'));
    });

    test.each([
      ['予約の private 本体を anon に開ける', `grant execute on function private.${RESERVE_SIGNATURE} to anon`],
      ['確定の公開入口を authenticated に開ける', `grant execute on function public.${ATTACH_SIGNATURE} to authenticated`],
      ['訂正の公開入口を PUBLIC に開ける', `grant execute on function public.${REVISE_SIGNATURE} to public`],
      ['予約の公開入口から service_role を外す', `revoke execute on function public.${RESERVE_SIGNATURE} from service_role`],
      ['確定の公開入口を DEFINER にする', `alter function public.${ATTACH_SIGNATURE} security definer`],
      ['訂正の private 本体の search_path を変える', `alter function private.${REVISE_SIGNATURE} set search_path = public`],
      ['訂正の公開入口を落とす', `drop function public.${REVISE_SIGNATURE}`],
    ])('FREQ-540-AC-07: 書き手の確かめは崩れを拾う: %s', async (_name, sql) => {
      expect(await runAfter(OBJECTS, sql)).toEqual(failed('purchase_writer_functions'));
    });

    test('FREQ-540-AC-07: 書き手の一覧が65本から欠ける（原本の1本を外した一覧）と確かめが止まる', async () => {
      const without = `create or replace function private.group_g_writer_allowlist() returns pg_catalog.regprocedure[] language sql stable security definer set search_path = ''
        as $$ select array['private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)']::pg_catalog.regprocedure[] $$`;
      expect(await runAfter(OBJECTS, without)).toEqual(failed('purchase_writer_allowlist_missing'));
    });

    test('FREQ-540-AC-07: 版の表に service_role の権限が付くと、書く表の確かめが止まる', async () => {
      expect(await runAfter(TABLE_ACL, 'grant select on public.purchase_order_attachment_revisions to service_role')).toEqual(failed('purchase_writer_table_acl'));
    });
  });
});
