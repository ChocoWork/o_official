/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { seedGroupG1Allocation } from './helpers/group-g1-fixtures';
import { G3D_ALLOWLIST } from './helpers/group-g-allowlist';
import {
  createPurchaseFlow, CONFLICT, EXCEEDS_REMAINING, FORBIDDEN, INVALID, NOT_CONFIRMED, NOT_FOUND, RECEIVED_ON_INVALID, VERSION_CONFLICT,
} from './helpers/purchase-order-flow';

/**
 * G-2 Task 7（FREQ-529・FREQ-525-AC-01・FREQ-540-AC-07）: 発注書の受け取り private.admin_receive_purchase_order と公開入口。
 * 全部・一部・後日の受け取りで、台帳（restock・無タグ）・受取・受取行・納品済み・未納・空き在庫・FIFO の割当・状態の履歴・操作の記録が
 * 同じ取引で保存され、1行でも不正なら何も残らない。同じ request_key と同じ内容の再送で在庫は二重に増えない。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const files = (suffix: string) => fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith(suffix));
const WRITERS_FILE = files('_group_g2_purchasing_writers.sql');
const G1_FILE = files('_group_g1_allocation.sql');
const WRITERS_SQL = WRITERS_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, WRITERS_FILE[0]), 'utf8') : '';
const G1_SQL = G1_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, G1_FILE[0]), 'utf8') : '';

const RECEIVE_SIGNATURE = 'admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)';
const REVERSE_SIGNATURE = 'admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** コメントの行を外した本文（コメント内の語を拾わないため） */
const withoutComments = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const CODE = withoutComments(WRITERS_SQL);

/** CREATE FUNCTION <name>( から、その ALTER FUNCTION までの本文 */
function functionText(code: string, createPrefix: string, alterPrefix: string): string {
  const start = code.indexOf(createPrefix);
  const end = code.indexOf(alterPrefix, start);
  return start >= 0 && end > start ? code.slice(start, end) : '';
}
const RECEIVE_TEXT = functionText(CODE, 'CREATE FUNCTION private.admin_receive_purchase_order(', 'ALTER FUNCTION private.admin_receive_purchase_order(');

