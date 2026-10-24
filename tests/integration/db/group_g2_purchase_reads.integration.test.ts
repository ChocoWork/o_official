/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, withLedgerLock } from './helpers/order-fixtures';

/**
 * G-2 Task 5（FREQ-526・FREQ-540-AC-07）: 発注一覧表と発注書の詳細の読取。
 * private.list_admin_purchase_order_lines（明細ごとの行・発注書番号の降順・line_no 順・total は全明細数）、
 * private.get_admin_purchase_order（camelCase の jsonb。保存先の鍵と内部の操作 ID は出さない）、
 * private.purchase_order_display_stages（表示段階を導く唯一の場所。誰も EXECUTE できない内部の helper）と、2つの公開入口。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 * 数量の確定・納品・打切りの関数は Task 6・7 で作るので、ここでは直接 INSERT / UPDATE の材料で段階を作る
 * （遅延の確かめは取引を終えないので発火しない）。操作経由の段階（部分受取・全受取・取消・打切り・打切りを戻した後）は、
 * Task 6 の試験と、この試験の「本物の操作でも導かれる」（Task 7）が確かめる。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const FOUNDATION_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_foundation.sql'));
const FOUNDATION_SQL = FOUNDATION_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, FOUNDATION_FILE[0]), 'utf8') : '';

const LIST = 'list_admin_purchase_order_lines(integer,integer,uuid)';
const DETAIL = 'get_admin_purchase_order(uuid,uuid)';
const HELPER = 'private.purchase_order_display_stages(uuid[])';
const FORBIDDEN = { code: '42501', message: 'GROUP_G_FORBIDDEN' };
const INVALID = { code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LIST_COLUMNS = [
  'total', 'purchase_order_id', 'number', 'display_stage', 'line_id', 'line_no', 'item_name', 'color_name', 'size_label',
  'provisional_quantity', 'order_quantity', 'received_quantity', 'outstanding_quantity',
];
const DETAIL_KEYS = [
  'attachments', 'createdBy', 'displayStage', 'estimatedAmountYen', 'flags', 'id', 'lines', 'memo', 'number', 'orderedAt',
  'pendingUploads', 'receipts', 'revisions', 'shortClosures', 'stage', 'supplierName', 'version',
];
const LINE_KEYS = [
  'colorName', 'id', 'itemName', 'lineNo', 'orderQuantity', 'outstandingQuantity', 'provisionalQuantity', 'receivedQuantity',
  'sizeLabel', 'unitPriceYen', 'variantId', 'version',
];
const REVISION_KEYS = [
  'actorId', 'afterMemo', 'afterQuantity', 'afterSupplierName', 'afterUnitPriceYen', 'beforeMemo', 'beforeQuantity',
  'beforeSupplierName', 'beforeUnitPriceYen', 'createdAt', 'id', 'kind', 'lineId', 'reason', 'revisionNo',
];
const SHORT_CLOSURE_KEYS = ['actorId', 'closedQuantity', 'createdAt', 'id', 'lineId', 'reason'];
const RECEIPT_KEYS = ['actorEmail', 'actorId', 'createdAt', 'id', 'kind', 'lines', 'memo', 'reason', 'receivedOn'];
const RECEIPT_LINE_KEYS = ['id', 'lineId', 'quantity', 'reversesReceiptLineId', 'reversibleQuantity'];
const ATTACHMENT_KEYS = ['createdAt', 'current', 'fileName', 'id', 'kind', 'mimeType', 'revisionCount', 'sha256', 'sha256Source', 'sizeBytes'];
const CURRENT_KEYS = ['amountYen', 'counterparty', 'currency', 'reason', 'replacesAttachmentId', 'revisionNo', 'transactionDate', 'voided'];
const PENDING_KEYS = ['createdAt', 'expired', 'expiresAt', 'fileName', 'kind', 'replacesAttachmentId', 'reservationId'];

type Row = Record<string, unknown>;
type DbFailure = { code?: string; message?: string; detail?: string };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sortedKeys = (value: unknown) => Object.keys(value as object).sort();

/** コメントの行を外した本文（コメント内の語を拾わないため） */
const withoutComments = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const CODE = withoutComments(FOUNDATION_SQL);

/** CREATE FUNCTION <name>( から、その ALTER FUNCTION までの本文 */
function functionText(createPrefix: string, alterPrefix: string): string {
  const start = CODE.indexOf(createPrefix);
  const end = CODE.indexOf(alterPrefix, start);
  return start >= 0 && end > start ? CODE.slice(start, end) : '';
}
const HELPER_TEXT = functionText('CREATE FUNCTION private.purchase_order_display_stages(', 'ALTER FUNCTION private.purchase_order_display_stages(');
const LIST_TEXT = functionText('CREATE FUNCTION private.list_admin_purchase_order_lines(', 'ALTER FUNCTION private.list_admin_purchase_order_lines(');
const DETAIL_TEXT = functionText('CREATE FUNCTION private.get_admin_purchase_order(', 'ALTER FUNCTION private.get_admin_purchase_order(');

/** 移行の最後の確かめ（G2A_FINAL_ASSERT の DO 文）を取り出す */
function finalAssertBlock(tag: string): string {
  const section = FOUNDATION_SQL.slice(FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_BEGIN'), FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_END'));
  const start = section.indexOf(`DO ${tag}`);
  const end = section.indexOf(`${tag};`, start + tag.length + 3);
  if (start < 0 || end < 0) throw new Error(`missing ${tag}`);
  return section.slice(start, end + tag.length + 1);
}

