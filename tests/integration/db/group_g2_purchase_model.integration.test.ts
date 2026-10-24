/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { addItemVariant, createCatalogFixture, variantStock, withLedgerLock } from './helpers/order-fixtures';

/**
 * G-2 Task 2（FREQ-526〜530 の基盤）: 発注書の 9 表（purchase_orders・purchase_order_lines・purchase_order_revisions・
 * purchase_order_short_closures・purchase_order_receipts・purchase_order_receipt_lines・purchase_order_attachment_reservations・
 * purchase_order_attachments・purchase_order_attachment_revisions）、追記専用 trigger、受取行・納品数の確かめ、個別の ACL、
 * 非公開の bucket purchase-order-documents、移行の最後の確かめ。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包み、想定の拒否は
 * SAVEPOINT で回収する。遅延の確かめは `set constraints all immediate` で取引の中で発火させる。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const FOUNDATION_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_foundation.sql'));
const FOUNDATION_SQL = FOUNDATION_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, FOUNDATION_FILE[0]), 'utf8') : '';

const TABLES = [
  'purchase_orders', 'purchase_order_lines', 'purchase_order_revisions', 'purchase_order_short_closures',
  'purchase_order_receipts', 'purchase_order_receipt_lines', 'purchase_order_attachment_reservations',
  'purchase_order_attachments', 'purchase_order_attachment_revisions',
];
const HISTORY_TABLES = TABLES.slice(2);
const SERVICE_READABLE = ['purchase_order_attachment_reservations', 'purchase_order_attachments'];
/** 追記専用の表を TRUNCATE する時に、外部キーで指す側として同じ文に並べる表（外部キーの確かめはトリガーより先に走る） */
const TRUNCATE_WITH: Record<string, string[]> = {
  purchase_order_revisions: ['purchase_order_short_closures'],
  purchase_order_short_closures: [],
  purchase_order_receipts: ['purchase_order_receipt_lines'],
  purchase_order_receipt_lines: [],
  purchase_order_attachment_reservations: ['purchase_order_attachments', 'purchase_order_attachment_revisions'],
  purchase_order_attachments: ['purchase_order_attachment_revisions'],
  purchase_order_attachment_revisions: [],
};
const FUNCTIONS = [
  { signature: 'private.guard_group_g_purchase_order_change()', definer: false },
  { signature: 'private.check_purchase_order_receipt_line()', definer: true },
  { signature: 'private.check_purchase_order_line_received()', definer: true },
];
const BUCKET = 'purchase-order-documents';
const MISMATCH = 'GROUP_G_PO_RECEIPT_LINE_MISMATCH';
const HISTORY = 'GROUP_G_HISTORY_IMMUTABLE';
const GUARD = 'GROUP_G_PURCHASE_ORDER_GUARD';

type DbFailure = { code?: string; message?: string; detail?: string; constraint?: string };
type Outcome = { rows: Array<Record<string, unknown>>; rowCount: number } | { code: string };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 移行の最後の確かめ（G2A_FINAL_ASSERT の DO 文）を取り出す */
function finalAssertBlock(tag: string): string {
  const section = FOUNDATION_SQL.slice(FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_BEGIN'), FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_END'));
  const start = section.indexOf(`DO ${tag}`);
  const end = section.indexOf(`${tag};`, start + tag.length + 3);
  if (start < 0 || end < 0) throw new Error(`missing ${tag}`);
  return section.slice(start, end + tag.length + 1);
}

describe('G-2 foundation migration の発注書の節（DB なし）', () => {
  const code = FOUNDATION_SQL.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

  test('FREQ-530-AC-01: 9 表と bucket の 1 行を作り、storage.objects の方針と private schema の USAGE の変更は書かない', () => {
    expect(FOUNDATION_FILE).toHaveLength(1);
    expect(code.match(/CREATE TABLE public\.purchase_order[a-z_]*/g)?.sort()).toEqual(TABLES.map((name) => `CREATE TABLE public.${name}`).sort());
    expect(code.match(/INSERT INTO storage\.buckets/g)).toHaveLength(1);
    expect(code).toContain('ON CONFLICT (id) DO NOTHING');
    expect(code).not.toMatch(/ON\s+storage\.objects/i);
    expect(code).not.toMatch(/ON SCHEMA\s+private/i);
    expect(code.match(/\bCREATE SEQUENCE\b/gi)).toBeNull();
    expect(Buffer.byteLength(FOUNDATION_SQL)).toBeLessThan(100000);
  });

  test('FREQ-530-AC-01: 最後の確かめは $g2a_final_objects$ と $g2a_final_table_acl$ の 2 つを足し、同じ DETAIL の形で止める', () => {
    for (const tag of ['$g2a_final_objects$', '$g2a_final_table_acl$']) {
      expect(finalAssertBlock(tag)).toContain("RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed");
    }
    expect(finalAssertBlock('$g2a_final_table_acl$')).toContain("current_setting('server_version_num')::integer >= 170000");
  });
});