/** 書き手の一覧の中の署名 */
function allowlistOf(code: string, createPrefix: string): string[] {
  const create = code.indexOf(createPrefix);
  const start = create < 0 ? -1 : code.indexOf('SELECT ARRAY[', create);
  const end = code.indexOf(']::pg_catalog.regprocedure[]', start);
  return start >= 0 && end > start ? [...code.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
}

describe('G-2 writers migration の受け取りの節（DB なし）', () => {
  const PERMISSION = "private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.receiving.manage', 'admin.purchase_orders.read'])";

  test('FREQ-529-AC-01: 処理順は 引数検証 → ロック helper（在庫あり）→ 権限 → 指紋と再送 → 存在 → 段階 → 版 → 受取日 → 行 → 超過 → 状態の保存 → 受取 → 台帳 → 受取行 → FIFO → 履歴 → 操作の記録', () => {
    expect(RECEIVE_TEXT).not.toBe('');
    expect(RECEIVE_TEXT).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
    const positions = [
      RECEIVE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'"),
      RECEIVE_TEXT.indexOf('v_orders := private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], true);'),
      RECEIVE_TEXT.indexOf(PERMISSION),
      RECEIVE_TEXT.indexOf("op.operation = 'purchase_order_receive' AND op.request_key = _request_key"),
      RECEIVE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002'"),
      RECEIVE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_NOT_CONFIRMED' USING ERRCODE = '55000'"),
      RECEIVE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_VERSION_CONFLICT' USING ERRCODE = '55000'"),
      RECEIVE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_RECEIVED_ON_INVALID' USING ERRCODE = '22023'"),
      RECEIVE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING' USING ERRCODE = '23514'"),
      RECEIVE_TEXT.indexOf('v_before := private.capture_group_g_item_states(v_orders);'),
      RECEIVE_TEXT.indexOf("PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);"),
      RECEIVE_TEXT.indexOf('INSERT INTO public.purchase_order_receipts('),
      RECEIVE_TEXT.indexOf('INSERT INTO public.stock_movements('),
      RECEIVE_TEXT.indexOf('INSERT INTO public.purchase_order_receipt_lines('),
      RECEIVE_TEXT.indexOf('UPDATE public.purchase_order_lines SET'),
      RECEIVE_TEXT.indexOf('UPDATE public.purchase_orders SET'),
      RECEIVE_TEXT.indexOf('private.allocate_group_g_fifo(v_variants, v_operation, _actor_id)'),
      RECEIVE_TEXT.indexOf("private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'purchase_order_receive', _actor_id)"),
      RECEIVE_TEXT.indexOf('INSERT INTO private.group_g_operations('),
    ];
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // 本体で最初に public / private の物に触れるのがロック helper の呼び出し（引数検証は表を読まない）
    const body = RECEIVE_TEXT.slice(RECEIVE_TEXT.indexOf('\nBEGIN\n'));
    expect(body.search(/\b(?:public|private)\./)).toBe(body.indexOf('private.lock_group_g_purchase_orders('));
    // 指紋に版を入れない（版が進んだ後の再送が同じ結果を返す）
    const fingerprint = RECEIVE_TEXT.slice(RECEIVE_TEXT.indexOf('v_fingerprint := '), RECEIVE_TEXT.indexOf("'hex');"));
    expect(fingerprint).toContain("'operation', 'purchase_order_receive'");
    expect(fingerprint).not.toMatch(/version/i);
    expect(fingerprint).toContain("'actor_id', _actor_id");
    // app.group_g_operation_id は退避し、成功でも失敗でも元に戻す
    expect(RECEIVE_TEXT).toContain("v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);");
    expect(RECEIVE_TEXT.match(/set_config\('app\.group_g_operation_id', COALESCE\(v_previous_operation, ''\), true\)/g)).toHaveLength(2);
    expect(RECEIVE_TEXT).toContain('EXCEPTION WHEN OTHERS THEN');
  });

  test('FREQ-529-AC-01: 台帳の入庫は restock・allocation_operation_id なし（無タグ）・備考は 発注番号 + の受け取り。タグを付けるのは FIFO だけ。書く表は決まった物だけ', () => {
    const insertLedger = RECEIVE_TEXT.slice(RECEIVE_TEXT.indexOf('INSERT INTO public.stock_movements('), RECEIVE_TEXT.indexOf('INSERT INTO public.purchase_order_receipt_lines('));
    expect(insertLedger).toContain('INSERT INTO public.stock_movements(variant_id, delta, reason, note, created_by)');
    expect(insertLedger).toContain("'restock'");
    expect(insertLedger).toContain("U&'\\767A\\6CE8 ' || v_order.number || U&' \\306E\\53D7\\3051\\53D6\\308A'");
    expect(RECEIVE_TEXT).not.toContain('allocation_operation_id');
    expect(RECEIVE_TEXT).not.toMatch(/\b(DELETE|TRUNCATE|MERGE)\b/);
    expect(RECEIVE_TEXT).not.toMatch(/\b(order_item_allocations|order_item_allocation_events|order_item_state_events|stock_quantity)\b/);
    expect(RECEIVE_TEXT).not.toMatch(/\bpublic\.orders\b/);
    const writes = [...RECEIVE_TEXT.matchAll(/\b(INSERT INTO|UPDATE) ([a-z_.]+)/g)].map((match) => `${match[1]} ${match[2]}`);
    expect(writes).toEqual([
      'INSERT INTO public.purchase_order_receipts', 'INSERT INTO public.stock_movements', 'INSERT INTO public.purchase_order_receipt_lines',
      'UPDATE public.purchase_order_lines', 'UPDATE public.purchase_orders', 'INSERT INTO private.group_g_operations',
    ]);
    // FIFO は受け取った variant だけを名指しする（発注書の全行ではない）
    expect(RECEIVE_TEXT).toContain('v_variants := v_variants || v_line.variant_id;');
    expect(RECEIVE_TEXT).toContain("'allocatedQuantity', v_allocated");
  });

  test('FREQ-540-AC-07: private 本体と public 入口は service_role だけに EXECUTE を渡し、PUBLIC / anon / authenticated を個別に外す。public 入口は SQL の INVOKER 委譲', () => {
    for (const signature of [RECEIVE_SIGNATURE, REVERSE_SIGNATURE]) {
      for (const schema of ['private', 'public']) {
        expect(CODE).toContain(`ALTER FUNCTION ${schema}.${signature} OWNER TO postgres;`);
        expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${schema}.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
        expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO service_role;`);
      }
    }
    const delegate = functionText(CODE, 'CREATE FUNCTION public.admin_receive_purchase_order(', 'ALTER FUNCTION public.admin_receive_purchase_order(');
    expect(delegate).toContain("LANGUAGE sql SECURITY INVOKER SET search_path = ''");
    expect(delegate).toContain('SELECT private.admin_receive_purchase_order(_purchase_order_id, _expected_version, _received_on, _memo, _lines, _actor_id, _request_key);');
    expect(CODE).not.toMatch(/ON SCHEMA\s+private/i);
  });

  test('FREQ-540-AC-07: 書き手の一覧は G-1 の56本を1文字も変えず、末尾に 作成・Task 6 の3本・受け取り・受け取りの取消・Task 8 の原本の3本を足した65本。最後の確かめも65本を見る', () => {
    const g1 = allowlistOf(withoutComments(G1_SQL), 'CREATE FUNCTION private.group_g_writer_allowlist()');
    const next = allowlistOf(CODE, 'CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()');
    expect(g1).toHaveLength(56);
    expect(next).toEqual([
      ...g1,
      'private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)',
      'private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)',
      'private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)',
      'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
      `private.${RECEIVE_SIGNATURE}`,
      `private.${REVERSE_SIGNATURE}`,
      'private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)',
      'private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)',
      'private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)',
    ]);
    expect(new Set(next).size).toBe(65);
    const section = WRITERS_SQL.slice(WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_BEGIN'), WRITERS_SQL.indexOf('-- G2B_FINAL_ASSERT_END'));
    expect(section).toContain('<> 65');
    expect(section).not.toContain('<> 62');
    expect(section).not.toContain('<> 60');
    for (const signature of [RECEIVE_SIGNATURE, REVERSE_SIGNATURE]) {
      expect(section).toContain(`'private.${signature}'`);
      expect(section).toContain(`'public.${signature}'`);
    }
    expect(section).toContain("('public.purchase_order_receipts')");
    expect(section).toContain("('public.purchase_order_receipt_lines')");
  });

  test('FREQ-529-AC-01: 移行は UTF-8・BOMなし・LF・ASCII のみで、BEGIN / COMMIT / 通知を1組だけ持つ', () => {
    expect(WRITERS_SQL.charCodeAt(0)).not.toBe(0xfeff);
    expect(WRITERS_SQL).not.toContain('\r');
    expect(WRITERS_SQL).toMatch(/^[\x00-\x7f]*$/);
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE.match(/NOTIFY pgrst, 'reload schema';/g)).toHaveLength(1);
  });
});

describeLocalDb('integration: G-2 受け取り', (db) => {
  const flow = createPurchaseFlow(db);
  const {
    createActor, grant, revoke, rejected, flush, today, linesOf, orderRow, receive, receiveLines, setup, waitingOrder, totals, allocated,
    snapshot, operationOf, receiptsOf, receiptLinesOf, movement, stageOf, shortClose,
  } = flow;

  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  // ---- FREQ-529-AC-01: 全部・一部・後日 ----

  test('FREQ-529-AC-01: 全部受け取りで restock(+q・備考 発注 PO-… の受け取り・allocation_operation_id IS NULL)・受取・受取行(台帳id)・納品済み・未納0・空き在庫・版が一度に保存される', async () => {
    const s = await setup([4, 3]);
    const before = await snapshot();
    const key = randomUUID();

    const result = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, memo: '午前便', lines: receiveLines(s.lines, [4, 3]) });
    expect(result).toEqual({ receiptId: expect.stringMatching(UUID_PATTERN), version: s.version + 1, allocatedQuantity: 0, replayed: false });

    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.received_quantity, line.outstanding_quantity, line.version]))
      .toEqual([[4, 4, 0, 3], [3, 3, 0, 3]]);
    expect(await orderRow(s.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: s.version + 1 });

    const receipts = await receiptsOf(s.order.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: result.receiptId, kind: 'receive', received_on: await today(), memo: '午前便', reason: null, actor_id: s.actor });
    const receiptLines = await receiptLinesOf(result.receiptId);
    expect(receiptLines.map((row) => [row.line_id, row.quantity, row.reverses_receipt_line_id])).toEqual([[s.lines[0].id, 4, null], [s.lines[1].id, 3, null]]);
    for (const [index, row] of receiptLines.entries()) {
      expect(await movement(row.stock_movement_id)).toEqual({
        id: row.stock_movement_id, variant_id: s.lines[index].variant_id, delta: [4, 3][index], reason: 'restock',
        note: `発注 ${s.order.number} の受け取り`, order_id: null, order_item_id: null, allocation_operation_id: null, created_by: s.actor,
      });
    }
    expect(await totals(s.lines[0].variant_id)).toEqual({ f: 4, a: 0, h: 0 });
    expect(await totals(s.lines[1].variant_id)).toEqual({ f: 3, a: 0, h: 0 });

    const operations = await operationOf('purchase_order_receive', key);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      cause_type: 'purchase_order', cause_id: s.order.id, actor_id: s.actor,
      result: { receiptId: result.receiptId, version: s.version + 1, allocatedQuantity: 0, replayed: false },
    });
    expect(operations[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const after = await snapshot();
    expect(after).toMatchObject({
      orders: before.orders, lines: before.lines, receipts: before.receipts + 1, receipt_lines: before.receipt_lines + 2,
      movements: before.movements + 2, operations: before.operations + 1, allocations: before.allocations,
      allocation_events: before.allocation_events, state_events: before.state_events,
    });
    expect(await stageOf(s.actor, s.order.id)).toBe('received');
  });

  test('FREQ-529-AC-01: 古い待ち注文2件(各2点)に2点入庫すると古い方だけ ready(A=2)、割当イベントの理由は fifo。FIFO の purchase 行だけがタグ付き、入庫の restock は無タグ', async () => {
    const s = await setup([2]);
    const c = s.fixtures[0];
    const old = await waitingOrder(c, 2, '2025-12-01T00:00:00Z');
    const young = await waitingOrder(c, 2, '2026-01-01T00:00:00Z');
    const key = randomUUID();

    const result = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, lines: receiveLines(s.lines, [2]) });
    expect(result.allocatedQuantity).toBe(2);
    expect([await allocated(old.line), await allocated(young.line)]).toEqual([2, 0]);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 2, h: 0 });

    const operationId = (await operationOf('purchase_order_receive', key))[0].id as string;
    const ledger = (await db().query(
      'select reason, delta, order_item_id, allocation_operation_id from public.stock_movements where variant_id = $1 order by id', [c.variantId])).rows;
    expect(ledger).toEqual([
      { reason: 'restock', delta: 2, order_item_id: null, allocation_operation_id: null },
      { reason: 'purchase', delta: -2, order_item_id: old.line, allocation_operation_id: operationId },
    ]);
    const events = (await db().query(`select e.event_type, e.quantity, e.reason, e.operation_id, a.kind from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id = e.allocation_id where a.order_item_id = any($1::uuid[]) order by e.stock_movement_id`,
    [[old.line, young.line]])).rows;
    expect(events).toEqual([{ event_type: 'allocate', quantity: 2, reason: 'fifo', operation_id: operationId, kind: 'paid' }]);
    const states = (await db().query(`select order_item_id, from_status, to_status, quantity, reason from public.order_item_state_events
      where operation_id = $1 order by order_item_id`, [operationId])).rows;
    expect(states).toEqual([{ order_item_id: old.line, from_status: 'in_production', to_status: 'ready', quantity: 2, reason: 'purchase_order_receive' }]);
    expect((await db().query('select * from public.verify_stock_integrity() where variant_id = $1', [c.variantId])).rows).toEqual([]);
  });

  test('FREQ-529-AC-01: 案A: 買い手本人の仮確保(H)は奪われない。待っている支払い済みの古い注文へだけ割り当たる', async () => {
    const s = await setup([2], { stocks: [3] });
    const c = s.fixtures[0];
    const pending = await waitingOrder(c, 3, '2026-01-01T00:00:00Z', 'pending');
    await seedGroupG1Allocation(db(), { orderItemId: pending.line, quantity: 3, kind: 'payment_hold' });
    const old = await waitingOrder(c, 2, '2025-12-01T00:00:00Z');
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 3 });

    const result = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [2]) });
    expect(result.allocatedQuantity).toBe(2);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 2, h: 3 });
    expect(await allocated(pending.line)).toBe(3);
    expect((await db().query("select kind, remaining_quantity from public.order_item_allocations where order_item_id = $1", [pending.line])).rows)
      .toEqual([{ kind: 'payment_hold', remaining_quantity: 3 }]);
    expect(await allocated(old.line)).toBe(2);
  });

  test('FREQ-529-AC-01: FIFO に回すのは受け取った variant だけ。発注書の別の行の variant(空き在庫と待ち注文がある)は触らない', async () => {
    const s = await setup([2, 1], { stocks: [0, 5] });
    const [a, c] = s.fixtures;
    const waitingA = await waitingOrder(a, 2, '2026-01-01T00:00:00Z');
    const waitingC = await waitingOrder(c, 2, '2026-01-02T00:00:00Z');
    expect(await totals(c.variantId)).toEqual({ f: 5, a: 0, h: 0 });

    const result = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [2, 0]) });
    expect(result.allocatedQuantity).toBe(2);
    expect(await allocated(waitingA.line)).toBe(2);
    // 受け取っていない行の variant C は、FIFO が回れば待ち注文に 2 点割り当てられてしまう状態のまま動かない
    expect(await allocated(waitingC.line)).toBe(0);
    expect(await totals(c.variantId)).toEqual({ f: 5, a: 0, h: 0 });
  });

  test('FREQ-529-AC-01: 一部を受け取り、後日に残りを受け取ると、納品済み・未納・段階が正しく進み、2回目も FIFO が動く', async () => {
    const s = await setup([5]);
    const c = s.fixtures[0];
    const waiting = await waitingOrder(c, 3, '2026-01-01T00:00:00Z');

    const first = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, memo: '一便', lines: receiveLines(s.lines, [2]) });
    expect(first).toMatchObject({ version: s.version + 1, allocatedQuantity: 2 });
    expect((await linesOf(s.order.id))[0]).toMatchObject({ confirmed_quantity: 5, received_quantity: 2, outstanding_quantity: 3, version: 3 });
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');
    expect(await allocated(waiting.line)).toBe(2);

    const second = await receive({ actor: s.actor, orderId: s.order.id, version: first.version, receivedOn: await today(), memo: '二便', lines: receiveLines(s.lines, [3]) });
    expect(second).toMatchObject({ version: first.version + 1, allocatedQuantity: 1 });
    expect((await linesOf(s.order.id))[0]).toMatchObject({ received_quantity: 5, outstanding_quantity: 0, version: 4 });
    expect(await stageOf(s.actor, s.order.id)).toBe('received');
    expect(await allocated(waiting.line)).toBe(3);
    // 5 点入庫、3 点が待っていた注文へ。残りの 2 点が空き在庫
    expect(await totals(c.variantId)).toEqual({ f: 2, a: 3, h: 0 });
    const receipts = await receiptsOf(s.order.id);
    expect(receipts.map((row) => [row.kind, row.memo])).toEqual([['receive', '一便'], ['receive', '二便']]);
    expect(first.receiptId).not.toBe(second.receiptId);
  });

  test('FREQ-529-AC-01: 受取日は発注日から今日(JST)まで。今日そのもの・発注日そのものは通り、前日と翌日は GROUP_G_PO_RECEIVED_ON_INVALID', async () => {
    const s = await setup([3]);
    const before = await snapshot();
    // 発注日 = 今日(この試験の取引の中で作った物)。前日は発注日より前、翌日は今日より後
    for (const offset of [-1, 1]) {
      const receivedOn = await today(offset);
      expect(await rejected(() => receive({ actor: s.actor, orderId: s.order.id, version: s.version, receivedOn, lines: receiveLines(s.lines, [1]) })))
        .toEqual(RECEIVED_ON_INVALID);
    }
    expect(await snapshot()).toEqual(before);
    const result = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, receivedOn: await today(), lines: receiveLines(s.lines, [1]) });
    expect((await receiptsOf(s.order.id))[0].received_on).toBe(await today());
    expect(result.version).toBe(s.version + 1);
  });

  // ---- FREQ-529-AC-02: 再送 ----

  test('FREQ-529-AC-02: 同じ request_key と同じ内容の再送は同じ受取・replayed:true・在庫/台帳/割当の増加0。版が進んだ後・行の並びが違っても同じ。同じキーで内容が違えば GROUP_G_REQUEST_KEY_CONFLICT', async () => {
    const s = await setup([5, 3]);
    const c = s.fixtures[0];
    await waitingOrder(c, 1, '2026-01-01T00:00:00Z');
    const key = randomUUID();
    const lines = receiveLines(s.lines, [2, 1]);
    const first = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, memo: '午前便', lines });
    expect(first.replayed).toBe(false);
    const stored = await snapshot();

    expect(await receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, memo: '午前便', lines }))
      .toEqual({ ...first, replayed: true });
    // 行の並びを逆にしても同じ内容(指紋は行を id 順にそろえる)
    expect(await receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, memo: '午前便', lines: [...lines].reverse() }))
      .toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(stored);

    // 別の受け取りで版が進んだ後でも、古い版での再送は保存済みの結果を返す
    const next = await receive({ actor: s.actor, orderId: s.order.id, version: first.version, lines: receiveLines(s.lines, [1, 0]) });
    const afterNext = await snapshot();
    expect(await receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, memo: '午前便', lines })).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(afterNext);
    expect(next.version).toBe(first.version + 1);

    // 同じキーで内容が違う(数量・メモ・受取日・実行者・発注書)
    expect(await rejected(() => receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, memo: '午前便', lines: receiveLines(s.lines, [2, 2]) }))).toEqual(CONFLICT);
    expect(await rejected(() => receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, memo: '午後便', lines }))).toEqual(CONFLICT);
    const another = await createActor(['admin']);
    expect(await rejected(() => receive({ actor: another, orderId: s.order.id, version: s.version, key, memo: '午前便', lines }))).toEqual(CONFLICT);
    expect(await snapshot()).toEqual(afterNext);
  });

  // ---- 拒否: 何も書かない ----

  test('FREQ-529-AC-01: 拒否(数量確定前・未納超過・受取日・版違い・存在しない発注書・他の発注書の行・不正な引数)は、台帳・在庫・割当・納品累計・履歴を1つも動かさない', async () => {
    const s = await setup([5, 3]);
    const other = await setup([2]);
    await waitingOrder(s.fixtures[0], 2, '2026-01-01T00:00:00Z');
    const unconfirmed = await setup([3], { confirm: false });
    const before = await snapshot();
    const base = { actor: s.actor, orderId: s.order.id, version: s.version };
    const one = receiveLines(s.lines, [1, 1]);
    const firstLine = s.lines[0].id;

    expect(await rejected(() => receive({ actor: unconfirmed.actor, orderId: unconfirmed.order.id, version: unconfirmed.version, lines: receiveLines(unconfirmed.lines, [1]) }))).toEqual(NOT_CONFIRMED);
    expect(await rejected(() => receive({ ...base, lines: receiveLines(s.lines, [6, 0]) }))).toEqual(EXCEEDS_REMAINING);
    expect(await rejected(() => receive({ ...base, lines: receiveLines(s.lines, [1, 4]) }))).toEqual(EXCEEDS_REMAINING);
    expect(await rejected(() => receive({ ...base, version: s.version + 1, lines: one }))).toEqual(VERSION_CONFLICT);
    expect(await rejected(() => receive({ ...base, version: s.version - 1, lines: one }))).toEqual(VERSION_CONFLICT);
    expect(await rejected(() => receive({ ...base, orderId: randomUUID(), lines: one }))).toEqual(NOT_FOUND);
    expect(await rejected(() => receive({ ...base, lines: [{ lineId: other.lines[0].id, quantity: 1 }] }))).toEqual(INVALID);
    expect(await rejected(() => receive({ ...base, lines: [{ lineId: randomUUID(), quantity: 1 }] }))).toEqual(INVALID);

    const invalidInputs: Array<[string, Parameters<typeof receive>[0]]> = [
      ['行なし', { ...base, lines: [] }],
      ['行が配列でない', { ...base, lines: { lineId: firstLine, quantity: 1 } }],
      ['行の重複', { ...base, lines: [{ lineId: firstLine, quantity: 1 }, { lineId: firstLine, quantity: 1 }] }],
      ['数量 0', { ...base, lines: [{ lineId: firstLine, quantity: 0 }] }],
      ['数量が負', { ...base, lines: [{ lineId: firstLine, quantity: -1 }] }],
      ['数量が 100000', { ...base, lines: [{ lineId: firstLine, quantity: 100000 }] }],
      ['数量が小数', { ...base, lines: [{ lineId: firstLine, quantity: 1.5 }] }],
      ['数量が文字', { ...base, lines: [{ lineId: firstLine, quantity: '1' }] }],
      ['余分な項目', { ...base, lines: [{ lineId: firstLine, quantity: 1, note: 'x' }] }],
      ['lineId が uuid でない', { ...base, lines: [{ lineId: 'abc', quantity: 1 }] }],
      ['lines が NULL', { ...base, lines: undefined }],
      ['メモが 201 文字', { ...base, lines: one, memo: 'あ'.repeat(201) }],
      ['受取日 NULL', { ...base, lines: one, receivedOn: null }],
      ['版 NULL', { ...base, lines: one, version: null }],
      ['版 0', { ...base, lines: one, version: 0 }],
      ['実行者 NULL', { ...base, lines: one, actor: null }],
      ['発注書 NULL', { ...base, lines: one, orderId: null }],
      ['request_key NULL', { ...base, lines: one, key: null }],
    ];
    for (const [name, args] of invalidInputs) {
      expect({ name, failure: await rejected(() => receive(args)) }).toEqual({ name, failure: INVALID });
    }
    expect(await snapshot()).toEqual(before);

    // 打切り済みの行(未納 0)は受け取れない
    const closed = await setup([3]);
    const closedVersion = await shortClose(closed.actor, closed.order.id, closed.version, [closed.lines[0].id]);
    const beforeClosed = await snapshot();
    expect(await rejected(() => receive({ actor: closed.actor, orderId: closed.order.id, version: closedVersion, lines: receiveLines(closed.lines, [1]) }))).toEqual(EXCEEDS_REMAINING);
    expect(await snapshot()).toEqual(beforeClosed);
  });

  test('FREQ-529-AC-01: 1行が不正なら他の行も含め、台帳・在庫・割当・納品累計・状態の履歴が全て不変(待っている注文があっても FIFO は動かない)', async () => {
    const s = await setup([5, 3]);
    const waiting = await waitingOrder(s.fixtures[0], 4, '2026-01-01T00:00:00Z');
    const before = await snapshot();
    expect(await rejected(() => receive({ actor: s.actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [3, 4]) }))).toEqual(EXCEEDS_REMAINING);
    expect(await snapshot()).toEqual(before);
    expect(await allocated(waiting.line)).toBe(0);
    expect((await linesOf(s.order.id)).map((line) => line.received_quantity)).toEqual([0, 0]);
  });

  // ---- 権限 ----

  test('FREQ-540-AC-07: 受け取りは receiving.manage と purchase_orders.read の両方が要る。manage だけ・read だけ・発注/在庫/items の権限だけ・無効・期限切れ・役割なし・存在しない実行者は 42501', async () => {
    const s = await setup([5]);
    const before = await snapshot();
    const attempt = async (actor: string) => rejected(() => receive({ actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [1]) }));
    const allForbidden = async (actor: string) => expect(await attempt(actor)).toEqual(FORBIDDEN);

    await allForbidden(await createActor(['admin'], { inactive: ['admin'] }));
    await allForbidden(await createActor(['admin'], { expired: ['admin'] }));
    await allForbidden(await createActor([]));
    await allForbidden(randomUUID());

    await grant('supporter', ['admin.items.read', 'admin.items.manage', 'admin.stock.read', 'admin.stock.manage']);
    await allForbidden(await createActor(['supporter']));
    await revoke('supporter', ['admin.items.read', 'admin.items.manage', 'admin.stock.read', 'admin.stock.manage']);
    await grant('supporter', ['admin.purchase_orders.manage', 'admin.purchase_orders.read']);
    await allForbidden(await createActor(['supporter']));
    await revoke('supporter', ['admin.purchase_orders.manage', 'admin.purchase_orders.read']);
    await grant('supporter', ['admin.receiving.manage']);
    await allForbidden(await createActor(['supporter']));
    expect(await snapshot()).toEqual(before);

    // receiving.manage が supporter、read が user にある実行者は、有効な役割の和集合で足りる
    await grant('user', ['admin.purchase_orders.read']);
    const union = await createActor(['supporter', 'user']);
    expect((await receive({ actor: union, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [1]) })).version).toBe(s.version + 1);
  });

  test('FREQ-540-AC-07: 実行者の現在の権限を毎回確かめる。receiving.manage を外すとその場から断られる', async () => {
    const s = await setup([5]);
    await revoke('admin', ['admin.receiving.manage']);
    expect(await rejected(() => receive({ actor: s.actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [1]) }))).toEqual(FORBIDDEN);
  });

  // ---- 途中失敗 ----

  test('FREQ-529-AC-01: 途中失敗(2行目の受取行・FIFO の割当イベント・操作の記録の INSERT に故障を注入)では、台帳・在庫・割当・納品累計・履歴が全部残らず、同じ要求番号は後で作り直せる', async () => {
    const s = await setup([5, 3]);
    const waiting = await waitingOrder(s.fixtures[0], 2, '2026-01-01T00:00:00Z');
    const key = randomUUID();
    const call = () => receive({ actor: s.actor, orderId: s.order.id, version: s.version, key, lines: receiveLines(s.lines, [2, 1]) });
    // 受取行は行の id の昇順に書かれるので、故障は 2 番目に書かれる行(id の大きい方)に仕込む
    const secondWritten = [s.lines[0].id, s.lines[1].id].sort()[1];
    // 表ごとに別の関数にする(plpgsql は NEW の項目を、条件が偽でも解決するため、別の表の項目は書けない)
    await db().query(`create function public.g2_inject_receipt_line_failure() returns trigger language plpgsql as $$
      begin
        if new.line_id = '${secondWritten}'::uuid then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
            detail = (select count(*)::text from public.purchase_order_receipt_lines where receipt_id = new.receipt_id);
        end if;
        return new;
      end $$`);
    await db().query(`create function public.g2_inject_allocation_event_failure() returns trigger language plpgsql as $$
      begin
        raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
          detail = (select count(*)::text from public.purchase_order_receipt_lines where line_id = '${s.lines[0].id}'::uuid);
      end $$`);
    await db().query(`create function public.g2_inject_operation_failure() returns trigger language plpgsql as $$
      begin
        if new.operation = 'purchase_order_receive' then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001', detail = new.operation;
        end if;
        return new;
      end $$`);
    const before = await snapshot();

    // 1) 2行目の受取行で失敗: 1行目の受取行・台帳・納品済みの更新は書かれた後
    await db().query('create trigger g2_inject_receipt_line before insert on public.purchase_order_receipt_lines for each row execute function public.g2_inject_receipt_line_failure()');
    expect(await rejected(call)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '1' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_receipt_line on public.purchase_order_receipt_lines');

    // 2) FIFO の割当イベントで失敗: 受取・台帳・納品済みは全部書かれた後(detail = 書かれた受取行の数)
    await db().query('create trigger g2_inject_allocation_event before insert on public.order_item_allocation_events for each row execute function public.g2_inject_allocation_event_failure()');
    expect(await rejected(call)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '1' });
    expect(await snapshot()).toEqual(before);
    expect(await allocated(waiting.line)).toBe(0);
    await db().query('drop trigger g2_inject_allocation_event on public.order_item_allocation_events');

    // 3) 最後の操作の記録で失敗: 先に書いた物が全部残らない
    await db().query('create trigger g2_inject_operation before insert on private.group_g_operations for each row execute function public.g2_inject_operation_failure()');
    expect(await rejected(call)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: 'purchase_order_receive' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_operation on private.group_g_operations');

    // 同じ要求番号で後から作り直せる(失敗が受付を残していない)
    expect((await call()).replayed).toBe(false);
  });

  // ---- 段階 ----

  test('FREQ-529-AC-01: 表示段階は 数量確定済み → 一部受け取り済み → 受け取り完了。残りを打ち切ると 完了(closed)', async () => {
    const s = await setup([5, 3]);
    expect(await stageOf(s.actor, s.order.id)).toBe('quantity_confirmed');
    const first = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [2, 0]) });
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');
    await receive({ actor: s.actor, orderId: s.order.id, version: first.version, lines: receiveLines(s.lines, [3, 3]) });
    expect(await stageOf(s.actor, s.order.id)).toBe('received');

    const t = await setup([5, 3]);
    const partial = await receive({ actor: t.actor, orderId: t.order.id, version: t.version, lines: receiveLines(t.lines, [2, 3]) });
    expect(await stageOf(t.actor, t.order.id)).toBe('partially_received');
    await shortClose(t.actor, t.order.id, partial.version, [t.lines[0].id]);
    expect(await stageOf(t.actor, t.order.id)).toBe('closed');
  });

  // ---- FREQ-525-AC-01: 在庫一覧表 ----

  test('FREQ-525-AC-01: 受け取りの後、在庫一覧表の発注済みが減り、手持ちが増え、発注必要数が再計算される', async () => {
    const s = await setup([3]);
    const c = s.fixtures[0];
    await waitingOrder(c, 5, '2026-01-01T00:00:00Z');
    const rowOf = async () => (await db().query('select * from public.list_admin_inventory($1)', [s.actor])).rows
      .find((row: Record<string, unknown>) => row.variant_id === String(c.variantId)) as Record<string, unknown>;
    const numbers = (row: Record<string, unknown>) => ({
      free: row.free, paid_allocated: row.paid_allocated, on_hand: row.on_hand, order_quantity: row.order_quantity, on_order: row.on_order, required: row.required,
    });
    expect(numbers(await rowOf())).toEqual({ free: 0, paid_allocated: 0, on_hand: 0, order_quantity: 5, on_order: 3, required: 2 });

    await receive({ actor: s.actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, [2]) });
    // 2 点入庫 → 待っていた注文へ割当(on_hand 2)、発注済みは未納 1、注文数は割当 2 + 受注生産中 3 = 5、必要数 5 - 2 - 1 = 2
    expect(numbers(await rowOf())).toEqual({ free: 0, paid_allocated: 2, on_hand: 2, order_quantity: 5, on_order: 1, required: 2 });
  });

  // ---- 関数の形と ACL ----

  test('FREQ-540-AC-07: 受け取りの private 本体は DEFINER・postgres・search_path 空で service_role だけが EXECUTE でき、public 入口は SQL の INVOKER 委譲。一覧に private 本体だけが入る', async () => {
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
    const names = ['_purchase_order_id', '_expected_version', '_received_on', '_memo', '_lines', '_actor_id', '_request_key'];
    expect(await read(`private.${RECEIVE_SIGNATURE}`)).toEqual({ ...common, definer: true, language: 'plpgsql', names });
    expect(await read(`public.${RECEIVE_SIGNATURE}`)).toEqual({ ...common, definer: false, language: 'sql', names });

    const list = (await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows;
    expect(list).toHaveLength(G3D_ALLOWLIST.length);
    const oids = new Set(list.map((row) => row.oid));
    const privateOid = (await db().query('select $1::regprocedure::oid::text as oid', [`private.${RECEIVE_SIGNATURE}`])).rows[0].oid;
    const publicOid = (await db().query('select $1::regprocedure::oid::text as oid', [`public.${RECEIVE_SIGNATURE}`])).rows[0].oid;
    expect(oids.has(privateOid)).toBe(true);
    expect(oids.has(publicOid)).toBe(false);
  });

  test('FREQ-540-AC-07: anon / authenticated は public 入口も private 本体も呼べず(42501)、service_role は public 入口から実行できる', async () => {
    const s = await setup([5]);
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
    const call = (schema: string): [string, unknown[]] => [
      `select ${schema}.admin_receive_purchase_order($1::uuid, $2::integer, $3::date, $4::text, $5::jsonb, $6::uuid, $7::uuid) as r`,
      [s.order.id, s.version, null, null, JSON.stringify(receiveLines(s.lines, [1])), s.actor, randomUUID()],
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const schema of ['public', 'private']) expect(await attempt(role, ...call(schema))).toEqual({ code: '42501' });
    }
    // 受取日 NULL は引数の誤り(22023)。service_role は実行できて、中身の検査まで進むことだけを確かめる
    expect(await attempt('service_role', ...call('public'))).toEqual({ code: '22023' });
    const today1 = await today();
    const ok = await attempt('service_role', call('public')[0], [s.order.id, s.version, today1, null, JSON.stringify(receiveLines(s.lines, [1])), s.actor, randomUUID()]);
    expect(ok.rows?.[0].r).toMatchObject({ version: s.version + 1, allocatedQuantity: 0, replayed: false });
    await flush();
  });
});