describe('G-2 foundation migration の発注書の読取の節（DB なし）', () => {
  test('FREQ-526-AC-04: 読取の3本は STABLE の SECURITY DEFINER（private）で、権限の確かめを最初に置き、何も書かず、鍵も取らない', () => {
    for (const text of [LIST_TEXT, DETAIL_TEXT]) {
      expect(text).not.toBe('');
      expect(text).toContain("LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''");
      const check = text.indexOf("private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.read'])");
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(text.indexOf('FROM public.'));
      expect(text.slice(check)).toContain("RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501'");
    }
    expect(HELPER_TEXT).toContain("LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''");
    for (const text of [HELPER_TEXT, LIST_TEXT, DETAIL_TEXT]) {
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/);
      expect(text).not.toMatch(/pg_advisory|FOR UPDATE|FOR SHARE|SKIP LOCKED/);
    }
  });

  test('FREQ-526-AC-04: 一覧は 1〜100 の limit と 0 以上の offset だけを受け、権限の確かめの後で 22023 にする。並びは発注書番号の降順（バイト順）と line_no', () => {
    expect(LIST_TEXT.indexOf('GROUP_G_FORBIDDEN')).toBeLessThan(LIST_TEXT.indexOf('GROUP_G_ARGUMENT_INVALID'));
    expect(LIST_TEXT).toContain('_limit IS NULL OR _limit NOT BETWEEN 1 AND 100 OR _offset IS NULL OR _offset < 0');
    expect(LIST_TEXT).toContain("RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023'");
    expect(LIST_TEXT).toContain('ORDER BY po.number COLLATE pg_catalog."C" DESC, l.line_no');
    expect(LIST_TEXT).toContain('LIMIT _limit OFFSET _offset');
    expect(LIST_TEXT).toContain('pg_catalog.count(*) OVER ()');
  });

  test('FREQ-526-AC-05: 詳細は保存先の鍵（storage_path）も内部の操作 ID（operation_id）も戻りに含めず、無い発注書は NULL', () => {
    expect(DETAIL_TEXT).not.toContain('storage_path');
    expect(DETAIL_TEXT).not.toContain('operation_id');
    expect(DETAIL_TEXT).not.toContain('uploaded_by');
    expect(DETAIL_TEXT).toContain('RETURN NULL;');
    // 受取の実行者はメールアドレスで返す(在庫の履歴と同じ。アカウントが無ければ NULL)。メールアドレスを返すのは受取だけ
    expect(DETAIL_TEXT).toContain("'actorEmail', (SELECT u.email::text FROM auth.users AS u WHERE u.id = rc.actor_id)");
    expect(DETAIL_TEXT.match(/auth\.users/g)).toHaveLength(1);
    expect(DETAIL_TEXT).toContain("'sha256', a.sha256");
    // 差し替えの関係は版1にしか保存されない（表の CHECK）ので、最新の版でなく版1から読む
    expect(DETAIL_TEXT).toContain("'replacesAttachmentId', (SELECT r1.replaces_attachment_id");
    expect(DETAIL_TEXT).toContain('WHERE r1.attachment_id = a.id AND r1.revision_no = 1');
    expect(DETAIL_TEXT).not.toContain('cr.replaces_attachment_id');
  });

  test('FREQ-526-AC-05: 表示段階を導くのはこの helper だけ（段階の名前は他の関数に書かない）。誰にも EXECUTE を付けない', () => {
    for (const stage of ["THEN 'ordered'", "THEN 'quantity_confirmed'", "THEN 'partially_received'", "THEN 'closed'", "ELSE 'received'"]) {
      expect(HELPER_TEXT).toContain(stage);
    }
    for (const text of [LIST_TEXT, DETAIL_TEXT]) {
      expect(text).not.toMatch(/'partially_received'|'received'|'closed'/);
    }
    expect(CODE.match(/'partially_received'/g)).toHaveLength(1);
    // 数量に関わる版: 打切り、または数量が実際に変わる quantity の版（単価だけの版は打切りを戻さない）
    expect(HELPER_TEXT).toContain("(r.kind = 'short_close' OR (r.kind = 'quantity' AND r.before_quantity IS DISTINCT FROM r.after_quantity))");
    expect(CODE).toContain('REVOKE ALL ON FUNCTION private.purchase_order_display_stages(uuid[]) FROM PUBLIC, anon, authenticated, service_role;');
    expect(CODE).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+private\.purchase_order_display_stages/i);
    expect(CODE).toContain('ALTER FUNCTION private.purchase_order_display_stages(uuid[]) OWNER TO postgres;');
  });

  test('FREQ-540-AC-07: 読取の private 本体と public 入口は service_role だけに EXECUTE を渡し、PUBLIC / anon / authenticated を個別に外す。public 入口は SQL の INVOKER 委譲', () => {
    for (const [name, signature] of [['list_admin_purchase_order_lines', 'integer, integer, uuid'], ['get_admin_purchase_order', 'uuid, uuid']]) {
      for (const schema of ['private', 'public']) {
        expect(CODE).toContain(`ALTER FUNCTION ${schema}.${name}(${signature}) OWNER TO postgres;`);
        expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${schema}.${name}(${signature}) FROM PUBLIC, anon, authenticated, service_role;`);
        expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION ${schema}.${name}(${signature}) TO service_role;`);
      }
    }
    const publicList = functionText('CREATE FUNCTION public.list_admin_purchase_order_lines(', 'ALTER FUNCTION public.list_admin_purchase_order_lines(');
    const publicDetail = functionText('CREATE FUNCTION public.get_admin_purchase_order(', 'ALTER FUNCTION public.get_admin_purchase_order(');
    for (const text of [publicList, publicDetail]) expect(text).toContain("LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''");
    expect(publicList).toContain('SELECT * FROM private.list_admin_purchase_order_lines(_limit, _offset, _actor_id);');
    expect(publicDetail).toContain('SELECT private.get_admin_purchase_order(_purchase_order_id, _actor_id);');
    expect(CODE).not.toMatch(/ON SCHEMA\s+private/i);
  });

  test('FREQ-540-AC-07: 最後の確かめに $g2a_final_purchase_reads$ を足し、他の確かめと同じ DETAIL の形で止める。既存の確かめは残る', () => {
    const block = finalAssertBlock('$g2a_final_purchase_reads$');
    expect(block).toContain("RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'purchase_read_functions'");
    for (const signature of [HELPER, `private.${LIST}`, `public.${LIST}`, `private.${DETAIL}`, `public.${DETAIL}`]) expect(block).toContain(signature);
    expect(block).toContain('COALESCE(p.proacl, pg_catalog.acldefault(\'f\', p.proowner))');
    const section = FOUNDATION_SQL.slice(FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_BEGIN'), FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_END'));
    for (const tag of ['$g2a_final_public_function_acl$', '$g2a_final_objects$', '$g2a_final_table_acl$', '$g2a_final_inventory_list$']) {
      expect(section).toContain(`DO ${tag}`);
    }
  });

  test('FREQ-526-AC-04: 移行は BEGIN / COMMIT を1組だけ持ち、通知を1回だけ出す（UTF-8・BOMなし・LF・ASCII のみ）', () => {
    expect(FOUNDATION_FILE).toHaveLength(1);
    expect(FOUNDATION_SQL.charCodeAt(0)).not.toBe(0xfeff);
    expect(FOUNDATION_SQL).not.toContain('\r');
    expect(FOUNDATION_SQL).toMatch(/^[\x00-\x7f]*$/);
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE.match(/NOTIFY pgrst, 'reload schema';/g)).toHaveLength(1);
  });
});