describeLocalDb('integration: G-2 発注書のモデル', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  // ---- 共通の道具 ----

  /** SAVEPOINT の中で流し、失敗を回収して戻す（成功した時は空のオブジェクト） */
  async function failure(run: () => Promise<unknown>): Promise<DbFailure> {
    await db().query('savepoint expected_error');
    let error: unknown;
    try { await run(); } catch (caught) { error = caught; }
    finally { await db().query('rollback to savepoint expected_error'); }
    return (error ?? {}) as DbFailure;
  }

  /** 生の DB の文を出さないよう、記号が違う時は決まった文に置き換えて比べる */
  async function rejected(run: () => Promise<unknown>, message: string, code: string, detail?: string) {
    const caught = await failure(run);
    expect({
      message: caught.message === message ? message : `G2_UNEXPECTED_DB_ERROR:${caught.code ?? 'none'}`,
      code: caught.code,
      ...(detail === undefined ? {} : { detail: caught.detail }),
    }).toEqual({ message, code, ...(detail === undefined ? {} : { detail }) });
  }

  async function violated(run: () => Promise<unknown>, code: string, constraint: string) {
    const caught = await failure(run);
    expect({ code: caught.code, constraint: caught.constraint }).toEqual({ code, constraint });
  }

  /** NOT NULL の違反は制約の名前を持たないので、SQLSTATE だけで比べる */
  async function notNull(run: () => Promise<unknown>) {
    expect((await failure(run)).code).toBe('23502');
  }

  async function asRole(role: string, sql: string, params: unknown[] = []) {
    await db().query(`set local role ${role}`);
    return db().query(sql, params);
  }

  const immediate = () => db().query('set constraints all immediate');

  /** ここまでの遅延の確かめを流してから、遅延へ戻す */
  async function flush() {
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
  }

  const takeCommonLock = () => db().query('select pg_catalog.pg_advisory_xact_lock(190521, 1)');
  async function commonLockHeld(): Promise<boolean> {
    return (await db().query(
      `select exists (select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'
         and classid = 190521 and objid = 1 and objsubid = 2 and mode = 'ExclusiveLock' and granted) as held`,
    )).rows[0].held as boolean;
  }

  /** 指定した役の下で流す。断られても取引は続けられる（savepoint まで戻す） */
  async function attempt(role: string, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint role_attempt');
    try {
      await db().query(`set local role ${role}`);
      if (role === 'authenticated') await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: randomUUID(), role })]);
      const res = await db().query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint role_attempt');
      await db().query('release savepoint role_attempt');
    }
  }

  // ---- 材料 ----

  const actor = randomUUID();
  let sequence = 1000 + Math.floor(Math.random() * 7000);
  const nextNumber = () => `PO-20261025-${String(sequence++ % 10000).padStart(4, '0')}`;

  async function insertRow(table: string, values: Record<string, unknown>): Promise<string> {
    const columns = Object.keys(values);
    const res = await db().query(
      `insert into public.${table} (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
      columns.map((column) => values[column]),
    );
    return String(res.rows[0].id);
  }

  async function operation(): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
       values ($1, 'g2_purchase_model_test', gen_random_uuid(), $2, 'test', $3, '{}'::jsonb)`,
      [id, sha256(id), id],
    );
    return id;
  }

  const order = (values: Record<string, unknown> = {}) =>
    insertRow('purchase_orders', { number: nextNumber(), supplier_name: 'Supplier A', created_by: actor, ...values });

  const line = (orderId: string, variantId: number, values: Record<string, unknown> = {}) =>
    insertRow('purchase_order_lines', {
      purchase_order_id: orderId, line_no: 1, variant_id: variantId, item_name: 'Item', color_name: 'BLACK', size_label: 'M',
      provisional_quantity: 5, confirmed_quantity: 5, ...values,
    });

  /** 台帳の 1 行（無タグ）。共通の押さえは書く間だけ持つ */
  async function movement(variantId: number, delta: number, reason: string, operationId: string | null = null): Promise<string> {
    const res = await withLedgerLock(db(), () => db().query(
      `insert into public.stock_movements (variant_id, delta, reason, allocation_operation_id) values ($1, $2, $3, $4) returning id`,
      [variantId, delta, reason, operationId],
    ));
    return String(res.rows[0].id);
  }

  const receipt = (orderId: string, operationId: string, values: Record<string, unknown> = {}) =>
    insertRow('purchase_order_receipts', {
      purchase_order_id: orderId, kind: 'receive', received_on: '2026-10-25', actor_id: actor, operation_id: operationId, ...values,
    });

  const reverseReceipt = (orderId: string, operationId: string) => receipt(orderId, operationId, { kind: 'reverse', reason: 'cancelled' });

  const receiptLine = (receiptId: string, lineId: string, quantity: number, movementId: string, reverses: string | null = null) =>
    insertRow('purchase_order_receipt_lines', {
      receipt_id: receiptId, line_id: lineId, quantity, reverses_receipt_line_id: reverses, stock_movement_id: movementId,
    });

  const reservation = (orderId: string, operationId: string, values: Record<string, unknown> = {}) =>
    insertRow('purchase_order_attachment_reservations', {
      purchase_order_id: orderId, kind: 'quote', original_file_name: 'quote.pdf', storage_path: `${orderId}/${randomUUID()}.pdf`,
      created_by: actor, operation_id: operationId, expires_at: '2026-10-26T00:00:00Z', ...values,
    });

  const attachment = (orderId: string, reservationId: string, operationId: string, values: Record<string, unknown> = {}) =>
    insertRow('purchase_order_attachments', {
      purchase_order_id: orderId, reservation_id: reservationId, kind: 'quote', original_file_name: 'quote.pdf',
      storage_path: `${orderId}/${randomUUID()}.pdf`, mime_type: 'application/pdf', size_bytes: 1024, sha256: 'a'.repeat(64),
      sha256_source: 'browser', uploaded_by: actor, operation_id: operationId, ...values,
    });

  const attachmentRevision = (attachmentId: string, operationId: string, values: Record<string, unknown> = {}) =>
    insertRow('purchase_order_attachment_revisions', {
      attachment_id: attachmentId, revision_no: 1, transaction_date: '2026-10-25', amount_yen: 12000, currency: 'JPY',
      counterparty: 'Supplier A', actor_id: actor, operation_id: operationId, ...values,
    });

  /** 商品・variant（在庫 20）・操作の受付・発注書 */
  async function base(stock = 20) {
    const catalog = await createCatalogFixture(db(), { stock });
    const operationId = await operation();
    const orderId = await order();
    return { itemId: catalog.itemId, variantId: catalog.variantId, operationId, orderId };
  }

  /** 9 表のすべてに 1 行ずつ。納品数は受取行の合計（2）と合う */
  async function graph() {
    const b = await base();
    const lineId = await line(b.orderId, b.variantId, { confirmed_quantity: 5, received_quantity: 2, unit_price_yen: 1200 });
    const revisionId = await insertRow('purchase_order_revisions', {
      purchase_order_id: b.orderId, line_id: lineId, revision_no: 2, kind: 'short_close', before_quantity: 5, after_quantity: 3,
      reason: 'short', actor_id: actor, operation_id: b.operationId,
    });
    const closureId = await insertRow('purchase_order_short_closures', {
      line_id: lineId, revision_id: revisionId, closed_quantity: 2, reason: 'short', actor_id: actor,
    });
    const receiptId = await receipt(b.orderId, b.operationId);
    const movementId = await movement(b.variantId, 2, 'restock');
    const receiptLineId = await receiptLine(receiptId, lineId, 2, movementId);
    const reservationId = await reservation(b.orderId, b.operationId);
    const attachmentId = await attachment(b.orderId, reservationId, b.operationId);
    const attachmentRevisionId = await attachmentRevision(attachmentId, b.operationId);
    return { ...b, lineId, revisionId, closureId, receiptId, movementId, receiptLineId, reservationId, attachmentId, attachmentRevisionId };
  }

  // ---- 追記専用 ----

  test('FREQ-530-AC-01: 追記専用7表はowner/service_roleの通常SQLのUPDATE・DELETE・TRUNCATEを GROUP_G_HISTORY_IMMUTABLE / 55000 で拒否する', async () => {
    const g = await graph();
    // 遅延の確かめが残っていると TRUNCATE はトリガーの前に断られる。先に流しておく
    await flush();
    const ids: Record<string, string> = {
      purchase_order_revisions: g.revisionId, purchase_order_short_closures: g.closureId, purchase_order_receipts: g.receiptId,
      purchase_order_receipt_lines: g.receiptLineId, purchase_order_attachment_reservations: g.reservationId,
      purchase_order_attachments: g.attachmentId, purchase_order_attachment_revisions: g.attachmentRevisionId,
    };
    for (const table of TABLES) await db().query(`grant select, insert, update, delete, truncate on public.${table} to service_role`);

    for (const role of ['postgres', 'service_role']) {
      for (const table of HISTORY_TABLES) {
        await rejected(() => asRole(role, `update public.${table} set created_at = created_at where id = $1`, [ids[table]]), HISTORY, '55000');
        await rejected(() => asRole(role, `delete from public.${table} where id = $1`, [ids[table]]), HISTORY, '55000');
        const statement = `truncate ${[table, ...TRUNCATE_WITH[table]].map((name) => `public.${name}`).join(', ')}`;
        await rejected(() => asRole(role, statement), HISTORY, '55000');
      }
    }
  });

  // ---- 発注書と明細: 削除・TRUNCATE の拒否、UPDATE の守り ----

  test('FREQ-526-AC-01: purchase_orders / purchase_order_lines は DELETE・TRUNCATE を拒否する', async () => {
    const g = await graph();
    await flush();

    await rejected(() => db().query('delete from public.purchase_orders where id = $1', [g.orderId]), HISTORY, '55000');
    await rejected(() => db().query('delete from public.purchase_order_lines where id = $1', [g.lineId]), HISTORY, '55000');
    await rejected(() => db().query(`truncate ${TABLES.map((name) => `public.${name}`).join(', ')}`), HISTORY, '55000');
    await rejected(() => db().query(
      'truncate public.purchase_order_lines, public.purchase_order_revisions, public.purchase_order_short_closures, public.purchase_order_receipt_lines',
    ), HISTORY, '55000');
  });

  test('FREQ-526-AC-01: purchase_orders の UPDATE は不変の列・version+1・共通 advisory の保持を守る', async () => {
    const g = await graph();
    expect(await commonLockHeld()).toBe(false);
    const update = (set: string) => db().query(`update public.purchase_orders set ${set} where id = $1`, [g.orderId]);
    const row = async () => (await db().query(
      'select supplier_name, memo, stage, version, updated_at from public.purchase_orders where id = $1', [g.orderId],
    )).rows[0];

    // 押さえを持たない接続では、変わる更新を断る。何も変わらない更新は通る
    await rejected(() => update("supplier_name = 'B', version = version + 1"), 'GROUP_G_INVENTORY_LOCK_REQUIRED', '55000');
    expect((await update('supplier_name = supplier_name')).rowCount).toBe(1);
    expect((await row()).version).toBe(1);

    await takeCommonLock();
    expect(await commonLockHeld()).toBe(true);
    await rejected(() => update("supplier_name = 'B'"), GUARD, '55000', 'version');
    await rejected(() => update("supplier_name = 'B', version = version + 2"), GUARD, '55000', 'version');
    await rejected(() => update("supplier_name = 'B', version = version - 1"), GUARD, '55000', 'version');
    for (const set of [
      'id = gen_random_uuid()', "number = 'PO-20261025-9999'", "ordered_at = ordered_at - interval '1 second'",
      'created_by = gen_random_uuid()', "created_at = created_at + interval '1 second'",
    ]) {
      await rejected(() => update(`${set}, version = version + 1`), GUARD, '55000', 'immutable_column');
      await rejected(() => update(set), GUARD, '55000', 'immutable_column');
    }

    await update("supplier_name = 'B', memo = 'note', stage = 'quantity_confirmed', updated_at = now(), version = version + 1");
    expect(await row()).toMatchObject({ supplier_name: 'B', memo: 'note', stage: 'quantity_confirmed', version: 2 });
    await update('version = version + 1');
    expect((await row()).version).toBe(3);
  });

  test('FREQ-526-AC-01: purchase_order_lines の UPDATE は不変の列・version+1・共通 advisory の保持を守り、outstanding_quantity は生成列', async () => {
    const g = await graph();
    const otherOrder = await order();
    const otherVariant = await addItemVariant(db(), { itemId: g.itemId, colorName: 'WHITE', sizeLabel: 'L', stock: 0 });
    expect(await commonLockHeld()).toBe(false);
    const update = (set: string) => db().query(`update public.purchase_order_lines set ${set} where id = $1`, [g.lineId]);
    const row = async () => (await db().query(
      'select confirmed_quantity, received_quantity, unit_price_yen, outstanding_quantity, version from public.purchase_order_lines where id = $1',
      [g.lineId],
    )).rows[0];

    await rejected(() => update('unit_price_yen = 0, version = version + 1'), 'GROUP_G_INVENTORY_LOCK_REQUIRED', '55000');
    expect((await update('confirmed_quantity = confirmed_quantity')).rowCount).toBe(1);

    await takeCommonLock();
    await rejected(() => update('unit_price_yen = 0'), GUARD, '55000', 'version');
    await rejected(() => update('unit_price_yen = 0, version = version + 2'), GUARD, '55000', 'version');
    for (const [set, params] of [
      ['id = gen_random_uuid()', []], ['purchase_order_id = $2', [otherOrder]], ['line_no = 2', []], ['variant_id = $2', [otherVariant.variantId]],
      ["item_name = 'Other'", []], ["color_name = 'RED'", []], ["size_label = 'XL'", []], ['provisional_quantity = 6', []],
      ["created_at = created_at + interval '1 second'", []],
    ] as Array<[string, unknown[]]>) {
      await rejected(
        () => db().query(`update public.purchase_order_lines set ${set}, version = version + 1 where id = $1`, [g.lineId, ...params]),
        GUARD, '55000', 'immutable_column',
      );
    }

    expect(await row()).toMatchObject({ confirmed_quantity: 5, received_quantity: 2, outstanding_quantity: 3, version: 1 });
    await update('confirmed_quantity = 8, unit_price_yen = 0, updated_at = now(), version = version + 1');
    expect(await row()).toMatchObject({ confirmed_quantity: 8, received_quantity: 2, unit_price_yen: 0, outstanding_quantity: 6, version: 2 });
    await update('unit_price_yen = NULL, version = version + 1');
    expect(await row()).toMatchObject({ unit_price_yen: null, version: 3 });
  });

  // ---- 行の制約 ----

  test('FREQ-526-AC-01: 発注書の番号の書式・文字数・段階・版・番号の一意', async () => {
    const insert = (values: Record<string, unknown>) => order(values);

    for (const bad of ['PO-2026102-0001', 'po-20261025-0001', 'PO-20261025-00001', 'XPO-20261025-0001', 'PO-20261025-0001X', 'PO-20261025-000A', '']) {
      await violated(() => insert({ number: bad }), '23514', 'purchase_orders_number_check');
    }
    await violated(() => insert({ supplier_name: '' }), '23514', 'purchase_orders_supplier_name_check');
    await violated(() => insert({ supplier_name: 'x'.repeat(101) }), '23514', 'purchase_orders_supplier_name_check');
    await violated(() => insert({ memo: 'x'.repeat(501) }), '23514', 'purchase_orders_memo_check');
    await violated(() => insert({ stage: 'received' }), '23514', 'purchase_orders_stage_check');
    await violated(() => insert({ version: 0 }), '23514', 'purchase_orders_version_check');

    const first = await insert({ number: 'PO-20261025-0001', supplier_name: 'x'.repeat(100), memo: 'y'.repeat(500) });
    await violated(() => insert({ number: 'PO-20261025-0001' }), '23505', 'purchase_orders_number_key');
    expect((await db().query('select stage, version, memo is null as no_memo from public.purchase_orders where id = $1', [first])).rows[0])
      .toEqual({ stage: 'ordered', version: 1, no_memo: false });
    const noMemo = await insert({});
    expect((await db().query('select memo from public.purchase_orders where id = $1', [noMemo])).rows[0]).toEqual({ memo: null });
  });

  test('FREQ-527-AC-01: 明細の数量の範囲・確定は納品済み以上・未確定は納品 0・単価の NULL と 0 の区別・発注書内の重複拒否・生成列', async () => {
    const b = await base();
    const second = await addItemVariant(db(), { itemId: b.itemId, colorName: 'WHITE', sizeLabel: 'L', stock: 0 });
    const insert = (values: Record<string, unknown>) => line(b.orderId, b.variantId, values);
    const check = (name: string) => `purchase_order_lines_${name}`;

    for (const [column, bad] of [
      ['provisional_quantity', 0], ['provisional_quantity', 100000], ['confirmed_quantity', -1], ['confirmed_quantity', 100000],
      ['received_quantity', -1], ['unit_price_yen', -1], ['unit_price_yen', 10000000], ['line_no', 0], ['version', 0],
    ] as Array<[string, number]>) {
      await violated(() => insert({ [column]: bad }), '23514', check(`${column}_check`));
    }
    await violated(() => insert({ confirmed_quantity: 2, received_quantity: 3 }), '23514', check('confirmed_received_check'));
    await violated(() => insert({ confirmed_quantity: null, received_quantity: 1 }), '23514', check('unconfirmed_received_check'));
    await violated(() => insert({ variant_id: 999999999 }), '23503', check('variant_id_fkey'));
    await violated(() => line(randomUUID(), b.variantId), '23503', check('purchase_order_id_fkey'));

    // 境界は通る。納品済みが確定数量と同じ（未納 0）も通る。未確定の未納は NULL
    const lowest = await insert({ line_no: 1, provisional_quantity: 1, confirmed_quantity: 0, received_quantity: 0, unit_price_yen: 0 });
    const highest = await insert({ line_no: 2, variant_id: second.variantId, provisional_quantity: 99999, confirmed_quantity: 99999, unit_price_yen: 9999999 });
    const fetch = async (id: string) => (await db().query(
      'select confirmed_quantity, outstanding_quantity, unit_price_yen from public.purchase_order_lines where id = $1', [id],
    )).rows[0];
    expect(await fetch(lowest)).toEqual({ confirmed_quantity: 0, outstanding_quantity: 0, unit_price_yen: 0 });
    expect(await fetch(highest)).toEqual({ confirmed_quantity: 99999, outstanding_quantity: 99999, unit_price_yen: 9999999 });

    // 同じ発注書の同じ variant・同じ行番号は断る。別の発注書なら同じ variant でよい
    await violated(() => insert({ line_no: 3 }), '23505', check('order_variant_key'));
    const third = await addItemVariant(db(), { itemId: b.itemId, colorName: 'RED', sizeLabel: 'S', stock: 0 });
    await violated(() => insert({ line_no: 2, variant_id: third.variantId }), '23505', check('order_line_no_key'));
    const another = await order();
    await line(another, b.variantId, { confirmed_quantity: null });
    const unconfirmed = await line(another, second.variantId, { line_no: 2, confirmed_quantity: null, unit_price_yen: null });
    expect(await fetch(unconfirmed)).toEqual({ confirmed_quantity: null, outstanding_quantity: null, unit_price_yen: null });
    const acceptedLine = await line(b.orderId, third.variantId, { line_no: 3, confirmed_quantity: 5, received_quantity: 2, unit_price_yen: 1 });
    expect((await fetch(acceptedLine)).outstanding_quantity).toBe(3);
  });

  test('FREQ-526-AC-01: 履歴（revisions・short_closures）の制約。revisions は NULL の line_id も同じ値として一意', async () => {
    const b = await base();
    const lineA = await line(b.orderId, b.variantId);
    const other = await addItemVariant(db(), { itemId: b.itemId, colorName: 'WHITE', sizeLabel: 'L', stock: 0 });
    const lineB = await line(b.orderId, other.variantId, { line_no: 2 });
    const revision = (values: Record<string, unknown>) => insertRow('purchase_order_revisions', {
      purchase_order_id: b.orderId, revision_no: 2, kind: 'header', actor_id: actor, operation_id: b.operationId, ...values,
    });
    const check = (name: string) => `purchase_order_revisions_${name}`;

    await violated(() => revision({ revision_no: 0 }), '23514', check('revision_no_check'));
    await violated(() => revision({ kind: 'cancel' }), '23514', check('kind_check'));
    await violated(() => revision({ before_quantity: -1 }), '23514', check('quantity_check'));
    await violated(() => revision({ after_quantity: 100000 }), '23514', check('quantity_check'));
    await violated(() => revision({ before_unit_price_yen: -1 }), '23514', check('unit_price_check'));
    await violated(() => revision({ after_unit_price_yen: 10000000 }), '23514', check('unit_price_check'));
    await violated(() => revision({ before_supplier_name: '' }), '23514', check('text_check'));
    await violated(() => revision({ after_supplier_name: 'x'.repeat(101) }), '23514', check('text_check'));
    await violated(() => revision({ after_memo: 'x'.repeat(501) }), '23514', check('text_check'));
    await violated(() => revision({ reason: '' }), '23514', check('reason_check'));
    await violated(() => revision({ reason: 'x'.repeat(201) }), '23514', check('reason_check'));

    // 発注書全体の行（line_id が NULL）は、同じ版・同じ種類で 2 つ作れない。行ごとの行は別
    await revision({ kind: 'header', before_supplier_name: 'A', after_supplier_name: 'B', reason: 'fix' });
    await violated(() => revision({ kind: 'header' }), '23505', check('revision_key'));
    await revision({ kind: 'quantity', line_id: lineA, before_quantity: 5, after_quantity: 6 });
    await revision({ kind: 'quantity', line_id: lineB, before_quantity: 5, after_quantity: 6 });
    await violated(() => revision({ kind: 'quantity', line_id: lineA }), '23505', check('revision_key'));
    await revision({ kind: 'header', revision_no: 3 });

    const closing = await revision({ kind: 'short_close', line_id: lineA, revision_no: 4, reason: 'short' });
    const closure = (values: Record<string, unknown>) => insertRow('purchase_order_short_closures', {
      line_id: lineA, revision_id: closing, closed_quantity: 1, reason: 'short', actor_id: actor, ...values,
    });
    await violated(() => closure({ closed_quantity: 0 }), '23514', 'purchase_order_short_closures_closed_quantity_check');
    await violated(() => closure({ reason: '' }), '23514', 'purchase_order_short_closures_reason_check');
    await violated(() => closure({ reason: 'x'.repeat(201) }), '23514', 'purchase_order_short_closures_reason_check');
    await notNull(() => closure({ reason: null }));
    await violated(() => closure({ revision_id: randomUUID() }), '23503', 'purchase_order_short_closures_revision_id_fkey');
    await closure({});
    await violated(() => closure({}), '23505', 'purchase_order_short_closures_revision_id_key');
  });

  test('FREQ-529-AC-01: 受取（receipts）の種類と理由・受取行の数量と符号・一意', async () => {
    const b = await base();
    const lineId = await line(b.orderId, b.variantId, { confirmed_quantity: 10 });
    const check = (name: string) => `purchase_order_receipts_${name}`;
    const insert = (values: Record<string, unknown>) => receipt(b.orderId, b.operationId, values);

    await violated(() => insert({ kind: 'cancel' }), '23514', check('kind_check'));
    await violated(() => insert({ kind: 'reverse' }), '23514', check('kind_reason_check'));
    await violated(() => insert({ kind: 'receive', reason: 'x' }), '23514', check('kind_reason_check'));
    await violated(() => insert({ memo: 'x'.repeat(201) }), '23514', check('memo_check'));
    await violated(() => insert({ kind: 'reverse', reason: '' }), '23514', check('reason_check'));
    await violated(() => insert({ kind: 'reverse', reason: 'x'.repeat(201) }), '23514', check('reason_check'));
    await notNull(() => insert({ received_on: null }));
    const received = await insert({ memo: 'x'.repeat(200) });
    expect((await db().query('select kind, reason from public.purchase_order_receipts where id = $1', [received])).rows[0])
      .toEqual({ kind: 'receive', reason: null });

    // 受取行: 範囲（台帳の行が揃っていれば CHECK に届く）と符号と相殺元の組
    const huge = await movement(b.variantId, 100000, 'restock');
    await violated(() => receiptLine(received, lineId, 100000, huge), '23514', 'purchase_order_receipt_lines_quantity_check');
    const small = await movement(b.variantId, 1, 'restock');
    const first = await receiptLine(received, lineId, 1, small);
    const origin = await movement(b.variantId, 2, 'restock');
    const second = await receipt(b.orderId, b.operationId);
    const originLine = await receiptLine(second, lineId, 2, origin);
    const positiveWithOrigin = await movement(b.variantId, 1, 'restock');
    const third = await receipt(b.orderId, b.operationId);
    await violated(() => receiptLine(third, lineId, 1, positiveWithOrigin, originLine), '23514', 'purchase_order_receipt_lines_reverses_check');
    const negativeWithoutOrigin = await movement(b.variantId, -1, 'adjustment');
    await violated(() => receiptLine(third, lineId, -1, negativeWithoutOrigin), '23514', 'purchase_order_receipt_lines_reverses_check');
    // 数量 0 の台帳の行は作れないので、受取行の数量 0 は台帳との突き合わせが先に断る
    await rejected(() => receiptLine(third, lineId, 0, small), MISMATCH, '23514');

    // 同じ受取に同じ明細は 1 行。台帳の行は 1 つの受取行にだけ結べる
    const again = await movement(b.variantId, 1, 'restock');
    await violated(() => receiptLine(received, lineId, 1, again), '23505', 'purchase_order_receipt_lines_receipt_line_key');
    await violated(() => receiptLine(third, lineId, 1, small), '23505', 'purchase_order_receipt_lines_stock_movement_id_key');
    expect(first).not.toBe(originLine);
  });

  test('FREQ-530-AC-01: 原本の予約・添付・訂正の制約', async () => {
    const b = await base();
    const rCheck = (name: string) => `purchase_order_attachment_reservations_${name}`;
    const aCheck = (name: string) => `purchase_order_attachments_${name}`;
    const vCheck = (name: string) => `purchase_order_attachment_revisions_${name}`;

    // 予約
    await violated(() => reservation(b.orderId, b.operationId, { kind: 'receipt' }), '23514', rCheck('kind_check'));
    await violated(() => reservation(b.orderId, b.operationId, { original_file_name: '' }), '23514', rCheck('file_name_check'));
    await violated(() => reservation(b.orderId, b.operationId, { original_file_name: 'x'.repeat(256) }), '23514', rCheck('file_name_check'));
    await notNull(() => reservation(b.orderId, b.operationId, { expires_at: null }));
    const pathA = `${b.orderId}/${randomUUID()}.pdf`;
    const reserved = await reservation(b.orderId, b.operationId, { storage_path: pathA, kind: 'invoice', original_file_name: 'x'.repeat(255) });
    await violated(() => reservation(b.orderId, b.operationId, { storage_path: pathA }), '23505', rCheck('storage_path_key'));

    // 添付
    const make = (values: Record<string, unknown>) => attachment(b.orderId, reserved, b.operationId, values);
    await violated(() => make({ kind: 'receipt' }), '23514', aCheck('kind_check'));
    await violated(() => make({ original_file_name: '' }), '23514', aCheck('file_name_check'));
    await violated(() => make({ mime_type: 'text/plain' }), '23514', aCheck('mime_type_check'));
    await violated(() => make({ size_bytes: 0 }), '23514', aCheck('size_bytes_check'));
    await violated(() => make({ size_bytes: 20971521 }), '23514', aCheck('size_bytes_check'));
    await violated(() => make({ sha256: 'A'.repeat(64) }), '23514', aCheck('sha256_check'));
    await violated(() => make({ sha256: 'a'.repeat(63) }), '23514', aCheck('sha256_check'));
    await violated(() => make({ sha256_source: 'client' }), '23514', aCheck('sha256_source_check'));
    await violated(() => make({ reservation_id: randomUUID() }), '23503', aCheck('reservation_id_fkey'));
    for (const mime of ['application/pdf', 'image/jpeg', 'image/png']) {
      await db().query('savepoint accepted_mime');
      await make({ mime_type: mime, size_bytes: 20971520, sha256_source: 'server' });
      await db().query('rollback to savepoint accepted_mime');
    }
    const stored = await make({ storage_path: pathA });
    await violated(() => make({}), '23505', aCheck('reservation_id_key'));
    const reservedB = await reservation(b.orderId, b.operationId);
    await violated(() => attachment(b.orderId, reservedB, b.operationId, { storage_path: pathA }), '23505', aCheck('storage_path_key'));

    // 取引の記録
    const revise = (values: Record<string, unknown>) => attachmentRevision(stored, b.operationId, values);
    await violated(() => revise({ revision_no: 0 }), '23514', vCheck('revision_no_check'));
    await violated(() => revise({ transaction_date: '1999-12-31' }), '23514', vCheck('transaction_date_check'));
    await violated(() => revise({ amount_yen: -1 }), '23514', vCheck('amount_yen_check'));
    await violated(() => revise({ amount_yen: 100000000000 }), '23514', vCheck('amount_yen_check'));
    for (const currency of ['jpy', 'JP', 'JPYX', 'J1Y']) await violated(() => revise({ currency }), '23514', vCheck('currency_check'));
    await violated(() => revise({ counterparty: '' }), '23514', vCheck('counterparty_check'));
    await violated(() => revise({ counterparty: 'x'.repeat(101) }), '23514', vCheck('counterparty_check'));
    await violated(() => revise({ reason: '' }), '23514', vCheck('reason_check'));
    await violated(() => revise({ revision_no: 2 }), '23514', vCheck('revision_reason_check'));
    await violated(() => revise({ voided: true }), '23514', vCheck('voided_reason_check'));
    await violated(() => revise({ revision_no: 2, reason: 'fix', replaces_attachment_id: stored }), '23514', vCheck('replaces_check'));
    await violated(() => revise({ replaces_attachment_id: randomUUID() }), '23503', vCheck('replaces_attachment_fkey'));
    const first = await revise({ transaction_date: '2000-01-01', amount_yen: 99999999999, counterparty: 'x'.repeat(100) });
    await violated(() => revise({}), '23505', vCheck('attachment_revision_key'));
    await revise({ revision_no: 2, reason: 'fixed the amount', amount_yen: 0 });
    await revise({ revision_no: 3, voided: true, reason: 'voided' });
    const replacement = await attachment(b.orderId, reservedB, b.operationId);
    await attachmentRevision(replacement, b.operationId, { replaces_attachment_id: stored });
    expect(first).not.toBe(replacement);
  });

  test('FREQ-530-AC-01: 操作の受付への外部キーは遅延で、受付の行が無いと取引の中の確かめで 23503', async () => {
    const b = await base();
    await flush();
    const missing = randomUUID();
    const cases: Array<() => Promise<unknown>> = [
      () => insertRow('purchase_order_revisions', { purchase_order_id: b.orderId, revision_no: 2, kind: 'header', actor_id: actor, operation_id: missing }),
      () => receipt(b.orderId, missing),
      () => reservation(b.orderId, missing),
      async () => { const reserved = await reservation(b.orderId, b.operationId); await attachment(b.orderId, reserved, missing); },
      async () => {
        const reserved = await reservation(b.orderId, b.operationId);
        const stored = await attachment(b.orderId, reserved, b.operationId);
        await attachmentRevision(stored, missing);
      },
    ];
    for (const run of cases) {
      const caught = await failure(async () => { await run(); await immediate(); });
      expect(caught.code).toBe('23503');
    }

    // どの外部キーも ON DELETE RESTRICT。操作の受付への 5 本だけが遅延
    const fkeys = (await db().query(
      `select c.conrelid::regclass::text as relation, c.conname as name, c.condeferrable as deferrable, c.condeferred as deferred,
              c.confdeltype::text as on_delete, c.confupdtype::text as on_update
       from pg_constraint c where c.contype = 'f' and c.conrelid = any ($1::regclass[]) order by c.conname`,
      [TABLES.map((name) => `public.${name}`)],
    )).rows;
    expect(fkeys).toHaveLength(21);
    for (const fkey of fkeys) {
      expect(fkey).toMatchObject({
        on_delete: 'r', on_update: 'a',
        deferrable: String(fkey.name).endsWith('_operation_id_fkey'), deferred: String(fkey.name).endsWith('_operation_id_fkey'),
      });
    }
    expect(fkeys.filter((fkey) => fkey.deferrable)).toHaveLength(5);
  });

  // ---- 納品数と受取行の確かめ ----

  test('FREQ-529-AC-01: received_quantity が受取行の合計と違うと commit（遅延の確かめ）で GROUP_G_PO_RECEIVED_MISMATCH / 23514', async () => {
    const b = await base();
    const mismatch = (run: () => Promise<unknown>) => rejected(async () => { await run(); await immediate(); }, 'GROUP_G_PO_RECEIVED_MISMATCH', '23514', 'received_quantity');
    const orderWithLine = async (values: Record<string, unknown>) => {
      const orderId = await order();
      return { orderId, lineId: await line(orderId, b.variantId, { confirmed_quantity: 10, ...values }) };
    };

    // 受取行があるのに納品数が 0、納品数が受取行の合計より多い・少ない、受取行が無いのに納品数がある
    await mismatch(async () => {
      const { orderId, lineId } = await orderWithLine({ received_quantity: 0 });
      await receiptLine(await receipt(orderId, b.operationId), lineId, 2, await movement(b.variantId, 2, 'restock'));
    });
    await mismatch(async () => {
      const { orderId, lineId } = await orderWithLine({ received_quantity: 3 });
      await receiptLine(await receipt(orderId, b.operationId), lineId, 2, await movement(b.variantId, 2, 'restock'));
    });
    await mismatch(async () => {
      const { orderId, lineId } = await orderWithLine({ received_quantity: 1 });
      await receiptLine(await receipt(orderId, b.operationId), lineId, 2, await movement(b.variantId, 2, 'restock'));
    });
    await mismatch(async () => { await orderWithLine({ received_quantity: 2 }); });

    // 合えば通る。2 回に分けた受取も合計で見る
    const { orderId, lineId } = await orderWithLine({ received_quantity: 5 });
    await receiptLine(await receipt(orderId, b.operationId), lineId, 2, await movement(b.variantId, 2, 'restock'));
    await receiptLine(await receipt(orderId, b.operationId), lineId, 3, await movement(b.variantId, 3, 'restock'));
    await flush();

    // 納品数の更新（押さえを持つ接続・版 +1）が受取行の合計と合わなければ止まる。合わせれば通る
    await takeCommonLock();
    await mismatch(async () => {
      await db().query('update public.purchase_order_lines set received_quantity = 6, version = version + 1 where id = $1', [lineId]);
    });
    await db().query('update public.purchase_order_lines set unit_price_yen = 100, version = version + 1 where id = $1', [lineId]);
    await flush();
    expect(await variantStock(db(), b.variantId)).toBe(20 + 2 + 3);
  });

  test('FREQ-529-AC-01: 受取行は同 variant・同数量の無タグの台帳行（正は restock、負は adjustment）にしか結べず、そうでなければ GROUP_G_PO_RECEIPT_LINE_MISMATCH', async () => {
    const b = await base();
    const other = await addItemVariant(db(), { itemId: b.itemId, colorName: 'WHITE', sizeLabel: 'L', stock: 20 });
    const lineId = await line(b.orderId, b.variantId, { confirmed_quantity: 10 });
    const otherOrder = await order();
    const otherLine = await line(otherOrder, b.variantId, { confirmed_quantity: 10 });
    const mismatch = (run: () => Promise<unknown>, detail: string) => rejected(run, MISMATCH, '23514', detail);
    const fresh = () => receipt(b.orderId, b.operationId);

    // 正しい行は結べる（正は restock）
    const receiptId = await fresh();
    await receiptLine(receiptId, lineId, 2, await movement(b.variantId, 2, 'restock'));

    // タグ付きの行（G-1 の整合 trigger が見る行）・別 variant・数量違い・理由違い・存在しない行は結べない
    await mismatch(async () => receiptLine(await fresh(), lineId, 2, await movement(b.variantId, 2, 'restock', b.operationId)), 'movement');
    await mismatch(async () => receiptLine(await fresh(), lineId, 2, await movement(other.variantId, 2, 'restock')), 'movement');
    await mismatch(async () => receiptLine(await fresh(), lineId, 2, await movement(b.variantId, 3, 'restock')), 'movement');
    await mismatch(async () => receiptLine(await fresh(), lineId, 2, await movement(b.variantId, 2, 'adjustment')), 'movement');
    await mismatch(async () => receiptLine(await fresh(), lineId, 2, await movement(b.variantId, 2, 'purchase')), 'movement');
    await mismatch(async () => receiptLine(await fresh(), lineId, 2, '999999999999'), 'movement');

    // 別の発注書の明細は、この発注書の受取に結べない
    await mismatch(async () => receiptLine(await fresh(), otherLine, 2, await movement(b.variantId, 2, 'restock')), 'line_order');

    // 負の行（相殺）: 正の行へ結ぶ。負は adjustment の台帳行
    const origin = await receiptLine(await fresh(), lineId, 3, await movement(b.variantId, 3, 'restock'));
    const cancelled = await reverseReceipt(b.orderId, b.operationId);
    await receiptLine(cancelled, lineId, -1, await movement(b.variantId, -1, 'adjustment'), origin);
    await mismatch(async () => receiptLine(await reverseReceipt(b.orderId, b.operationId), lineId, -1, await movement(b.variantId, -1, 'restock'), origin), 'movement');
    await mismatch(async () => receiptLine(await reverseReceipt(b.orderId, b.operationId), lineId, -1, await movement(b.variantId, -1, 'adjustment', b.operationId), origin), 'movement');
  });

  test('FREQ-529-AC-01: 負の受取行は同じ発注書の同じ明細の、受取（receive）の中の正の行にしか結べない', async () => {
    const b = await base();
    const second = await addItemVariant(db(), { itemId: b.itemId, colorName: 'WHITE', sizeLabel: 'L', stock: 20 });
    const lineId = await line(b.orderId, b.variantId, { confirmed_quantity: 10 });
    const sibling = await line(b.orderId, second.variantId, { line_no: 2, confirmed_quantity: 10 });
    const otherOrder = await order();
    const otherLine = await line(otherOrder, b.variantId, { confirmed_quantity: 10 });
    const mismatch = (run: () => Promise<unknown>) => rejected(run, MISMATCH, '23514', 'reverses');
    const negative = async (against: string | null, receiptId?: string) =>
      receiptLine(receiptId ?? await reverseReceipt(b.orderId, b.operationId), lineId, -1, await movement(b.variantId, -1, 'adjustment'), against);

    const receiveReceipt = await receipt(b.orderId, b.operationId);
    const origin = await receiptLine(receiveReceipt, lineId, 3, await movement(b.variantId, 3, 'restock'));
    const siblingOrigin = await receiptLine(await receipt(b.orderId, b.operationId), sibling, 3, await movement(second.variantId, 3, 'restock'));
    const otherOrigin = await receiptLine(await receipt(otherOrder, b.operationId), otherLine, 3, await movement(b.variantId, 3, 'restock'));

    const valid = await negative(origin);
    expect(valid).toBeTruthy();
    await mismatch(() => negative(siblingOrigin));
    await mismatch(() => negative(otherOrigin));
    await mismatch(() => negative(valid));
    await mismatch(() => negative(randomUUID()));

    // 相殺の受取（reverse）の中の正の行を相殺元にはできない
    const inReverse = await reverseReceipt(b.orderId, b.operationId);
    const positiveInReverse = await receiptLine(inReverse, lineId, 1, await movement(b.variantId, 1, 'restock'));
    await mismatch(() => negative(positiveInReverse));
  });

  test('FREQ-529-AC-01: 1 つの正の行への相殺の合計が元の数量を超えると commit で GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED / 23514', async () => {
    const b = await base();
    const exceeds = (run: () => Promise<unknown>) => rejected(async () => { await run(); await immediate(); }, 'GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED', '23514', 'reverse');

    /** 正の受取（数量の並び）と、i 番目の正の行への相殺（数量）を作る。納品数は合計に合わせる */
    async function scenario(positives: number[], reversals: Array<[number, number]>) {
      const orderId = await order();
      const received = positives.reduce((sum, value) => sum + value, 0) - reversals.reduce((sum, [, value]) => sum + value, 0);
      const lineId = await line(orderId, b.variantId, { confirmed_quantity: 50, received_quantity: received });
      const origins: string[] = [];
      for (const quantity of positives) origins.push(await receiptLine(await receipt(orderId, b.operationId), lineId, quantity, await movement(b.variantId, quantity, 'restock')));
      for (const [index, quantity] of reversals) {
        await receiptLine(await reverseReceipt(orderId, b.operationId), lineId, -quantity, await movement(b.variantId, -quantity, 'adjustment'), origins[index]);
      }
    }

    // 元が 3 と 2（合計 5）。3 の行を 4 で相殺すると、納品数（1）は合っても超過
    await exceeds(() => scenario([3, 2], [[0, 4]]));
    // 3 の行を 2 と 2 に分けて相殺しても合計 4 で超過
    await exceeds(() => scenario([3, 2], [[0, 2], [0, 2]]));
    // ちょうど元の数量まで（全部の相殺、2 回に分けた相殺）は通る
    await scenario([3, 2], [[0, 3]]);
    await scenario([3, 2], [[0, 1], [0, 2]]);
    await scenario([3, 2], [[0, 3], [1, 2]]);
    await flush();
  });

  // ---- 権限・RLS・所有者 ----

  test('FREQ-530-AC-01: 9 表は RLS・所有者 postgres・拒否だけの restrictive な方針を持ち、PUBLIC / anon / authenticated は列権限を含め何も持たず、service_role は 2 表の SELECT だけを持つ（MAINTAIN を含めて意味で比較）', async () => {
    const maintain = (await db().query("select current_setting('server_version_num')::int >= 170000 as has")).rows[0].has as boolean;
    const tablePrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', ...(maintain ? ['MAINTAIN'] : [])];

    for (const table of TABLES) {
      const relation = (await db().query(
        `select c.relkind::text as kind, c.relrowsecurity as rls, pg_get_userbyid(c.relowner) as owner,
                exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0) as public_grant
         from pg_class c where c.oid = $1::regclass`,
        [`public.${table}`],
      )).rows[0];
      expect({ table, ...relation }).toEqual({ table, kind: 'r', rls: true, owner: 'postgres', public_grant: false });

      const policies = (await db().query(
        `select p.polname as name, p.polpermissive as permissive, p.polcmd::text as command,
                array(select r.rolname::text from pg_roles r where r.oid = any (p.polroles) order by 1) as roles,
                pg_get_expr(p.polqual, p.polrelid) as using_expr, pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
         from pg_policy p where p.polrelid = $1::regclass`,
        [`public.${table}`],
      )).rows;
      expect({ table, policies }).toEqual({
        table,
        policies: [{ name: 'deny direct client access', permissive: false, command: '*', roles: ['anon', 'authenticated'], using_expr: 'false', check_expr: 'false' }],
      });

      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const privilege of tablePrivileges) {
          const allowed = (await db().query('select has_table_privilege($1, $2::regclass, $3) as allowed', [role, `public.${table}`, privilege])).rows[0].allowed;
          expect({ table, role, privilege, allowed }).toEqual({
            table, role, privilege, allowed: role === 'service_role' && privilege === 'SELECT' && SERVICE_READABLE.includes(table),
          });
        }
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed = (await db().query('select has_any_column_privilege($1, $2::regclass, $3) as allowed', [role, `public.${table}`, privilege])).rows[0].allowed;
          expect({ table, role, privilege, column: true, allowed }).toEqual({
            table, role, privilege, column: true, allowed: role === 'service_role' && privilege === 'SELECT' && SERVICE_READABLE.includes(table),
          });
        }
      }
      for (const privilege of tablePrivileges.filter((name) => name !== 'MAINTAIN')) {
        expect((await db().query('select has_table_privilege(\'postgres\', $1::regclass, $2) as allowed', [`public.${table}`, privilege])).rows[0].allowed).toBe(true);
      }
    }
  });

  test('FREQ-530-AC-01: anon / authenticated / service_role は 9 表を直接書けず、読めるのは service_role の 2 表だけ（42501）', async () => {
    const g = await graph();
    const ids: Record<string, string> = {
      purchase_orders: g.orderId, purchase_order_lines: g.lineId, purchase_order_revisions: g.revisionId,
      purchase_order_short_closures: g.closureId, purchase_order_receipts: g.receiptId, purchase_order_receipt_lines: g.receiptLineId,
      purchase_order_attachment_reservations: g.reservationId, purchase_order_attachments: g.attachmentId,
      purchase_order_attachment_revisions: g.attachmentRevisionId,
    };

    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of TABLES) {
        const read = await attempt(role, `select count(*)::int as n from public.${table}`);
        if (role === 'service_role' && SERVICE_READABLE.includes(table)) {
          expect({ role, table, read }).toEqual({ role, table, read: { rows: [{ n: 1 }], rowCount: 1 } });
        } else {
          expect({ role, table, read }).toEqual({ role, table, read: { code: '42501' } });
        }
        for (const sql of [
          `insert into public.${table} default values`,
          `update public.${table} set created_at = created_at where id = '${ids[table]}'`,
          `delete from public.${table} where id = '${ids[table]}'`,
          `truncate public.${table}`,
        ]) {
          expect({ role, sql, outcome: await attempt(role, sql) }).toEqual({ role, sql, outcome: { code: '42501' } });
        }
      }
    }
  });

  test('FREQ-530-AC-01: 3 つの trigger 関数は postgres の物で search_path が空、PUBLIC・anon・authenticated・service_role の EXECUTE が無い', async () => {
    for (const fn of FUNCTIONS) {
      const row = (await db().query(
        `select p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
         from pg_proc p where p.oid = $1::regprocedure`,
        [fn.signature],
      )).rows[0];
      expect({ signature: fn.signature, ...row }).toEqual({
        signature: fn.signature, definer: fn.definer, owner: 'postgres', config: ['search_path=""'], public_execute: false,
      });
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const allowed = (await db().query("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, fn.signature])).rows[0].allowed;
        expect({ signature: fn.signature, role, allowed }).toEqual({ signature: fn.signature, role, allowed: false });
      }
    }
  });

  // ---- 非公開 bucket ----

  describe('bucket purchase-order-documents', () => {
    // 断られた（権限の誤り）か、行が 1 つも見えないかのどちらかなら「触れない」とみなす
    function untouched(outcome: Outcome): 'untouched' | Outcome {
      if ('code' in outcome) return outcome.code === '42501' ? 'untouched' : outcome;
      return outcome.rowCount === 0 ? 'untouched' : outcome;
    }
    const objectPath = () => `${randomUUID()}/${randomUUID()}.pdf`;
    async function insertObject(): Promise<string> {
      const res = await db().query(
        `insert into storage.objects (bucket_id, name, metadata)
         values ($1, $2, jsonb_build_object('mimetype', 'application/pdf', 'size', 1)) returning id`,
        [BUCKET, objectPath()],
      );
      return res.rows[0].id as string;
    }
    const visitors: Array<[string, string]> = [['anon', 'anon'], ['ログイン中の人', 'authenticated']];

    test('FREQ-530-AC-01: 非公開で、1 つの物は 20 MiB まで、種類は PDF・JPEG・PNG だけ', async () => {
      const res = await db().query('select id, name, public, file_size_limit::text as size, allowed_mime_types from storage.buckets where id = $1', [BUCKET]);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ id: BUCKET, name: BUCKET, public: false, size: '20971520' });
      expect([...(res.rows[0].allowed_mime_types as string[])].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    });

    test('FREQ-530-AC-01: storage.objects にこの bucket の方針を作らない', async () => {
      const res = await db().query(
        `select count(*)::int as n from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and (coalesce(qual, '') like '%purchase-order-documents%' or coalesce(with_check, '') like '%purchase-order-documents%')`,
      );
      expect(res.rows[0].n).toBe(0);
    });

    test.each(visitors)('FREQ-530-AC-01: %s は bucket の物を読めず、直せず、消せず、足せない', async (_label, role) => {
      const id = await insertObject();

      expect(untouched(await attempt(role, 'select id from storage.objects where id = $1', [id]))).toBe('untouched');
      expect(untouched(await attempt(role, 'select id from storage.objects where bucket_id = $1', [BUCKET]))).toBe('untouched');
      expect(untouched(await attempt(role, 'update storage.objects set metadata = metadata where id = $1 returning id', [id]))).toBe('untouched');
      // 直接の削除は置き場の側が別の記号で断ることもあるので、「1 行も消えない」ことだけを見る
      const deleted = await attempt(role, 'delete from storage.objects where id = $1 returning id', [id]);
      expect('rows' in deleted ? deleted.rowCount : 0).toBe(0);
      expect(await attempt(role, 'insert into storage.objects (bucket_id, name) values ($1, $2) returning id', [BUCKET, objectPath()]))
        .toEqual({ code: '42501' });
    });

    test('FREQ-530-AC-01: service role は bucket の物を読める', async () => {
      const id = await insertObject();

      expect(await attempt('service_role', 'select id, bucket_id from storage.objects where id = $1', [id]))
        .toEqual({ rows: [{ id, bucket_id: BUCKET }], rowCount: 1 });
    });
  });

  // ---- 移行の最後の確かめ ----

  describe('移行の最後の確かめ', () => {
    const OBJECTS = finalAssertBlock('$g2a_final_objects$');
    const ACL = finalAssertBlock('$g2a_final_table_acl$');

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
    const failed = (detail: string) => ({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });

    /** 変更を取引の中で当ててから確かめを流す（確かめの後で savepoint まで戻すので、変更も戻る） */
    async function runAfter(sql: string, block: string) {
      await db().query('savepoint tamper');
      try {
        await db().query(sql);
        return await run(block);
      } finally {
        await db().query('rollback to savepoint tamper');
        await db().query('release savepoint tamper');
      }
    }

    test('FREQ-530-AC-01: 今の DB で通る', async () => {
      expect(await run(OBJECTS)).toBeNull();
      expect(await run(ACL)).toBeNull();
    });

    test.each([
      ['RLS を外す', 'alter table public.purchase_orders disable row level security', 'purchase_tables'],
      ['行を 1 つ足す', "insert into public.purchase_orders (number, supplier_name, created_by) values ('PO-20261025-0001', 'S', gen_random_uuid())", 'purchase_table_rows'],
      ['拒否の方針を外す', 'drop policy "deny direct client access" on public.purchase_order_lines', 'purchase_table_policies'],
      ['列を足す', 'alter table public.purchase_orders add column extra integer', 'purchase_table_columns'],
      ['NOT NULL を外す', 'alter table public.purchase_orders alter column supplier_name drop not null', 'purchase_table_columns'],
      ['CHECK を外す', 'alter table public.purchase_orders drop constraint purchase_orders_stage_check', 'purchase_table_constraints'],
      ['受取行の符号の CHECK を外す', 'alter table public.purchase_order_receipt_lines drop constraint purchase_order_receipt_lines_reverses_check', 'purchase_table_constraints'],
      [
        'NULL を同じ値と見ない一意に替える',
        `alter table public.purchase_order_revisions drop constraint purchase_order_revisions_revision_key,
           add constraint purchase_order_revisions_revision_key unique (purchase_order_id, revision_no, line_id, kind)`,
        'purchase_table_constraints',
      ],
      [
        '外部キーを CASCADE にする',
        `alter table public.purchase_order_lines drop constraint purchase_order_lines_variant_id_fkey,
           add constraint purchase_order_lines_variant_id_fkey foreign key (variant_id) references public.item_variants (id) on delete cascade`,
        'purchase_table_constraints',
      ],
      [
        '操作の受付への外部キーを遅延でなくす',
        `alter table public.purchase_order_receipts drop constraint purchase_order_receipts_operation_id_fkey,
           add constraint purchase_order_receipts_operation_id_fkey foreign key (operation_id) references private.group_g_operations (id) on delete restrict`,
        'purchase_table_constraints',
      ],
      ['索引を消す', 'drop index public.purchase_order_receipt_lines_line_idx', 'purchase_table_indexes'],
      ['trigger を消す', 'drop trigger purchase_orders_change_guard on public.purchase_orders', 'purchase_table_triggers'],
      ['trigger を止める', 'alter table public.purchase_order_receipt_lines disable trigger purchase_order_receipt_lines_check_line', 'purchase_table_triggers'],
      ['追記専用の trigger を消す', 'drop trigger purchase_order_attachments_no_truncate on public.purchase_order_attachments', 'purchase_table_triggers'],
      ['関数の search_path を変える', "alter function private.guard_group_g_purchase_order_change() set search_path = public", 'purchase_functions'],
      ['関数の EXECUTE を authenticated に付ける', 'grant execute on function private.check_purchase_order_line_received() to authenticated', 'purchase_functions'],
      ['bucket を公開にする', "update storage.buckets set public = true where id = 'purchase-order-documents'", 'purchase_bucket'],
      ['bucket の大きさの上限を変える', "update storage.buckets set file_size_limit = 1048576 where id = 'purchase-order-documents'", 'purchase_bucket'],
      ['bucket の種類を変える', "update storage.buckets set allowed_mime_types = array['application/pdf'] where id = 'purchase-order-documents'", 'purchase_bucket'],
    ])('FREQ-530-AC-01: %s と止まる', async (_name, sql, detail) => {
      expect(await runAfter(sql, OBJECTS)).toEqual(failed(detail));
    });

    test.each([
      ['anon に SELECT を付ける', 'grant select on public.purchase_orders to anon'],
      ['authenticated に列の SELECT を付ける', 'grant select (id) on public.purchase_order_lines to authenticated'],
      ['PUBLIC に SELECT を付ける', 'grant select on public.purchase_orders to public'],
      ['service_role に読めない表の SELECT を付ける', 'grant select on public.purchase_order_revisions to service_role'],
      ['service_role に INSERT を付ける', 'grant insert on public.purchase_order_attachments to service_role'],
      ['service_role の SELECT を 2 表から外す', 'revoke select on public.purchase_order_attachments from service_role'],
      ['postgres の権限を外す', 'revoke update on public.purchase_orders from postgres'],
    ])('FREQ-530-AC-01: %s と止まる（表の権限）', async (_name, sql) => {
      expect(await runAfter(sql, ACL)).toEqual(failed('purchase_table_acl'));
    });

    test('FREQ-530-AC-01: PostgreSQL 17 以降は MAINTAIN も「無い」の一覧に入る', async () => {
      const maintain = (await db().query("select current_setting('server_version_num')::int >= 170000 as has")).rows[0].has as boolean;
      if (!maintain) return;
      expect(await runAfter('grant maintain on public.purchase_orders to anon', ACL)).toEqual(failed('purchase_table_acl'));
    });
  });
});