describeLocalDb('integration: G-2 発注一覧表と発注書の詳細の読取', (db) => {
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

  const lineOf = (variantId: number, quantity: number) => ({ variantId, quantity });

  async function create(actor: string, lines: Array<{ variantId: number; quantity: number }>, supplier = '工場A', memo: string | null = '春の追加分') {
    const result = await db().query('select public.admin_create_purchase_order($1, $2, $3::jsonb, $4, $5) as r',
      [supplier, memo, JSON.stringify(lines), actor, randomUUID()]);
    return result.rows[0].r as { id: string; number: string; version: number };
  }

  async function list(actor: string | null, limit: number | null, offset: number | null, schema: 'public' | 'private' = 'public'): Promise<Row[]> {
    return (await db().query(`select * from ${schema}.list_admin_purchase_order_lines($1::integer, $2::integer, $3::uuid)`, [limit, offset, actor])).rows;
  }

  type Detail = Record<string, any>;
  async function detailOf(actor: string | null, id: string | null, schema: 'public' | 'private' = 'public'): Promise<Detail | null> {
    return (await db().query(`select ${schema}.get_admin_purchase_order($1::uuid, $2::uuid) as r`, [id, actor])).rows[0].r as Detail | null;
  }

  async function lineRows(orderId: string): Promise<Array<{ id: string; line_no: number; variant_id: string }>> {
    return (await db().query('select id, line_no, variant_id from public.purchase_order_lines where purchase_order_id = $1 order by line_no', [orderId])).rows;
  }

  const lineCount = async () => Number((await db().query('select count(*) as n from public.purchase_order_lines')).rows[0].n);

  /** 数量確定の材料（Task 6 の関数が入るまでの直接 UPDATE。共通の押さえを持つ接続・版 +1） */
  async function confirm(orderId: string, quantities: number[], prices: Array<number | null> = []) {
    const lines = await lineRows(orderId);
    for (let index = 0; index < lines.length; index += 1) {
      await db().query('update public.purchase_order_lines set confirmed_quantity = $2, unit_price_yen = $3, version = version + 1 where id = $1',
        [lines[index].id, quantities[index], prices[index] ?? null]);
    }
    await db().query("update public.purchase_orders set stage = 'quantity_confirmed', version = version + 1 where id = $1", [orderId]);
  }

  async function setReceived(lineId: string, received: number) {
    await db().query('update public.purchase_order_lines set received_quantity = $2, version = version + 1 where id = $1', [lineId, received]);
  }

  async function setPrice(lineId: string, price: number | null) {
    await db().query('update public.purchase_order_lines set unit_price_yen = $2, version = version + 1 where id = $1', [lineId, price]);
  }

  async function operation(): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
       values ($1, 'g2_purchase_reads_test', gen_random_uuid(), $2, 'test', $3, '{}'::jsonb)`,
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

  /** 履歴の1行（版は更新後の発注書の版）。操作の受付は呼び手が渡す */
  const revision = (orderId: string, lineId: string | null, revisionNo: number, kind: string, operationId: string, values: Record<string, unknown> = {}) =>
    insertRow('purchase_order_revisions', {
      purchase_order_id: orderId, line_id: lineId, revision_no: revisionNo, kind, actor_id: randomUUID(), operation_id: operationId, ...values,
    });

  /** 台帳の1行（無タグ）。共通の押さえは書く間だけ持つ */
  async function movement(variantId: number, delta: number, reason: string): Promise<string> {
    const res = await withLedgerLock(db(), () => db().query(
      'insert into public.stock_movements (variant_id, delta, reason) values ($1, $2, $3) returning id', [variantId, delta, reason]));
    return String(res.rows[0].id);
  }

  async function reservation(orderId: string, operationId: string, values: Record<string, unknown> = {}) {
    return insertRow('purchase_order_attachment_reservations', {
      purchase_order_id: orderId, kind: 'quote', original_file_name: 'quote.pdf', storage_path: `${orderId}/${randomUUID()}.pdf`,
      created_by: randomUUID(), operation_id: operationId, expires_at: new Date(Date.now() + 3600_000).toISOString(), ...values,
    });
  }

  /** 予約 → 添付 → 版1 を作る。storage_path は予約と同じ値 */
  async function attach(orderId: string, operationId: string, values: { fileName?: string; kind?: string; revision?: Record<string, unknown>; attachment?: Record<string, unknown> } = {}) {
    const storagePath = `${orderId}/${randomUUID()}.pdf`;
    const reservationId = await reservation(orderId, operationId, { storage_path: storagePath, kind: values.kind ?? 'invoice', original_file_name: values.fileName ?? 'invoice.pdf' });
    const attachmentId = await insertRow('purchase_order_attachments', {
      purchase_order_id: orderId, reservation_id: reservationId, kind: values.kind ?? 'invoice', original_file_name: values.fileName ?? 'invoice.pdf',
      storage_path: storagePath, mime_type: 'application/pdf', size_bytes: 2048, sha256: 'a'.repeat(64), sha256_source: 'browser',
      uploaded_by: randomUUID(), operation_id: operationId, ...values.attachment,
    });
    await insertRow('purchase_order_attachment_revisions', {
      attachment_id: attachmentId, revision_no: 1, transaction_date: '2026-10-26', amount_yen: 6000, currency: 'JPY', counterparty: '工場A',
      actor_id: randomUUID(), operation_id: operationId, ...values.revision,
    });
    return { attachmentId, reservationId, storagePath };
  }

  /** 1つの商品に色なし・サイズ n 個の variant を作る */
  async function createManyVariants(count: number): Promise<number[]> {
    const itemId = Number((await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('fx-reads-' || gen_random_uuid()::text, '読取の試験', 5000, 'TOPS', 'https://example.com/item.png', 'published') returning id`)).rows[0].id);
    const ids: number[] = [];
    for (let position = 1; position <= count; position += 1) {
      const sizeId = Number((await db().query('insert into public.item_sizes (item_id, label, position) values ($1, $2, $3) returning id', [itemId, `S${position}`, position])).rows[0].id);
      ids.push(Number((await db().query('insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, null, $2, true) returning id', [itemId, sizeId])).rows[0].id));
    }
    return ids;
  }

  const twoVariants = async () => {
    const first = await createCatalogFixture(db(), { stock: 0 });
    const second = await createCatalogFixture(db(), { stock: 0 });
    return [first, second] as const;
  };

  // ---- FREQ-526-AC-04: 発注一覧表 ----

  test('FREQ-526-AC-04: 一覧は発注書番号の降順・同じ発注書内は line_no 順・20行頁で total が全行数、数量確定前の行の order_quantity と outstanding_quantity は NULL', async () => {
    const actor = await manager();
    const variants = await createManyVariants(25);
    const before = await lineCount();
    const first = await create(actor, variants.slice(0, 8).map((id) => lineOf(id, 1)));
    const second = await create(actor, variants.slice(8, 16).map((id) => lineOf(id, 2)));
    const third = await create(actor, variants.slice(16, 25).map((id) => lineOf(id, 3)));
    expect(first.number < second.number && second.number < third.number).toBe(true);
    const total = String(before + 25);

    const page1 = await list(actor, 20, 0);
    expect(page1).toHaveLength(20);
    expect(page1.every((row) => row.total === total)).toBe(true);
    expect(Object.keys(page1[0])).toEqual(LIST_COLUMNS);
    const expected = [
      ...Array.from({ length: 9 }, (_, index) => [third.number, index + 1]),
      ...Array.from({ length: 8 }, (_, index) => [second.number, index + 1]),
      ...Array.from({ length: 8 }, (_, index) => [first.number, index + 1]),
    ];
    expect(page1.map((row) => [row.number, row.line_no])).toEqual(expected.slice(0, 20));
    // 数量確定前の行: 発注数量と未納は NULL、仮数量は入力のまま、納品済みは0、表示段階は ordered
    expect(page1[0]).toMatchObject({
      purchase_order_id: third.id, display_stage: 'ordered', item_name: expect.stringMatching(/^fx-reads-/), color_name: null, size_label: 'S17',
      provisional_quantity: 3, order_quantity: null, received_quantity: 0, outstanding_quantity: null,
    });
    expect(page1[0].line_id).toEqual(expect.stringMatching(UUID_PATTERN));
    for (const row of page1.slice(0, 17)) expect(row).toMatchObject({ order_quantity: null, outstanding_quantity: null, display_stage: 'ordered' });

    const page2 = await list(actor, 20, 20);
    expect(page2.every((row) => row.total === total)).toBe(true);
    expect(page2.slice(0, 5).map((row) => [row.number, row.line_no])).toEqual(expected.slice(20, 25));
  });

  test('FREQ-526-AC-04: 数量確定後の行は発注数量・納品済み・未納（確定数量 − 納品済み）と導いた表示段階を返す。確定数量0の行は発注数量0・未納0', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    await confirm(order.id, [4, 0]);
    const [line1] = await lineRows(order.id);
    await setReceived(line1.id, 1);

    const rows = (await list(actor, 100, 0)).filter((row) => row.purchase_order_id === order.id);
    expect(rows.map((row) => [row.line_no, row.provisional_quantity, row.order_quantity, row.received_quantity, row.outstanding_quantity, row.display_stage])).toEqual([
      [1, 5, 4, 1, 3, 'partially_received'],
      [2, 3, 0, 0, 0, 'partially_received'],
    ]);
    expect(rows[0]).toMatchObject({ color_name: a.colorName, size_label: a.sizeLabel });
  });

  test('FREQ-526-AC-04: 同じ明細を2度出さず、色・サイズの無い variant は color_name / size_label が NULL', async () => {
    const actor = await manager();
    const variants = await createManyVariants(3);
    const order = await create(actor, variants.map((id) => lineOf(id, 1)));
    const rows = (await list(actor, 100, 0)).filter((row) => row.purchase_order_id === order.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.line_id)).size).toBe(3);
    expect(rows.every((row) => row.color_name === null)).toBe(true);
  });

  test('FREQ-526-AC-04: 範囲を越えた offset は行が無い（total を返す行も無い）', async () => {
    const actor = await manager();
    const variants = await createManyVariants(1);
    await create(actor, [lineOf(variants[0], 1)]);
    expect(await list(actor, 20, 1_000_000)).toEqual([]);
  });

  test.each([[0], [101], [-1], [null]])('FREQ-526-AC-04: limit が %s は GROUP_G_ARGUMENT_INVALID / 22023（公開入口も private 本体も）', async (limit) => {
    const actor = await manager();
    expect(await rejected(() => list(actor, limit, 0))).toEqual(INVALID);
    expect(await rejected(() => list(actor, limit, 0, 'private'))).toEqual(INVALID);
  });

  test.each([[-1], [null]])('FREQ-526-AC-04: offset が %s は GROUP_G_ARGUMENT_INVALID / 22023', async (offset) => {
    const actor = await manager();
    expect(await rejected(() => list(actor, 20, offset))).toEqual(INVALID);
  });

  test('FREQ-526-AC-04: limit の端 1 と 100 は通る。1行の頁でも total は全行数', async () => {
    const actor = await manager();
    const variants = await createManyVariants(2);
    await create(actor, variants.map((id) => lineOf(id, 1)));
    const one = await list(actor, 1, 0);
    expect(one).toHaveLength(1);
    expect(Number(one[0].total)).toBeGreaterThanOrEqual(2);
    expect((await list(actor, 100, 0)).length).toBeLessThanOrEqual(100);
  });

  test('FREQ-526-AC-04: 公開入口と private 本体は同じ行を返す', async () => {
    const actor = await manager();
    const variants = await createManyVariants(2);
    await create(actor, variants.map((id) => lineOf(id, 1)));
    expect(await list(actor, 20, 0, 'public')).toEqual(await list(actor, 20, 0, 'private'));
  });

  // ---- FREQ-526-AC-05: 発注書の詳細 ----

  test('FREQ-526-AC-05: 詳細のキーは決まった集合で、storage_path も内部の操作 ID も出さない。行は line_no 順、履歴は発注書全体の行 → 明細の行の順', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(b.variantId, 3), lineOf(a.variantId, 5)], '工場A', '春の追加分');

    const detail = await detailOf(actor, order.id) as Detail;
    expect(sortedKeys(detail)).toEqual(DETAIL_KEYS);
    expect(detail).toMatchObject({
      id: order.id, number: order.number, supplierName: '工場A', memo: '春の追加分', stage: 'ordered', displayStage: 'ordered',
      version: 1, createdBy: actor, estimatedAmountYen: null,
      flags: { unitPriceMissing: false, documentMissing: false },
      shortClosures: [], receipts: [], attachments: [], pendingUploads: [],
    });
    expect(Number.isNaN(Date.parse(detail.orderedAt))).toBe(false);

    expect(detail.lines.map((line: Detail) => [line.lineNo, line.variantId, line.provisionalQuantity])).toEqual([[1, b.variantId, 3], [2, a.variantId, 5]]);
    for (const line of detail.lines) {
      expect(sortedKeys(line)).toEqual(LINE_KEYS);
      expect(line).toMatchObject({ orderQuantity: null, receivedQuantity: 0, outstandingQuantity: null, unitPriceYen: null, version: 1 });
      expect(typeof line.variantId).toBe('number');
    }

    expect(detail.revisions).toHaveLength(3);
    expect(detail.revisions.map((row: Detail) => [row.revisionNo, row.kind, row.lineId === null ? null : row.lineId])).toEqual([
      [1, 'order', null], [1, 'order', detail.lines[0].id], [1, 'order', detail.lines[1].id],
    ]);
    for (const row of detail.revisions) expect(sortedKeys(row)).toEqual(REVISION_KEYS);
    expect(detail.revisions[0]).toMatchObject({ afterSupplierName: '工場A', afterMemo: '春の追加分', actorId: actor });
    expect(detail.revisions[1]).toMatchObject({ beforeQuantity: null, afterQuantity: 3 });

    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/storage|operation|uploaded/i);
  });

  test('FREQ-526-AC-05: 存在しない発注書は NULL（公開入口も private 本体も）。NULL の id も NULL', async () => {
    const actor = await manager();
    expect(await detailOf(actor, randomUUID())).toBeNull();
    expect(await detailOf(actor, randomUUID(), 'private')).toBeNull();
    expect(await detailOf(actor, null)).toBeNull();
  });

  test('FREQ-526-AC-05: 差し替えの関係は版1から返す: 版1だけの差し替えは元の id、版2・版3に直しても同じ元の id。差し替えでない添付は版が増えても null', async () => {
    const actor = await manager();
    const [a] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5)]);
    const operationId = await operation();
    const original = await attach(order.id, operationId, { fileName: 'original.pdf' });
    const replacement = await attach(order.id, operationId, { fileName: 'replacement.pdf', revision: { replaces_attachment_id: original.attachmentId } });
    const link = async () => {
      const detail = await detailOf(actor, order.id) as Detail;
      const byName = (name: string) => detail.attachments.find((row: Detail) => row.fileName === name);
      return { original: byName('original.pdf').current.replacesAttachmentId, replacement: byName('replacement.pdf').current.replacesAttachmentId, count: byName('replacement.pdf').revisionCount };
    };
    expect(await link()).toEqual({ original: null, replacement: original.attachmentId, count: 1 });
    for (const revisionNo of [2, 3]) {
      await insertRow('purchase_order_attachment_revisions', {
        attachment_id: replacement.attachmentId, revision_no: revisionNo, transaction_date: '2026-10-27', amount_yen: 6000 + revisionNo, currency: 'JPY',
        counterparty: '工場A', reason: `訂正${revisionNo}`, actor_id: randomUUID(), operation_id: operationId,
      });
      await insertRow('purchase_order_attachment_revisions', {
        attachment_id: original.attachmentId, revision_no: revisionNo, transaction_date: '2026-10-27', amount_yen: 7000 + revisionNo, currency: 'JPY',
        counterparty: '工場A', reason: `訂正${revisionNo}`, actor_id: randomUUID(), operation_id: operationId,
      });
    }
    expect(await link()).toEqual({ original: null, replacement: original.attachmentId, count: 3 });
  });

  test('FREQ-526-AC-05: 公開入口と private 本体は同じ詳細を返す', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    expect(await detailOf(actor, order.id, 'public')).toEqual(await detailOf(actor, order.id, 'private'));
  });

  test('FREQ-526-AC-05: 読むだけ。一覧も詳細も発注・在庫・台帳・操作の行数を変えない', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    const snapshot = async () => (await db().query(`select
      (select count(*) from public.purchase_orders)::int as orders, (select count(*) from public.purchase_order_lines)::int as lines,
      (select count(*) from public.purchase_order_revisions)::int as revisions, (select count(*) from public.purchase_order_receipts)::int as receipts,
      (select count(*) from public.purchase_order_attachments)::int as attachments,
      (select count(*) from public.purchase_order_attachment_reservations)::int as reservations,
      (select count(*) from private.group_g_operations)::int as operations, (select count(*) from public.stock_movements)::int as movements,
      (select count(*) from public.item_variants)::int as variants,
      (select md5(coalesce(string_agg(id::text || ':' || stock_quantity::text, ',' order by id), '')) from public.item_variants) as stock`)).rows[0];
    const before = await snapshot();
    await list(actor, 20, 0);
    await detailOf(actor, order.id);
    expect(await snapshot()).toEqual(before);
  });

  // ---- 表示段階（導出は helper の1か所） ----

  type Scenario = {
    name: string;
    confirmed?: [number, number];
    received?: [number, number];
    /** before / after は履歴の数量。省くと打切りは 5 → 2、quantity の版は 2 → 5（打切りの後の再確定で数量を戻す形） */
    revisions?: Array<{ line: 0 | 1; no: number; kind: 'quantity' | 'short_close'; before?: number | null; after?: number | null }>;
    expected: { stage: string; received: number; outstanding: number; active: boolean };
  };
  const SCENARIOS: Scenario[] = [
    { name: '数量確定前（ordered）は ordered', expected: { stage: 'ordered', received: 0, outstanding: 0, active: false } },
    { name: '確定済みで納品が無く未納がある → quantity_confirmed', confirmed: [5, 3], received: [0, 0], expected: { stage: 'quantity_confirmed', received: 0, outstanding: 8, active: false } },
    { name: '納品が1つ以上あり未納が残る → partially_received', confirmed: [5, 3], received: [2, 0], expected: { stage: 'partially_received', received: 2, outstanding: 6, active: false } },
    { name: '全行の未納が0で納品があり打切りが無い → received', confirmed: [5, 3], received: [5, 3], expected: { stage: 'received', received: 8, outstanding: 0, active: false } },
    { name: '全行の未納が0で、ある行の最新の数量の版が打切り → closed', confirmed: [2, 3], received: [2, 3], revisions: [{ line: 0, no: 3, kind: 'short_close' }], expected: { stage: 'closed', received: 5, outstanding: 0, active: true } },
    { name: '打切りを再確定（数量が実際に変わる、より新しい quantity の版 2 → 5）で戻し、全て受け取った → received（打切りは有効でない）', confirmed: [5, 3], received: [5, 3], revisions: [{ line: 0, no: 3, kind: 'short_close' }, { line: 0, no: 4, kind: 'quantity' }], expected: { stage: 'received', received: 8, outstanding: 0, active: false } },
    { name: '版の番号が大きい quantity の版を先に入れても、行ごとの最新（版の番号の最大）で決める → received', confirmed: [5, 3], received: [5, 3], revisions: [{ line: 0, no: 5, kind: 'quantity' }, { line: 0, no: 3, kind: 'short_close' }], expected: { stage: 'received', received: 8, outstanding: 0, active: false } },
    { name: '打切りの後に別の行の quantity の版があっても、打切りの行の最新は打切りのまま → closed', confirmed: [2, 3], received: [2, 3], revisions: [{ line: 0, no: 3, kind: 'short_close' }, { line: 1, no: 4, kind: 'quantity' }], expected: { stage: 'closed', received: 5, outstanding: 0, active: true } },
    { name: '全行の確定数量が0（納品0）で打切りの版が無くても → closed', confirmed: [0, 0], received: [0, 0], expected: { stage: 'closed', received: 0, outstanding: 0, active: false } },
    { name: '全行の確定数量が0で全行が打切り → closed（打切りは有効）', confirmed: [0, 0], received: [0, 0], revisions: [{ line: 0, no: 2, kind: 'short_close' }, { line: 1, no: 2, kind: 'short_close' }], expected: { stage: 'closed', received: 0, outstanding: 0, active: true } },
    { name: '1行は全部受け取り、もう1行は打切り → closed', confirmed: [5, 2], received: [5, 2], revisions: [{ line: 1, no: 3, kind: 'short_close' }], expected: { stage: 'closed', received: 7, outstanding: 0, active: true } },
    { name: '打切りの行があっても別の行に未納が残る間は未納側の段階（納品あり → partially_received）で、打切りの有無は別に返す', confirmed: [2, 3], received: [2, 0], revisions: [{ line: 0, no: 3, kind: 'short_close' }], expected: { stage: 'partially_received', received: 2, outstanding: 3, active: true } },
    { name: '打切りの後に、単価だけを直した quantity の版（数量は 2 → 2 のまま）を足しても打切りは有効のまま → closed（受け取り完了に変わらない）', confirmed: [2, 3], received: [2, 3], revisions: [{ line: 0, no: 3, kind: 'short_close' }, { line: 0, no: 4, kind: 'quantity', before: 2, after: 2 }], expected: { stage: 'closed', received: 5, outstanding: 0, active: true } },
    { name: '打切りの後に、数量が NULL のままの quantity の版を足しても打切りは有効のまま → closed', confirmed: [2, 3], received: [2, 3], revisions: [{ line: 0, no: 3, kind: 'short_close' }, { line: 0, no: 4, kind: 'quantity', before: null, after: null }], expected: { stage: 'closed', received: 5, outstanding: 0, active: true } },
    { name: '打切りの後、単価だけの版（2 → 2）の後に数量が実際に変わる版（2 → 5）→ 最新の数量の変更が再確定なので received', confirmed: [5, 3], received: [5, 3], revisions: [{ line: 0, no: 3, kind: 'short_close' }, { line: 0, no: 4, kind: 'quantity', before: 2, after: 2 }, { line: 0, no: 5, kind: 'quantity', before: 2, after: 5 }], expected: { stage: 'received', received: 8, outstanding: 0, active: false } },
    { name: '打切りの後に数量が実際に変わる版（2 → 5）を足し、その後に単価だけの版（5 → 5）を足しても、再確定は戻らない → received', confirmed: [5, 3], received: [5, 3], revisions: [{ line: 0, no: 3, kind: 'short_close' }, { line: 0, no: 4, kind: 'quantity', before: 2, after: 5 }, { line: 0, no: 5, kind: 'quantity', before: 5, after: 5 }], expected: { stage: 'received', received: 8, outstanding: 0, active: false } },
    { name: '打切りの無い発注書に単価だけの quantity の版（5 → 5）があっても、段階は変わらない → received', confirmed: [5, 3], received: [5, 3], revisions: [{ line: 0, no: 2, kind: 'quantity', before: 5, after: 5 }], expected: { stage: 'received', received: 8, outstanding: 0, active: false } },
  ];

  test.each(SCENARIOS)('FREQ-526-AC-05: 表示段階: $name', async (scenario) => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    const lines = await lineRows(order.id);
    if (scenario.confirmed) {
      await confirm(order.id, scenario.confirmed);
      for (let index = 0; index < 2; index += 1) await setReceived(lines[index].id, scenario.received?.[index] ?? 0);
    }
    const operationId = await operation();
    for (const row of scenario.revisions ?? []) {
      const defaults = row.kind === 'short_close' ? { before: 5, after: 2 } : { before: 2, after: 5 };
      await revision(order.id, lines[row.line].id, row.no, row.kind, operationId, {
        before_quantity: row.before === undefined ? defaults.before : row.before,
        after_quantity: row.after === undefined ? defaults.after : row.after,
      });
    }

    const helper = (await db().query('select * from private.purchase_order_display_stages($1::uuid[])', [[order.id]])).rows;
    expect(helper).toEqual([{
      purchase_order_id: order.id, display_stage: scenario.expected.stage, total_received: String(scenario.expected.received),
      total_outstanding: String(scenario.expected.outstanding), has_active_short_close: scenario.expected.active,
    }]);
    // 詳細と一覧は同じ段階を返す（導出は helper の1か所）
    expect((await detailOf(actor, order.id) as Detail).displayStage).toBe(scenario.expected.stage);
    const rows = (await list(actor, 100, 0)).filter((row) => row.purchase_order_id === order.id);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((row) => row.display_stage))).toEqual(new Set([scenario.expected.stage]));
  });

  test('FREQ-526-AC-05: 表示段階は本物の操作でも導かれる: 確定 → 一部受け取り済み → 受け取り完了 → 取消で一部受け取り済みへ戻り → 再び受け取り完了、打切りで closed、打切りを数量の再確定で戻して受け取ると 受け取り完了(Task 7)', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const flushAll = async () => {
      await db().query('set constraints all immediate');
      await db().query('set constraints all deferred');
    };
    const call = async (sql: string, params: unknown[]) => {
      const result = (await db().query(sql, params)).rows[0].r as Detail;
      await flushAll();
      return result;
    };
    const today = (await db().query("select (now() at time zone 'Asia/Tokyo')::date::text as d")).rows[0].d as string;
    const confirmSql = 'select public.admin_confirm_purchase_order_quantities($1::uuid, $2::integer, $3::jsonb, $4::text, $5::uuid, $6::uuid) as r';
    const receiveSql = 'select public.admin_receive_purchase_order($1::uuid, $2::integer, $3::date, null, $4::jsonb, $5::uuid, $6::uuid) as r';
    const reverseSql = "select public.admin_reverse_purchase_order_receipt($1::uuid, $2::integer, $3::uuid, $4::jsonb, '数え間違い', null, $5::uuid, $6::uuid) as r";
    const closeSql = "select public.admin_short_close_purchase_order($1::uuid, $2::integer, $3::uuid[], '打切り', $4::uuid, $5::uuid) as r";
    const stageOf = async (id: string) => (await detailOf(actor, id) as Detail).displayStage as string;
    const confirmBody = (lines: Array<{ id: string }>, quantities: number[]) => JSON.stringify(lines.map((line, index) => ({ lineId: line.id, quantity: quantities[index], unitPriceYen: null })));
    const receiptLineOf = async (id: string, receiptId: string, lineId: string) => {
      const detail = await detailOf(actor, id) as Detail;
      return detail.receipts.find((receipt: Detail) => receipt.id === receiptId).lines.find((line: Detail) => line.lineId === lineId).id as string;
    };

    // 受け取りまで: ordered → quantity_confirmed → partially_received → received → (取消) partially_received → received
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    const lines = await lineRows(order.id);
    expect(await stageOf(order.id)).toBe('ordered');
    const confirmed = await call(confirmSql, [order.id, 1, confirmBody(lines, [5, 3]), null, actor, randomUUID()]);
    expect(await stageOf(order.id)).toBe('quantity_confirmed');
    const first = await call(receiveSql, [order.id, confirmed.version, today, JSON.stringify([{ lineId: lines[0].id, quantity: 2 }]), actor, randomUUID()]);
    expect(await stageOf(order.id)).toBe('partially_received');
    const second = await call(receiveSql, [order.id, first.version, today, JSON.stringify([{ lineId: lines[0].id, quantity: 3 }, { lineId: lines[1].id, quantity: 3 }]), actor, randomUUID()]);
    expect(await stageOf(order.id)).toBe('received');
    const reversed = await call(reverseSql, [
      order.id, second.version, second.receiptId, JSON.stringify([{ receiptLineId: await receiptLineOf(order.id, second.receiptId, lines[0].id), quantity: 1 }]), actor, randomUUID()]);
    expect(await stageOf(order.id)).toBe('partially_received');
    await call(receiveSql, [order.id, reversed.version, today, JSON.stringify([{ lineId: lines[0].id, quantity: 1 }]), actor, randomUUID()]);
    expect(await stageOf(order.id)).toBe('received');

    // 打切り: 一部受け取り済み → 打切りで closed → 数量の再確定で戻して受け取ると received(打切りは有効でない)
    const other = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    const otherLines = await lineRows(other.id);
    const otherConfirmed = await call(confirmSql, [other.id, 1, confirmBody(otherLines, [5, 3]), null, actor, randomUUID()]);
    const otherReceived = await call(receiveSql, [other.id, otherConfirmed.version, today, JSON.stringify([{ lineId: otherLines[0].id, quantity: 2 }, { lineId: otherLines[1].id, quantity: 3 }]), actor, randomUUID()]);
    expect(await stageOf(other.id)).toBe('partially_received');
    const closed = await call(closeSql, [other.id, otherReceived.version, [otherLines[0].id], actor, randomUUID()]);
    expect(await stageOf(other.id)).toBe('closed');
    const reopened = await call(confirmSql, [other.id, closed.version, confirmBody(otherLines, [5, 3]), '再確定', actor, randomUUID()]);
    expect(await stageOf(other.id)).toBe('partially_received');
    await call(receiveSql, [other.id, reopened.version, today, JSON.stringify([{ lineId: otherLines[0].id, quantity: 3 }]), actor, randomUUID()]);
    expect(await stageOf(other.id)).toBe('received');
    // 一覧も同じ段階を返す
    const rows = (await list(actor, 100, 0)).filter((row) => row.purchase_order_id === other.id);
    expect(new Set(rows.map((row) => row.display_stage))).toEqual(new Set(['received']));
  });

  test('FREQ-526-AC-05: helper は渡した複数の発注書をまとめて導き、渡していない発注書は返さない。NULL・空の配列は行なし', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const one = await create(actor, [lineOf(a.variantId, 5)]);
    const two = await create(actor, [lineOf(b.variantId, 3)]);
    const three = await create(actor, [lineOf(a.variantId, 1)]);
    await confirm(two.id, [3]);
    const rows = (await db().query('select purchase_order_id, display_stage from private.purchase_order_display_stages($1::uuid[]) order by purchase_order_id', [[one.id, two.id]])).rows;
    const expected = [{ purchase_order_id: one.id, display_stage: 'ordered' }, { purchase_order_id: two.id, display_stage: 'quantity_confirmed' }]
      .sort((x, y) => (x.purchase_order_id < y.purchase_order_id ? -1 : 1));
    expect(rows).toEqual(expected);
    expect(rows.some((row) => row.purchase_order_id === three.id)).toBe(false);
    expect((await db().query('select * from private.purchase_order_display_stages($1::uuid[])', [null])).rows).toEqual([]);
    expect((await db().query('select * from private.purchase_order_display_stages(array[]::uuid[])')).rows).toEqual([]);
  });

  // ---- 保存途中の予約・旗・見込額 ----

  test('FREQ-526-AC-05: pendingUploads は添付に結ばれていない予約だけで、期限を過ぎた物は expired が真。作成の順に並び、保存先の鍵は出さない', async () => {
    const actor = await manager();
    const [a] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5)]);
    const operationId = await operation();
    const open = await reservation(order.id, operationId, { kind: 'quote', original_file_name: 'a.pdf', created_at: new Date(Date.now() - 7200_000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const expired = await reservation(order.id, operationId, { kind: 'invoice', original_file_name: 'b.pdf', created_at: new Date(Date.now() - 3600_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString() });
    await attach(order.id, operationId, { fileName: 'bound.pdf' });

    const detail = await detailOf(actor, order.id) as Detail;
    expect(detail.pendingUploads.map((row: Detail) => [row.reservationId, row.kind, row.fileName, row.expired])).toEqual([
      [open, 'quote', 'a.pdf', false], [expired, 'invoice', 'b.pdf', true],
    ]);
    for (const row of detail.pendingUploads) {
      expect(sortedKeys(row)).toEqual(PENDING_KEYS);
      expect(row.replacesAttachmentId).toBeNull();
      expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(row.expiresAt))).toBe(false);
    }
    expect(detail.attachments).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain(order.id + '/');
  });

  test('FREQ-530-AC-03: 差し替えの予約は、差し替える添付の id を pendingUploads の replacesAttachmentId に出す（保存が止まって頁を読み直しても、続きから保存が差し替えとして続けられる）', async () => {
    const actor = await manager();
    const [a] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5)]);
    const operationId = await operation();
    const original = await attach(order.id, operationId, { fileName: 'original.pdf' });
    const replacing = await reservation(order.id, operationId, { kind: 'invoice', original_file_name: 'new.pdf', replaces_attachment_id: original.attachmentId });
    const plain = await reservation(order.id, operationId, { kind: 'quote', original_file_name: 'plain.pdf' });

    const detail = await detailOf(actor, order.id) as Detail;
    const byId = new Map<string, Detail>(detail.pendingUploads.map((row: Detail) => [row.reservationId, row]));
    expect(byId.get(replacing)!.replacesAttachmentId).toBe(original.attachmentId);
    expect(byId.get(plain)!.replacesAttachmentId).toBeNull();
    for (const row of detail.pendingUploads) expect(sortedKeys(row)).toEqual(PENDING_KEYS);
  });

  test('FREQ-526-AC-05: 数量確定前（ordered）は 単価未登録・証憑未添付 の旗も見込額も立たない（数量確定後だけ）', async () => {
    const actor = await manager();
    const [a] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5)]);
    const operationId = await operation();
    // 単価と書類の材料を入れても、stage が ordered の間は旗の対象にならない
    await setPrice((await lineRows(order.id))[0].id, 1200);
    const detail = await detailOf(actor, order.id) as Detail;
    expect(detail.stage).toBe('ordered');
    expect(detail.flags).toEqual({ unitPriceMissing: false, documentMissing: false });
    expect(detail.estimatedAmountYen).toBeNull();
    await attach(order.id, operationId);
    expect((await detailOf(actor, order.id) as Detail).flags).toEqual({ unitPriceMissing: false, documentMissing: false });
  });

  test('FREQ-526-AC-05: unitPriceMissing は確定後に単価 NULL の行がある時、estimatedAmountYen は単価と確定数量がある行の積の合計（0円も単価。全行が未登録なら NULL）', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    await confirm(order.id, [5, 3]);
    const [line1, line2] = await lineRows(order.id);

    let detail = await detailOf(actor, order.id) as Detail;
    expect(detail.flags.unitPriceMissing).toBe(true);
    expect(detail.estimatedAmountYen).toBeNull();

    await setPrice(line2.id, 0);
    detail = await detailOf(actor, order.id) as Detail;
    expect(detail.flags.unitPriceMissing).toBe(true);
    expect(detail.estimatedAmountYen).toBe(0);

    await setPrice(line1.id, 1200);
    detail = await detailOf(actor, order.id) as Detail;
    expect(detail.flags.unitPriceMissing).toBe(false);
    expect(detail.estimatedAmountYen).toBe(6000);
    expect(detail.lines.map((line: Detail) => line.unitPriceYen)).toEqual([1200, 0]);

    await setPrice(line2.id, 100);
    expect((await detailOf(actor, order.id) as Detail).estimatedAmountYen).toBe(6000 + 300);
  });

  test('FREQ-526-AC-05: 確定数量0の行は見込額に0円で入り、単価が NULL ならその行は見込額に入らない', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    await confirm(order.id, [4, 0], [1000, null]);
    const detail = await detailOf(actor, order.id) as Detail;
    expect(detail.estimatedAmountYen).toBe(4000);
    expect(detail.flags.unitPriceMissing).toBe(true);
  });

  test('FREQ-526-AC-05: documentMissing は確定後に無効でない添付が無い時。最新の版が無効の書類だけなら真、有効な書類が1件でもあれば偽', async () => {
    const actor = await manager();
    const [a] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5)]);
    await confirm(order.id, [5], [1200]);
    const operationId = await operation();
    expect(((await detailOf(actor, order.id)) as Detail).flags.documentMissing).toBe(true);

    const first = await attach(order.id, operationId);
    expect(((await detailOf(actor, order.id)) as Detail).flags.documentMissing).toBe(false);

    // 版2で無効にすると、最新の版が無効なので書類が無いのと同じ
    await insertRow('purchase_order_attachment_revisions', {
      attachment_id: first.attachmentId, revision_no: 2, transaction_date: '2026-10-26', amount_yen: 6000, currency: 'JPY', counterparty: '工場A',
      voided: true, reason: '誤り', actor_id: randomUUID(), operation_id: operationId,
    });
    expect(((await detailOf(actor, order.id)) as Detail).flags.documentMissing).toBe(true);

    await attach(order.id, operationId, { fileName: 'second.pdf' });
    expect(((await detailOf(actor, order.id)) as Detail).flags.documentMissing).toBe(false);
  });

  // ---- 書類・受け取り・履歴の形 ----

  test('FREQ-526-AC-05: attachments は 種類・ファイル名・種類・大きさ・sha256 と、最新の版（current）と版の数を返し、保存先の鍵は出さない', async () => {
    const actor = await manager();
    const [a] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5)]);
    await confirm(order.id, [5], [1200]);
    const operationId = await operation();
    const original = await attach(order.id, operationId, { kind: 'invoice', fileName: 'invoice.pdf' });
    await insertRow('purchase_order_attachment_revisions', {
      attachment_id: original.attachmentId, revision_no: 2, transaction_date: '2026-10-27', amount_yen: 6600, currency: 'JPY', counterparty: '工場B',
      reason: '金額の訂正', actor_id: randomUUID(), operation_id: operationId,
    });
    const replacement = await attach(order.id, operationId, { kind: 'quote', fileName: 'quote.pdf', revision: { replaces_attachment_id: original.attachmentId } });
    // 差し替えの添付の取引情報を1度直す（版2）。差し替えの関係は版1にしか保存されない（表の CHECK）が、読取は版1から返す
    await insertRow('purchase_order_attachment_revisions', {
      attachment_id: replacement.attachmentId, revision_no: 2, transaction_date: '2026-10-28', amount_yen: 6300, currency: 'JPY', counterparty: '工場C',
      reason: '取引先の訂正', actor_id: randomUUID(), operation_id: operationId,
    });

    const detail = await detailOf(actor, order.id) as Detail;
    expect(detail.attachments).toHaveLength(2);
    for (const row of detail.attachments) {
      expect(sortedKeys(row)).toEqual(ATTACHMENT_KEYS);
      expect(sortedKeys(row.current)).toEqual(CURRENT_KEYS);
      expect(row.sha256).toBe('a'.repeat(64));
      expect(row.sha256Source).toBe('browser');
      expect(row.mimeType).toBe('application/pdf');
      expect(row.sizeBytes).toBe(2048);
    }
    const first = detail.attachments.find((row: Detail) => row.id === original.attachmentId);
    expect(first).toMatchObject({
      kind: 'invoice', fileName: 'invoice.pdf', revisionCount: 2,
      current: { revisionNo: 2, transactionDate: '2026-10-27', amountYen: 6600, currency: 'JPY', counterparty: '工場B', voided: false, reason: '金額の訂正', replacesAttachmentId: null },
    });
    const second = detail.attachments.find((row: Detail) => row.id === replacement.attachmentId);
    // 差し替えの添付は版2に直した後も、差し替え元への関係（版1にだけ保存される）を失わない。他の項目は最新の版（版2）の物
    expect(second).toMatchObject({
      kind: 'quote', fileName: 'quote.pdf', revisionCount: 2,
      current: { revisionNo: 2, transactionDate: '2026-10-28', amountYen: 6300, counterparty: '工場C', voided: false, reason: '取引先の訂正', replacesAttachmentId: original.attachmentId },
    });
    const text = JSON.stringify(detail);
    expect(text).not.toContain(original.storagePath);
    expect(text).not.toContain(replacement.storagePath);
  });

  test('FREQ-526-AC-05: receipts は受け取りの順に、受取行（数量は相殺で負）と取り消せる数（正の行の数量 − その行への相殺の合計。相殺の行は0）を返す', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    await confirm(order.id, [5, 3]);
    const [line1, line2] = await lineRows(order.id);
    const operationId = await operation();
    // 実行者は、メールアドレスを持つ利用者(受け取り)と、アカウントの無い id(相殺)の2通り
    const receiver = randomUUID();
    const receiverEmail = `receiver-${receiver}@example.com`;
    await db().query("insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,$2,'{}','{}')", [receiver, receiverEmail]);
    const receive = await insertRow('purchase_order_receipts', {
      purchase_order_id: order.id, kind: 'receive', received_on: '2026-10-26', memo: '午前便', actor_id: receiver, operation_id: operationId,
      created_at: new Date(Date.now() - 7200_000).toISOString(),
    });
    const receivedA = await insertRow('purchase_order_receipt_lines', { receipt_id: receive, line_id: line1.id, quantity: 5, stock_movement_id: await movement(a.variantId, 5, 'restock') });
    const receivedB = await insertRow('purchase_order_receipt_lines', { receipt_id: receive, line_id: line2.id, quantity: 3, stock_movement_id: await movement(b.variantId, 3, 'restock') });
    const reverse = await insertRow('purchase_order_receipts', {
      purchase_order_id: order.id, kind: 'reverse', received_on: '2026-10-27', reason: '数え間違い', actor_id: randomUUID(), operation_id: operationId,
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    const offset = await insertRow('purchase_order_receipt_lines', {
      receipt_id: reverse, line_id: line1.id, quantity: -2, reverses_receipt_line_id: receivedA, stock_movement_id: await movement(a.variantId, -2, 'adjustment'),
    });
    await setReceived(line1.id, 3);
    await setReceived(line2.id, 3);

    const detail = await detailOf(actor, order.id) as Detail;
    expect(detail.receipts).toHaveLength(2);
    for (const receipt of detail.receipts) {
      expect(sortedKeys(receipt)).toEqual(RECEIPT_KEYS);
      for (const row of receipt.lines) expect(sortedKeys(row)).toEqual(RECEIPT_LINE_KEYS);
    }
    expect(detail.receipts[0]).toMatchObject({ id: receive, kind: 'receive', receivedOn: '2026-10-26', memo: '午前便', reason: null, actorId: receiver, actorEmail: receiverEmail });
    expect(detail.receipts[0].lines.map((row: Detail) => [row.id, row.lineId, row.quantity, row.reversesReceiptLineId, row.reversibleQuantity])).toEqual([
      [receivedA, line1.id, 5, null, 3], [receivedB, line2.id, 3, null, 3],
    ]);
    // 実行者のアカウントが無ければメールアドレスは null(受取の行は消えない)
    expect(detail.receipts[1]).toMatchObject({ id: reverse, kind: 'reverse', receivedOn: '2026-10-27', memo: null, reason: '数え間違い', actorEmail: null });
    expect(detail.receipts[1].lines.map((row: Detail) => [row.id, row.lineId, row.quantity, row.reversesReceiptLineId, row.reversibleQuantity])).toEqual([
      [offset, line1.id, -2, receivedA, 0],
    ]);
    expect(detail.lines.map((line: Detail) => [line.receivedQuantity, line.outstandingQuantity])).toEqual([[3, 2], [3, 0]]);
    expect(detail.displayStage).toBe('partially_received');
  });

  test('FREQ-526-AC-05: revisions は版の順（同じ版は発注書全体の行 → 明細の行の line_no 順 → 種類）、shortClosures は打切りの記録を返す', async () => {
    const actor = await manager();
    const [a, b] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5), lineOf(b.variantId, 3)]);
    await confirm(order.id, [5, 3]);
    const [line1, line2] = await lineRows(order.id);
    const operationId = await operation();
    // 逆の順で入れても、版 → line_no の順で返る
    await revision(order.id, line2.id, 2, 'quantity', operationId, { before_quantity: 3, after_quantity: 3, reason: '確定' });
    await revision(order.id, line1.id, 2, 'quantity', operationId, { before_quantity: 5, after_quantity: 5, reason: '確定' });
    const closeRevision = await revision(order.id, line1.id, 3, 'short_close', operationId, { before_quantity: 5, after_quantity: 2, reason: '生産できない' });
    const closure = await insertRow('purchase_order_short_closures', { line_id: line1.id, revision_id: closeRevision, closed_quantity: 3, reason: '生産できない', actor_id: randomUUID() });

    const detail = await detailOf(actor, order.id) as Detail;
    expect(detail.revisions.map((row: Detail) => [row.revisionNo, row.kind, row.lineId])).toEqual([
      [1, 'order', null], [1, 'order', line1.id], [1, 'order', line2.id],
      [2, 'quantity', line1.id], [2, 'quantity', line2.id], [3, 'short_close', line1.id],
    ]);
    expect(detail.shortClosures).toHaveLength(1);
    expect(sortedKeys(detail.shortClosures[0])).toEqual(SHORT_CLOSURE_KEYS);
    expect(detail.shortClosures[0]).toMatchObject({ id: closure, lineId: line1.id, closedQuantity: 3, reason: '生産できない' });
  });

  // ---- FREQ-540-AC-07: 権限と ACL ----

  test.each([
    ['無効にした役割', { roles: ['admin'], options: { inactive: ['admin'] } }],
    ['期限切れの役割', { roles: ['admin'], options: { expired: ['admin'] } }],
    ['役割が無い', { roles: [] as string[], options: {} }],
  ])('FREQ-540-AC-07: purchase_orders.read を持たない実行者（%s）は一覧も詳細も GROUP_G_FORBIDDEN / 42501', async (_name, scenario) => {
    const owner = await manager();
    const [a] = await twoVariants();
    const order = await create(owner, [lineOf(a.variantId, 5)]);
    const actor = await createActor(scenario.roles, scenario.options);
    for (const schema of ['public', 'private'] as const) {
      expect(await rejected(() => list(actor, 20, 0, schema))).toEqual(FORBIDDEN);
      expect(await rejected(() => detailOf(actor, order.id, schema))).toEqual(FORBIDDEN);
    }
  });

  test('FREQ-540-AC-07: items.* だけ・purchase_orders.manage だけ・stock.* だけ・存在しない実行者・NULL は断られ、purchase_orders.read があれば読める（役割をまたいだ和集合も）', async () => {
    const owner = await manager();
    const [a] = await twoVariants();
    const order = await create(owner, [lineOf(a.variantId, 5)]);

    await grant('supporter', ['admin.items.read', 'admin.items.manage']);
    const itemsOnly = await createActor(['supporter']);
    expect(await rejected(() => list(itemsOnly, 20, 0))).toEqual(FORBIDDEN);
    expect(await rejected(() => detailOf(itemsOnly, order.id))).toEqual(FORBIDDEN);

    await revoke('supporter', ['admin.items.read', 'admin.items.manage']);
    await grant('supporter', ['admin.purchase_orders.manage', 'admin.stock.read', 'admin.stock.manage']);
    const manageOnly = await createActor(['supporter']);
    expect(await rejected(() => list(manageOnly, 20, 0))).toEqual(FORBIDDEN);
    expect(await rejected(() => detailOf(manageOnly, order.id))).toEqual(FORBIDDEN);

    expect(await rejected(() => list(randomUUID(), 20, 0))).toEqual(FORBIDDEN);
    expect(await rejected(() => detailOf(randomUUID(), order.id))).toEqual(FORBIDDEN);
    expect(await rejected(() => list(null, 20, 0))).toEqual(FORBIDDEN);
    expect(await rejected(() => detailOf(null, order.id))).toEqual(FORBIDDEN);

    await grant('user', ['admin.purchase_orders.read']);
    const readOnly = await createActor(['user']);
    expect(Array.isArray(await list(readOnly, 20, 0))).toBe(true);
    expect((await detailOf(readOnly, order.id) as Detail).id).toBe(order.id);
    // read が別の役割にあっても、有効な役割の和集合で足りる
    const union = await createActor(['supporter', 'user']);
    expect((await detailOf(union, order.id) as Detail).id).toBe(order.id);
  });

  test('FREQ-540-AC-07: 権限を持たない実行者には、引数が範囲外でも 22023 ではなく 42501（権限の確かめが先）、存在しない発注書でも NULL ではなく 42501', async () => {
    const outsider = await createActor([]);
    expect(await rejected(() => list(outsider, 0, 0))).toEqual(FORBIDDEN);
    expect(await rejected(() => detailOf(outsider, randomUUID()))).toEqual(FORBIDDEN);
  });

  test('FREQ-540-AC-07: 実行者の現在の権限を毎回確かめる。admin.purchase_orders.read を外すとその場から断られる', async () => {
    const owner = await manager();
    const [a] = await twoVariants();
    const order = await create(owner, [lineOf(a.variantId, 5)]);
    const actor = await manager();
    expect(Array.isArray(await list(actor, 20, 0))).toBe(true);
    await revoke('admin', ['admin.purchase_orders.read']);
    expect(await rejected(() => list(actor, 20, 0))).toEqual(FORBIDDEN);
    expect(await rejected(() => detailOf(actor, order.id))).toEqual(FORBIDDEN);
  });

  test('FREQ-540-AC-07: 読取の4本は所有者 postgres・search_path 空・STABLE で、PUBLIC / anon / authenticated に EXECUTE が無く service_role だけが持つ。helper は誰も持たない。private は DEFINER の plpgsql、public 入口は INVOKER の SQL', async () => {
    const read = async (signature: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
        l.lanname as language, p.proconfig as config, p.provolatile as volatility, p.proretset as set_returning,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [signature])).rows[0];
    const common = { owner: 'postgres', config: ['search_path=""'], volatility: 's', anon: false, authenticated: false, public_can_execute: false };

    expect(await read(HELPER)).toEqual({ ...common, definer: true, language: 'plpgsql', set_returning: true, service_role: false });
    expect(await read(`private.${LIST}`)).toEqual({ ...common, definer: true, language: 'plpgsql', set_returning: true, service_role: true });
    expect(await read(`public.${LIST}`)).toEqual({ ...common, definer: false, language: 'sql', set_returning: true, service_role: true });
    expect(await read(`private.${DETAIL}`)).toEqual({ ...common, definer: true, language: 'plpgsql', set_returning: false, service_role: true });
    expect(await read(`public.${DETAIL}`)).toEqual({ ...common, definer: false, language: 'sql', set_returning: false, service_role: true });
  });

  test('FREQ-540-AC-07: anon / authenticated は読取の入口も private 本体も呼べず（42501）、service_role は公開入口と private 本体から読める。helper は service_role も呼べない', async () => {
    const actor = await manager();
    const [a] = await twoVariants();
    const order = await create(actor, [lineOf(a.variantId, 5)]);
    const attempt = async (role: string, sql: string, params: unknown[]) => {
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
    const calls: Array<[string, unknown[]]> = [
      ['select * from public.list_admin_purchase_order_lines(20, 0, $1::uuid)', [actor]],
      ['select * from private.list_admin_purchase_order_lines(20, 0, $1::uuid)', [actor]],
      ['select public.get_admin_purchase_order($1::uuid, $2::uuid)', [order.id, actor]],
      ['select private.get_admin_purchase_order($1::uuid, $2::uuid)', [order.id, actor]],
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const [sql, params] of calls) expect(await attempt(role, sql, params)).toEqual({ code: '42501' });
    }
    for (const [sql, params] of calls) expect('rows' in await attempt('service_role', sql, params)).toBe(true);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await attempt(role, 'select * from private.purchase_order_display_stages($1::uuid[])', [[order.id]])).toEqual({ code: '42501' });
    }
    const viaService = await attempt('service_role', 'select public.get_admin_purchase_order($1::uuid, $2::uuid) as r', [order.id, actor]);
    expect(((viaService as { rows: Row[] }).rows[0].r as Detail).id).toBe(order.id);
  });

  // ---- 移行の最後の確かめ ----

  describe('移行の最後の確かめ（$g2a_final_purchase_reads$）', () => {
    const BLOCK = finalAssertBlock('$g2a_final_purchase_reads$');

    async function run(block: string) {
      await db().query('savepoint final_assert');
      try {
        await db().query(block);
        return null;
      } catch (error) {
        const e = error as DbFailure;
        return { code: e.code, message: e.message, detail: e.detail };
      } finally {
        await db().query('rollback to savepoint final_assert');
        await db().query('release savepoint final_assert');
      }
    }
    const failed = { code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail: 'purchase_read_functions' };

    /** 変更を取引の中で当ててから確かめを流す（確かめの後で savepoint まで戻すので、変更も戻る） */
    async function runAfter(sql: string) {
      await db().query('savepoint tamper');
      try {
        await db().query(sql);
        return await run(BLOCK);
      } finally {
        await db().query('rollback to savepoint tamper');
        await db().query('release savepoint tamper');
      }
    }

    test('FREQ-540-AC-07: 今の DB で通る', async () => {
      expect(await run(BLOCK)).toBeNull();
    });

    test.each([
      ['helper を service_role に開ける', 'grant execute on function private.purchase_order_display_stages(uuid[]) to service_role'],
      ['helper を PUBLIC に開ける', 'grant execute on function private.purchase_order_display_stages(uuid[]) to public'],
      ['一覧の private 本体を anon に開ける', 'grant execute on function private.list_admin_purchase_order_lines(integer, integer, uuid) to anon'],
      ['一覧の公開入口を authenticated に開ける', 'grant execute on function public.list_admin_purchase_order_lines(integer, integer, uuid) to authenticated'],
      ['詳細の公開入口を PUBLIC に開ける', 'grant execute on function public.get_admin_purchase_order(uuid, uuid) to public'],
      ['詳細の private 本体から service_role を外す', 'revoke execute on function private.get_admin_purchase_order(uuid, uuid) from service_role'],
      ['一覧の公開入口から service_role を外す', 'revoke execute on function public.list_admin_purchase_order_lines(integer, integer, uuid) from service_role'],
      ['詳細の公開入口を DEFINER にする', 'alter function public.get_admin_purchase_order(uuid, uuid) security definer'],
      ['一覧の private 本体を INVOKER にする', 'alter function private.list_admin_purchase_order_lines(integer, integer, uuid) security invoker'],
      ['詳細の private 本体を VOLATILE にする', 'alter function private.get_admin_purchase_order(uuid, uuid) volatile'],
      ['helper を IMMUTABLE にする', 'alter function private.purchase_order_display_stages(uuid[]) immutable'],
      ['詳細の private 本体の search_path を変える', 'alter function private.get_admin_purchase_order(uuid, uuid) set search_path = public'],
      ['一覧の公開入口の search_path を外す', 'alter function public.list_admin_purchase_order_lines(integer, integer, uuid) reset search_path'],
    ])('FREQ-540-AC-07: 確かめは崩れを拾う: %s', async (_name, sql) => {
      expect(await runAfter(sql)).toEqual(failed);
    });

    test('FREQ-540-AC-07: 関数が無ければ確かめは止まる（一覧の private 本体を落とした場合）', async () => {
      expect(await runAfter('drop function private.list_admin_purchase_order_lines(integer, integer, uuid)')).toEqual(failed);
    });

    test('FREQ-540-AC-07: 既存の確かめ（$g2a_final_public_function_acl$・$g2a_final_inventory_list$）は残っていて、今の DB で通る', async () => {
      for (const tag of ['$g2a_final_public_function_acl$', '$g2a_final_inventory_list$']) {
        expect(await run(finalAssertBlock(tag))).toBeNull();
      }
    });
  });
});
