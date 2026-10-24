/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { seedGroupG1Allocation, seedGroupG1Shipment } from './helpers/group-g1-fixtures';
import {
  createPurchaseFlow, CONFIRMATION_REQUIRED, CONFLICT, EXCEEDS_RECEIVED, FORBIDDEN, INVALID, NOT_FOUND, REASON_REQUIRED, STOCK_INSUFFICIENT,
  VERSION_CONFLICT, type PurchaseSetup,
} from './helpers/purchase-order-flow';

/**
 * G-2 Task 7（FREQ-529-AC-04・AC-05・FREQ-525-AC-01・FREQ-540-AC-07）: 受け取りの取消・数量訂正
 * private.admin_reverse_purchase_order_receipt と公開入口。相殺の受取(kind=reverse)・負の受取行・調整の台帳(無タグ)を追記し、
 * 在庫は G-1 の減らし方(空き在庫 → 足りなければ支払い済みの割当を新しい注文から外す。確認の数・理由・履歴つき)で減らす。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const WRITERS_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_writers.sql'));
const WRITERS_SQL = WRITERS_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, WRITERS_FILE[0]), 'utf8') : '';
const REVERSE_SIGNATURE = 'admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)';

/** コメントの行を外した本文（コメント内の語を拾わないため） */
const withoutComments = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const CODE = withoutComments(WRITERS_SQL);
function functionText(createPrefix: string, alterPrefix: string): string {
  const start = CODE.indexOf(createPrefix);
  const end = CODE.indexOf(alterPrefix, start);
  return start >= 0 && end > start ? CODE.slice(start, end) : '';
}
const REVERSE_TEXT = functionText('CREATE FUNCTION private.admin_reverse_purchase_order_receipt(', 'ALTER FUNCTION private.admin_reverse_purchase_order_receipt(');

describe('G-2 writers migration の受け取りの取消の節（DB なし）', () => {
  const PERMISSION = "private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.receiving.manage', 'admin.purchase_orders.read'])";

  test('FREQ-529-AC-04: 処理順は 引数検証(理由は必須) → ロック helper(在庫あり) → 権限 → 指紋と再送 → 存在 → 版 → 受取・行 → 取り消せる数 → 在庫の不足 → 確認の数 → 状態の保存 → 相殺の受取 → 割当の解除 → 調整の台帳 → 受取行 → FIFO → 履歴 → 操作の記録', () => {
    expect(REVERSE_TEXT).not.toBe('');
    expect(REVERSE_TEXT).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
    const positions = [
      REVERSE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'"),
      REVERSE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_REASON_REQUIRED' USING ERRCODE = '22023'"),
      REVERSE_TEXT.indexOf('v_orders := private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], true);'),
      REVERSE_TEXT.indexOf(PERMISSION),
      REVERSE_TEXT.indexOf("op.operation = 'purchase_order_receipt_reverse' AND op.request_key = _request_key"),
      REVERSE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002'"),
      REVERSE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_VERSION_CONFLICT' USING ERRCODE = '55000'"),
      REVERSE_TEXT.indexOf("AND r.kind = 'receive') THEN"),
      REVERSE_TEXT.indexOf('AND rl.quantity > 0)'),
      REVERSE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED' USING ERRCODE = '23514'"),
      REVERSE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT' USING ERRCODE = '23514'"),
      REVERSE_TEXT.indexOf("RAISE EXCEPTION 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED' USING ERRCODE = '55000'"),
      REVERSE_TEXT.indexOf('v_before := private.capture_group_g_item_states(v_orders);'),
      REVERSE_TEXT.indexOf("PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);"),
      REVERSE_TEXT.indexOf('INSERT INTO public.purchase_order_receipts('),
      REVERSE_TEXT.indexOf('UPDATE public.order_item_allocations AS a SET'),
      REVERSE_TEXT.indexOf('INSERT INTO public.stock_movements('),
      REVERSE_TEXT.indexOf('INSERT INTO public.order_item_allocation_events('),
      REVERSE_TEXT.indexOf('INSERT INTO public.purchase_order_receipt_lines('),
      REVERSE_TEXT.indexOf('UPDATE public.purchase_order_lines SET'),
      REVERSE_TEXT.indexOf('UPDATE public.purchase_orders SET'),
      REVERSE_TEXT.indexOf('private.allocate_group_g_fifo(v_variants, v_operation, _actor_id)'),
      REVERSE_TEXT.indexOf("private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'stock_move', _actor_id)"),
      REVERSE_TEXT.indexOf('INSERT INTO private.group_g_operations('),
    ];
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // 本体で最初に public / private の物に触れるのがロック helper の呼び出し（引数検証は表を読まない）
    const body = REVERSE_TEXT.slice(REVERSE_TEXT.indexOf('\nBEGIN\n'));
    expect(body.search(/\b(?:public|private)\./)).toBe(body.indexOf('private.lock_group_g_purchase_orders('));
    // 指紋に版を入れない。実行者・理由・確認の数・行(id 昇順)を入れる
    const fingerprint = REVERSE_TEXT.slice(REVERSE_TEXT.indexOf('v_fingerprint := '), REVERSE_TEXT.indexOf("'hex');"));
    expect(fingerprint).toContain("'operation', 'purchase_order_receipt_reverse'");
    expect(fingerprint).not.toMatch(/version/i);
    for (const part of ["'receipt_id', _receipt_id", "'reason', v_reason", "'expected_release_quantity', _expected_release_quantity", "'actor_id', _actor_id", 'ORDER BY (e.value ->> \'receiptLineId\')::uuid']) {
      expect(fingerprint).toContain(part);
    }
    expect(REVERSE_TEXT.match(/set_config\('app\.group_g_operation_id', COALESCE\(v_previous_operation, ''\), true\)/g)).toHaveLength(2);
    expect(REVERSE_TEXT).toContain('EXCEPTION WHEN OTHERS THEN');
  });

  test('FREQ-529-AC-04: G-1 の減らし方と同じ判定・理由・並び。空き在庫が先、割当は支払い済み(paid)だけを新しい注文から、台帳は allocation_release(タグ付き)と adjustment(無タグ)、割当イベントは stock_adjustment、状態の履歴は stock_move', () => {
    // 確認の判定式は G-1 の admin_record_stock_movement と同じ
    expect(REVERSE_TEXT).toContain('IF (v_release > 0 AND _expected_release_quantity IS NULL)');
    expect(REVERSE_TEXT).toContain('OR (_expected_release_quantity IS NOT NULL AND _expected_release_quantity <> v_release) THEN');
    expect(REVERSE_TEXT).toContain("DETAIL = pg_catalog.jsonb_build_object('releasedQuantity', v_release)::text");
    // 外すのは未発送の paid の割当だけ(仮確保は外さず、数えない)
    expect(REVERSE_TEXT).toContain("a.kind = 'paid' AND a.remaining_quantity > 0 AND oi.order_id = ANY(v_orders)");
    expect(REVERSE_TEXT).not.toContain('payment_hold');
    expect(REVERSE_TEXT).toContain('ORDER BY o.created_at DESC, o.id DESC, oi.id DESC, a.id DESC');
    expect(REVERSE_TEXT).toContain('v_remaining := GREATEST(v_line.quantity - v_free, 0);');
    // 台帳: 解放は allocation_release(正・タグ付き・注文と明細つき・備考=理由)、本体は adjustment(負・無タグ)
    const releaseInsert = REVERSE_TEXT.slice(REVERSE_TEXT.indexOf('INSERT INTO public.stock_movements('), REVERSE_TEXT.indexOf('INSERT INTO public.order_item_allocation_events('));
    expect(releaseInsert).toContain('INSERT INTO public.stock_movements(variant_id, delta, reason, note, order_id, order_item_id, allocation_operation_id, created_by)');
    expect(releaseInsert).toContain("'allocation_release', v_reason, v_allocation.order_id, v_allocation.order_item_id");
    expect(REVERSE_TEXT).toContain("'release', v_quantity, v_operation, 1, v_release_movement, 'stock_adjustment', _actor_id");
    const adjustment = REVERSE_TEXT.slice(REVERSE_TEXT.lastIndexOf('INSERT INTO public.stock_movements('), REVERSE_TEXT.indexOf('INSERT INTO public.purchase_order_receipt_lines('));
    expect(adjustment).toContain('INSERT INTO public.stock_movements(variant_id, delta, reason, note, created_by)');
    expect(adjustment).toContain("-v_line.quantity, 'adjustment'");
    expect(adjustment).toContain("U&'\\767A\\6CE8 ' || v_order.number || U&' \\306E\\53D7\\3051\\53D6\\308A\\53D6\\6D88'");
    expect(adjustment).not.toContain('allocation_operation_id');
    expect(REVERSE_TEXT).toContain("'reverse', (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date, v_reason");
    const writes = [...REVERSE_TEXT.matchAll(/\b(INSERT INTO|UPDATE) ([a-z_.]+)/g)].map((match) => `${match[1]} ${match[2]}`);
    expect(writes).toEqual([
      'INSERT INTO public.purchase_order_receipts', 'UPDATE public.order_item_allocations', 'INSERT INTO public.stock_movements',
      'INSERT INTO public.order_item_allocation_events', 'INSERT INTO public.stock_movements', 'INSERT INTO public.purchase_order_receipt_lines',
      'UPDATE public.purchase_order_lines', 'UPDATE public.purchase_orders', 'INSERT INTO private.group_g_operations',
    ]);
    expect(REVERSE_TEXT).not.toMatch(/\b(DELETE|TRUNCATE|MERGE)\b/);
    // 注文は新しい順に並べるために読むだけ(書込みの一覧に注文は無い)
    expect(REVERSE_TEXT).toContain('JOIN public.orders AS o ON o.id = oi.order_id');
    expect(REVERSE_TEXT).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM) public\.orders\b/);
  });

  test('FREQ-540-AC-07: private 本体と public 入口は service_role だけに EXECUTE を渡し、PUBLIC / anon / authenticated を個別に外す。public 入口は SQL の INVOKER 委譲', () => {
    expect(REVERSE_TEXT).not.toBe('');
    const delegate = functionText('CREATE FUNCTION public.admin_reverse_purchase_order_receipt(', 'ALTER FUNCTION public.admin_reverse_purchase_order_receipt(');
    expect(delegate).toContain("LANGUAGE sql SECURITY INVOKER SET search_path = ''");
    expect(delegate).toContain('SELECT private.admin_reverse_purchase_order_receipt(_purchase_order_id, _expected_version, _receipt_id, _lines, _reason, _expected_release_quantity, _actor_id, _request_key);');
  });
});

describeLocalDb('integration: G-2 受け取りの取消・数量訂正', (db) => {
  const flow = createPurchaseFlow(db);
  const {
    createActor, grant, revoke, rejected, today, linesOf, orderRow, receive, reverse, receiveLines, setup, waitingOrder, totals, allocated,
    snapshot, operationOf, receiptsOf, receiptLinesOf, movement, stageOf, shortClose,
  } = flow;

  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  /** 発注書の全行を受け取り、その受取の行(line_no 順)を返す */
  async function receivedAll(s: PurchaseSetup, quantities: number[]) {
    const result = await receive({ actor: s.actor, orderId: s.order.id, version: s.version, lines: receiveLines(s.lines, quantities) });
    return { ...result, rows: await receiptLinesOf(result.receiptId) };
  }

  async function reversibleOf(s: PurchaseSetup, receiptId: string): Promise<number[]> {
    const detail = (await db().query('select public.get_admin_purchase_order($1::uuid, $2::uuid) as r', [s.order.id, s.actor])).rows[0].r;
    return detail.receipts.find((receipt: { id: string }) => receipt.id === receiptId).lines.map((line: { reversibleQuantity: number }) => line.reversibleQuantity);
  }

  const REASON = '数え間違い';

  // ---- FREQ-529-AC-04: 相殺 ----

  test('FREQ-529-AC-04: 受け取りの取消で 相殺の受取(kind=reverse・理由)・負の受取行(相殺元)・調整の台帳(-q・無タグ)が追記され、納品済み −q・未納 +q・空き在庫 −q・発注書と行の版 +1。元の受取と行は変わらない', async () => {
    const s = await setup([4, 3]);
    const received = await receivedAll(s, [4, 3]);
    const originalReceipts = await receiptsOf(s.order.id);
    const before = await snapshot();
    const key = randomUUID();

    const result = await reverse({
      actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, key, reason: ` ${REASON} `,
      lines: [{ receiptLineId: received.rows[0].id, quantity: 4 }],
    });
    expect(result).toEqual({ receiptId: expect.any(String), version: received.version + 1, releasedQuantity: 0, replayed: false });
    expect(result.receiptId).not.toBe(received.receiptId);

    const receipts = await receiptsOf(s.order.id);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toEqual(originalReceipts[0]);
    expect(receipts[1]).toMatchObject({ id: result.receiptId, kind: 'reverse', received_on: await today(), memo: null, reason: REASON, actor_id: s.actor });
    const offsets = await receiptLinesOf(result.receiptId);
    expect(offsets.map((row) => [row.line_id, row.quantity, row.reverses_receipt_line_id])).toEqual([[s.lines[0].id, -4, received.rows[0].id]]);
    expect(await movement(offsets[0].stock_movement_id)).toEqual({
      id: offsets[0].stock_movement_id, variant_id: s.lines[0].variant_id, delta: -4, reason: 'adjustment',
      note: `発注 ${s.order.number} の受け取り取消`, order_id: null, order_item_id: null, allocation_operation_id: null, created_by: s.actor,
    });
    // 元の受取の行は変わらない
    expect((await receiptLinesOf(received.receiptId)).map((row) => [row.id, row.quantity, row.stock_movement_id]))
      .toEqual(received.rows.map((row) => [row.id, row.quantity, row.stock_movement_id]));

    // 納品済み −4・未納 +4(確定数量は不変)・行の版 +1。もう1行は動かない。空き在庫 −4
    expect((await linesOf(s.order.id)).map((line) => [line.confirmed_quantity, line.received_quantity, line.outstanding_quantity, line.version]))
      .toEqual([[4, 0, 4, 4], [3, 3, 0, 3]]);
    expect(await orderRow(s.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: received.version + 1 });
    expect(await totals(s.lines[0].variant_id)).toEqual({ f: 0, a: 0, h: 0 });
    expect(await totals(s.lines[1].variant_id)).toEqual({ f: 3, a: 0, h: 0 });
    expect(await stageOf(s.actor, s.order.id)).toBe('partially_received');

    const operations = await operationOf('purchase_order_receipt_reverse', key);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      cause_type: 'purchase_order', cause_id: s.order.id, actor_id: s.actor,
      result: { receiptId: result.receiptId, version: received.version + 1, releasedQuantity: 0, replayed: false },
    });
    const after = await snapshot();
    expect(after).toMatchObject({
      receipts: before.receipts + 1, receipt_lines: before.receipt_lines + 1, movements: before.movements + 1, operations: before.operations + 1,
      allocations: before.allocations, allocation_events: before.allocation_events, state_events: before.state_events,
    });
  });

  test('FREQ-529-AC-04: 数量訂正は一部の数量だけ相殺でき、取消可能数が減る。複数回に分けた相殺の合計が元の数量を超えると GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED / 23514', async () => {
    const s = await setup([5]);
    const received = await receivedAll(s, [5]);
    expect(await reversibleOf(s, received.receiptId)).toEqual([5]);

    const first = await reverse({ actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: '2点を訂正', lines: [{ receiptLineId: received.rows[0].id, quantity: 2 }] });
    expect((await linesOf(s.order.id))[0]).toMatchObject({ received_quantity: 3, outstanding_quantity: 2 });
    expect(await reversibleOf(s, received.receiptId)).toEqual([3]);
    // 相殺の受取そのものの行は取り消せる数 0
    expect(await reversibleOf(s, first.receiptId)).toEqual([0]);

    const before = await snapshot();
    expect(await rejected(() => reverse({ actor: s.actor, orderId: s.order.id, version: first.version, receiptId: received.receiptId, reason: '多すぎる', lines: [{ receiptLineId: received.rows[0].id, quantity: 4 }] }))).toEqual(EXCEEDS_RECEIVED);
    expect(await snapshot()).toEqual(before);

    const second = await reverse({ actor: s.actor, orderId: s.order.id, version: first.version, receiptId: received.receiptId, reason: 'さらに3点', lines: [{ receiptLineId: received.rows[0].id, quantity: 3 }] });
    expect((await linesOf(s.order.id))[0]).toMatchObject({ received_quantity: 0, outstanding_quantity: 5 });
    expect(await reversibleOf(s, received.receiptId)).toEqual([0]);
    const afterAll = await snapshot();
    expect(await rejected(() => reverse({ actor: s.actor, orderId: s.order.id, version: second.version, receiptId: received.receiptId, reason: '元の数量を超える', lines: [{ receiptLineId: received.rows[0].id, quantity: 1 }] }))).toEqual(EXCEEDS_RECEIVED);
    expect(await snapshot()).toEqual(afterAll);
  });

  // ---- FREQ-529-AC-04: 割当の解除と確認 ----

  test('FREQ-529-AC-04: 受け取った在庫が古い注文2件に割り当て済み(空き在庫0)の時、最初の送信は GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED / 55000 で DETAIL が {releasedQuantity:n}、全て不変。正しい数と新しい request_key で再送すると新しい注文の割当から外れ、続けて adjustment が無タグで入る', async () => {
    const s = await setup([4]);
    const c = s.fixtures[0];
    const old = await waitingOrder(c, 2, '2025-12-01T00:00:00Z');
    const young = await waitingOrder(c, 2, '2026-01-01T00:00:00Z');
    const received = await receivedAll(s, [4]);
    expect(received.allocatedQuantity).toBe(4);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 4, h: 0 });
    const before = await snapshot();
    const args = { actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, lines: [{ receiptLineId: received.rows[0].id, quantity: 3 }] };

    const confirmation = await rejected(() => reverse({ ...args }));
    expect(confirmation).toEqual({ ...CONFIRMATION_REQUIRED, detail: '{"releasedQuantity": 3}' });
    expect(await snapshot()).toEqual(before);
    // 確認の数が違えば、また同じ 409(本当の数が DETAIL に入る)
    for (const expected of [0, 2, 4]) {
      expect(await rejected(() => reverse({ ...args, expected }))).toEqual({ ...CONFIRMATION_REQUIRED, detail: '{"releasedQuantity": 3}' });
    }
    // 理由が空なら、確認の前に断る(外す割当が 0 でも理由は必須)
    for (const reason of [null, '', '   ']) {
      expect(await rejected(() => reverse({ ...args, reason, expected: 3 }))).toEqual(REASON_REQUIRED);
    }
    expect(await snapshot()).toEqual(before);

    const key = randomUUID();
    const result = await reverse({ ...args, expected: 3, key });
    expect(result).toEqual({ receiptId: expect.any(String), version: received.version + 1, releasedQuantity: 3, replayed: false });
    // 新しい注文(young)の割当から外れ、足りない分だけ古い注文(old)から。old は 2 → 1
    expect([await allocated(young.line), await allocated(old.line)]).toEqual([0, 1]);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 1, h: 0 });
    expect((await linesOf(s.order.id))[0]).toMatchObject({ received_quantity: 1, outstanding_quantity: 3 });

    const operationId = (await operationOf('purchase_order_receipt_reverse', key))[0].id as string;
    // この操作のタグが付く台帳は解放の2行だけ(新しい注文から: young 2、old 1。正の数・注文と明細つき・備考=理由)。調整は無タグ
    const tagged = (await db().query(`select id::bigint as id, reason, delta, order_item_id, note from public.stock_movements
      where allocation_operation_id = $1 order by id`, [operationId])).rows;
    expect(tagged.map(({ reason, delta, order_item_id: item, note }) => ({ reason, delta, order_item_id: item, note }))).toEqual([
      { reason: 'allocation_release', delta: 2, order_item_id: young.line, note: REASON },
      { reason: 'allocation_release', delta: 1, order_item_id: old.line, note: REASON },
    ]);
    const offset = (await receiptLinesOf(result.receiptId))[0];
    expect(await movement(offset.stock_movement_id)).toMatchObject({
      delta: -3, reason: 'adjustment', order_id: null, order_item_id: null, allocation_operation_id: null, note: `発注 ${s.order.number} の受け取り取消`,
    });
    // 解放の後に調整が入る(台帳の id の順)
    expect(Number(offset.stock_movement_id)).toBeGreaterThan(Number(tagged[1].id));
    const events = (await db().query(`select a.order_item_id, e.event_type, e.quantity, e.reason, e.sequence from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id = e.allocation_id where e.operation_id = $1 order by e.stock_movement_id`, [operationId])).rows;
    expect(events).toEqual([
      { order_item_id: young.line, event_type: 'release', quantity: 2, reason: 'stock_adjustment', sequence: 1 },
      { order_item_id: old.line, event_type: 'release', quantity: 1, reason: 'stock_adjustment', sequence: 1 },
    ]);
    // 外された数量は受注生産中に戻る。状態の履歴の理由は G-1 の在庫を減らす操作と同じ stock_move
    const states = (await db().query(`select order_item_id, from_status, to_status, quantity, reason from public.order_item_state_events
      where operation_id = $1 order by quantity desc, order_item_id`, [operationId])).rows;
    expect(states).toEqual([
      { order_item_id: young.line, from_status: 'ready', to_status: 'in_production', quantity: 2, reason: 'stock_move' },
      { order_item_id: old.line, from_status: 'ready', to_status: 'in_production', quantity: 1, reason: 'stock_move' },
    ]);
    expect((await db().query('select * from public.verify_stock_integrity() where variant_id = $1', [c.variantId])).rows).toEqual([]);
    expect((await operationOf('purchase_order_receipt_reverse', key))[0].result).toEqual({ ...result, replayed: false });
  });

  test('FREQ-529-AC-04: 空き在庫が足りる時は割当を1つも外さず releasedQuantity=0・確認の数なしでも通る。一部だけ足りる時は不足分だけ外す(取り消す数ではなく)', async () => {
    // 空き在庫が足りる: 初めの在庫 3 + 受け取り 4 = 7、4 点を取り消しても割当は動かない
    const rich = await setup([4], { stocks: [3] });
    const richReceived = await receivedAll(rich, [4]);
    expect(await totals(rich.lines[0].variant_id)).toEqual({ f: 7, a: 0, h: 0 });
    const result = await reverse({ actor: rich.actor, orderId: rich.order.id, version: richReceived.version, receiptId: richReceived.receiptId, reason: REASON, lines: [{ receiptLineId: richReceived.rows[0].id, quantity: 4 }] });
    expect(result.releasedQuantity).toBe(0);
    expect(await totals(rich.lines[0].variant_id)).toEqual({ f: 3, a: 0, h: 0 });

    // 一部だけ足りない: 待ち注文 2 点 + 受け取り 3 点 → 割当 2・空き 1。3 点を取り消すと外すのは 2 点(3 − 空き 1)
    const poor = await setup([3]);
    const c = poor.fixtures[0];
    const waiting = await waitingOrder(c, 2, '2026-01-01T00:00:00Z');
    const received = await receivedAll(poor, [3]);
    expect(await totals(c.variantId)).toEqual({ f: 1, a: 2, h: 0 });
    const args = { actor: poor.actor, orderId: poor.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, lines: [{ receiptLineId: received.rows[0].id, quantity: 3 }] };
    expect(await rejected(() => reverse(args))).toEqual({ ...CONFIRMATION_REQUIRED, detail: '{"releasedQuantity": 2}' });
    expect(await reverse({ ...args, expected: 2 })).toMatchObject({ releasedQuantity: 2 });
    expect(await allocated(waiting.line)).toBe(0);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 0 });
  });

  test('FREQ-529-AC-04: 複数の variant の取消は、確認の数が variant ごとの外す点数の合計。FIFO に回すのは取り消した variant だけ', async () => {
    // 3行目の variant C は空き在庫があり、待ち注文もある(本来は FIFO が割り当てる状態)が、受け取りにも取消にも含めない。FIFO が C に回れば割り当ててしまう
    const s = await setup([2, 3, 1], { stocks: [0, 0, 5] });
    const [a, b, c] = s.fixtures;
    const waitingA = await waitingOrder(a, 1, '2026-01-01T00:00:00Z');
    const waitingB = await waitingOrder(b, 2, '2026-01-02T00:00:00Z');
    const waitingC = await waitingOrder(c, 2, '2026-01-03T00:00:00Z');
    expect(await totals(c.variantId)).toEqual({ f: 5, a: 0, h: 0 });
    const received = await receivedAll(s, [2, 3, 0]);
    // 受け取りの FIFO は受け取った variant(A・B)だけ: C の待ち注文は割り当てられない
    expect(received.allocatedQuantity).toBe(3);
    expect(await allocated(waitingC.line)).toBe(0);
    expect(await totals(c.variantId)).toEqual({ f: 5, a: 0, h: 0 });
    // A: 入庫 2 のうち 1 点が待ち注文へ(空き 1)。B: 入庫 3 のうち 2 点が待ち注文へ(空き 1)
    expect(await totals(a.variantId)).toEqual({ f: 1, a: 1, h: 0 });
    expect(await totals(b.variantId)).toEqual({ f: 1, a: 2, h: 0 });
    const args = {
      actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON,
      lines: [{ receiptLineId: received.rows[0].id, quantity: 2 }, { receiptLineId: received.rows[1].id, quantity: 3 }],
    };
    // A は 2 − 空き 1 = 1 点、B は 3 − 空き 1 = 2 点。合計 3 点
    expect(await rejected(() => reverse(args))).toEqual({ ...CONFIRMATION_REQUIRED, detail: '{"releasedQuantity": 3}' });
    expect(await rejected(() => reverse({ ...args, expected: 1 }))).toEqual({ ...CONFIRMATION_REQUIRED, detail: '{"releasedQuantity": 3}' });
    const result = await reverse({ ...args, expected: 3 });
    expect(result.releasedQuantity).toBe(3);
    expect([await allocated(waitingA.line), await allocated(waitingB.line)]).toEqual([0, 0]);
    expect(await totals(a.variantId)).toEqual({ f: 0, a: 0, h: 0 });
    expect(await totals(b.variantId)).toEqual({ f: 0, a: 0, h: 0 });
    expect((await linesOf(s.order.id)).map((line) => [line.received_quantity, line.outstanding_quantity])).toEqual([[0, 2], [0, 3], [0, 1]]);
    // 取消の FIFO も取り消した variant(A・B)だけ: C の待ち注文は割り当てられず、C の在庫も動かない
    expect(await allocated(waitingC.line)).toBe(0);
    expect(await totals(c.variantId)).toEqual({ f: 5, a: 0, h: 0 });
  });

  // ---- FREQ-529-AC-05: 足りない時 ----

  test('FREQ-529-AC-05: 取り消す数が 空き在庫+外せる支払い済みの割当 を超えると GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT / 23514 で全て不変。仮確保(H)は外れず数えない', async () => {
    // 初めの在庫 2 を買い手の仮確保(H)に取られる(空き 0・H 2)。受け取り 3 → 空き 3。別の操作で空きを 2 減らして 1 にする
    const s = await setup([3], { stocks: [2] });
    const c = s.fixtures[0];
    const pending = await waitingOrder(c, 2, '2026-01-01T00:00:00Z', 'pending');
    await seedGroupG1Allocation(db(), { orderItemId: pending.line, quantity: 2, kind: 'payment_hold' });
    const received = await receivedAll(s, [3]);
    await db().query("insert into public.stock_movements (variant_id, delta, reason) values ($1, -2, 'adjustment')", [c.variantId]);
    expect(await totals(c.variantId)).toEqual({ f: 1, a: 0, h: 2 });
    const before = await snapshot();
    const args = { actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, lines: [{ receiptLineId: received.rows[0].id, quantity: 3 }] };

    // 3 > 空き 1 + 外せる割当 0。仮確保 2 を数えると通ってしまう
    expect(await rejected(() => reverse(args))).toEqual(STOCK_INSUFFICIENT);
    expect(await rejected(() => reverse({ ...args, expected: 0 }))).toEqual(STOCK_INSUFFICIENT);
    expect(await snapshot()).toEqual(before);
    expect(await allocated(pending.line)).toBe(2);
    // 空き在庫だけで足りる 1 点なら通る
    const ok = await reverse({ ...args, lines: [{ receiptLineId: received.rows[0].id, quantity: 1 }] });
    expect(ok.releasedQuantity).toBe(0);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 2 });
  });

  test('FREQ-529-AC-05: 出荷で消費された割当は remaining_quantity に残らず外れない(消費済みの数量は外せる合計に入らない)', async () => {
    const s = await setup([2]);
    const c = s.fixtures[0];
    const waiting = await waitingOrder(c, 2, '2026-01-01T00:00:00Z');
    const received = await receivedAll(s, [2]);
    expect(received.allocatedQuantity).toBe(2);
    // G-3 までは発送の入口が無いので、G-1 の consume の材料で消費する
    await seedGroupG1Shipment(db(), { orderId: waiting.orderId, lines: [{ orderItemId: waiting.line, quantity: 2 }], shippedAt: '2026-02-01T00:00:00Z' });
    expect(await allocated(waiting.line)).toBe(0);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 0 });
    const before = await snapshot();
    expect(await rejected(() => reverse({ actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, lines: [{ receiptLineId: received.rows[0].id, quantity: 1 }] })))
      .toEqual(STOCK_INSUFFICIENT);
    expect(await snapshot()).toEqual(before);
  });

  // ---- 取消後の再受け取り・打切りの復活 ----

  test('FREQ-529-AC-04: 取消後に同じ未納を通常どおり再び受け取れて FIFO が動く。打切り済みの行を取り消すと未納が復活し、取消前後で在庫一覧表の発注必要数は変わらない', async () => {
    const s = await setup([4]);
    const c = s.fixtures[0];
    const waiting = await waitingOrder(c, 2, '2026-01-01T00:00:00Z');
    const received = await receivedAll(s, [4]);
    expect(received.allocatedQuantity).toBe(2);
    const reversed = await reverse({ actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, expected: 2, lines: [{ receiptLineId: received.rows[0].id, quantity: 4 }] });
    expect(reversed.releasedQuantity).toBe(2);
    expect(await allocated(waiting.line)).toBe(0);
    expect((await linesOf(s.order.id))[0]).toMatchObject({ received_quantity: 0, outstanding_quantity: 4 });
    const again = await receive({ actor: s.actor, orderId: s.order.id, version: reversed.version, lines: receiveLines(s.lines, [4]) });
    expect(again.allocatedQuantity).toBe(2);
    expect(await allocated(waiting.line)).toBe(2);
    expect((await linesOf(s.order.id))[0]).toMatchObject({ received_quantity: 4, outstanding_quantity: 0 });

    // 打切り済みの行を取り消す: 納品 3・確定 5 → 打切りで確定 3・未納 0 → 2 点取消で納品 1・未納 2(復活)
    const t = await setup([5]);
    const d = t.fixtures[0];
    await waitingOrder(d, 5, '2026-01-01T00:00:00Z');
    const rowOf = async () => (await db().query('select * from public.list_admin_inventory($1)', [t.actor])).rows
      .find((row: Record<string, unknown>) => row.variant_id === String(d.variantId)) as Record<string, unknown>;
    const numbers = (row: Record<string, unknown>) => ({ free: row.free, paid_allocated: row.paid_allocated, order_quantity: row.order_quantity, on_order: row.on_order, required: row.required });
    const partial = await receivedAll(t, [3]);
    const closedVersion = await shortClose(t.actor, t.order.id, partial.version, [t.lines[0].id]);
    expect((await linesOf(t.order.id))[0]).toMatchObject({ confirmed_quantity: 3, received_quantity: 3, outstanding_quantity: 0 });
    expect(await stageOf(t.actor, t.order.id)).toBe('closed');
    const beforeRow = numbers(await rowOf());
    expect(beforeRow).toEqual({ free: 0, paid_allocated: 3, order_quantity: 5, on_order: 0, required: 2 });

    await reverse({ actor: t.actor, orderId: t.order.id, version: closedVersion, receiptId: partial.receiptId, reason: REASON, expected: 2, lines: [{ receiptLineId: partial.rows[0].id, quantity: 2 }] });
    expect((await linesOf(t.order.id))[0]).toMatchObject({ confirmed_quantity: 3, received_quantity: 1, outstanding_quantity: 2 });
    expect(await stageOf(t.actor, t.order.id)).toBe('partially_received');
    const afterRow = numbers(await rowOf());
    // 外した割当は注文数の中で ready → 受注生産中に移るだけで合計は同じ。手持ちは減り、発注済み(未納)が増え、発注必要数は変わらない
    expect(afterRow).toEqual({ free: 0, paid_allocated: 1, order_quantity: 5, on_order: 2, required: 2 });
    expect(afterRow.required).toBe(beforeRow.required);
  });

  // ---- 再送・拒否 ----

  test('FREQ-529-AC-04: 同じ request_key と同じ内容の再送は同じ結果・在庫の二重減算0・割当の二重解除0。内容が違えば GROUP_G_REQUEST_KEY_CONFLICT', async () => {
    const s = await setup([4]);
    const c = s.fixtures[0];
    await waitingOrder(c, 2, '2026-01-01T00:00:00Z');
    const received = await receivedAll(s, [4]);
    const key = randomUUID();
    const args = { actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, expected: 2, key, lines: [{ receiptLineId: received.rows[0].id, quantity: 4 }] };
    const first = await reverse(args);
    expect(first.releasedQuantity).toBe(2);
    const stored = await snapshot();

    expect(await reverse(args)).toEqual({ ...first, replayed: true });
    // 版が進んだ後の再送(古い版)でも同じ結果
    const nextVersion = (await receive({ actor: s.actor, orderId: s.order.id, version: first.version, lines: receiveLines(s.lines, [1]) })).version;
    const afterNext = await snapshot();
    expect(await reverse(args)).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(afterNext);
    expect(nextVersion).toBe(first.version + 1);
    expect(afterNext.movements).toBeGreaterThan(stored.movements);

    for (const patch of [{ reason: '別の理由' }, { expected: 0 }, { lines: [{ receiptLineId: received.rows[0].id, quantity: 3 }] }]) {
      expect(await rejected(() => reverse({ ...args, ...patch }))).toEqual(CONFLICT);
    }
    const another = await createActor(['admin']);
    expect(await rejected(() => reverse({ ...args, actor: another }))).toEqual(CONFLICT);
    expect(await snapshot()).toEqual(afterNext);
  });

  test('FREQ-529-AC-04: 拒否(理由なし・版違い・存在しない発注書・他の発注書の受取や行・相殺の行・相殺の受取・不正な引数)は、台帳・在庫・割当・納品累計・履歴が全て不変', async () => {
    const s = await setup([4, 3]);
    const other = await setup([2]);
    const received = await receivedAll(s, [4, 3]);
    const otherReceived = await receivedAll(other, [2]);
    const offset = await reverse({ actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, lines: [{ receiptLineId: received.rows[0].id, quantity: 1 }] });
    const offsetRow = (await receiptLinesOf(offset.receiptId))[0];
    const base = { actor: s.actor, orderId: s.order.id, version: offset.version, receiptId: received.receiptId, reason: REASON };
    const one = [{ receiptLineId: received.rows[0].id, quantity: 1 }];

    expect(await rejected(() => reverse({ ...base, lines: one, reason: null }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => reverse({ ...base, lines: one, reason: '  \t ' }))).toEqual(REASON_REQUIRED);
    expect(await rejected(() => reverse({ ...base, lines: one, version: offset.version + 1 }))).toEqual(VERSION_CONFLICT);
    expect(await rejected(() => reverse({ ...base, lines: one, orderId: randomUUID() }))).toEqual(NOT_FOUND);
    // 他の発注書の受取・行
    expect(await rejected(() => reverse({ ...base, lines: [{ receiptLineId: otherReceived.rows[0].id, quantity: 1 }], receiptId: otherReceived.receiptId }))).toEqual(INVALID);
    expect(await rejected(() => reverse({ ...base, lines: [{ receiptLineId: otherReceived.rows[0].id, quantity: 1 }] }))).toEqual(INVALID);
    // 別の受取の行を、この受取の行として渡す(2 つ目の受取を作る)
    const second = await receive({ actor: s.actor, orderId: s.order.id, version: offset.version, lines: receiveLines(s.lines, [1, 0]) });
    const secondRow = (await receiptLinesOf(second.receiptId))[0];
    const beforeSecond = await snapshot();
    expect(await rejected(() => reverse({ ...base, version: second.version, lines: [{ receiptLineId: secondRow.id, quantity: 1 }] }))).toEqual(INVALID);
    // 相殺の受取そのものと、その行は取り消せない
    expect(await rejected(() => reverse({ ...base, version: second.version, receiptId: offset.receiptId, lines: [{ receiptLineId: offsetRow.id, quantity: 1 }] }))).toEqual(INVALID);
    expect(await rejected(() => reverse({ ...base, version: second.version, lines: [{ receiptLineId: offsetRow.id, quantity: 1 }] }))).toEqual(INVALID);
    expect(await rejected(() => reverse({ ...base, version: second.version, receiptId: randomUUID(), lines: one }))).toEqual(INVALID);
    expect(await rejected(() => reverse({ ...base, version: second.version, lines: [{ receiptLineId: randomUUID(), quantity: 1 }] }))).toEqual(INVALID);

    const row = received.rows[0].id;
    const invalidInputs: Array<[string, Parameters<typeof reverse>[0]]> = [
      ['行なし', { ...base, lines: [] }],
      ['行が配列でない', { ...base, lines: { receiptLineId: row, quantity: 1 } }],
      ['行の重複', { ...base, lines: [{ receiptLineId: row, quantity: 1 }, { receiptLineId: row, quantity: 1 }] }],
      ['数量 0', { ...base, lines: [{ receiptLineId: row, quantity: 0 }] }],
      ['数量が 100000', { ...base, lines: [{ receiptLineId: row, quantity: 100000 }] }],
      ['数量が小数', { ...base, lines: [{ receiptLineId: row, quantity: 1.5 }] }],
      ['余分な項目', { ...base, lines: [{ receiptLineId: row, quantity: 1, note: 'x' }] }],
      ['receiptLineId が uuid でない', { ...base, lines: [{ receiptLineId: 'abc', quantity: 1 }] }],
      ['lines が NULL', { ...base, lines: undefined }],
      ['確認の数が負', { ...base, lines: one, expected: -1 }],
      ['理由が 201 文字', { ...base, lines: one, reason: 'あ'.repeat(201) }],
      ['受取が NULL', { ...base, lines: one, receiptId: null }],
      ['版 NULL', { ...base, lines: one, version: null }],
      ['実行者 NULL', { ...base, lines: one, actor: null }],
      ['request_key NULL', { ...base, lines: one, key: null }],
    ];
    for (const [name, args] of invalidInputs) {
      expect({ name, failure: await rejected(() => reverse(args)) }).toEqual({ name, failure: INVALID });
    }
    expect(await snapshot()).toEqual(beforeSecond);
  });

  // ---- 権限 ----

  test('FREQ-540-AC-07: 取消は receiving.manage と purchase_orders.read の両方が要る。manage だけ・read だけ・発注/在庫/items の権限だけ・無効・期限切れ・役割なし・存在しない実行者は 42501', async () => {
    const s = await setup([5]);
    const received = await receivedAll(s, [5]);
    const before = await snapshot();
    const attempt = async (actor: string) => rejected(() => reverse({
      actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, lines: [{ receiptLineId: received.rows[0].id, quantity: 1 }],
    }));
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

    await grant('user', ['admin.purchase_orders.read']);
    const union = await createActor(['supporter', 'user']);
    const result = await reverse({ actor: union, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, lines: [{ receiptLineId: received.rows[0].id, quantity: 1 }] });
    expect(result.version).toBe(received.version + 1);
  });

  // ---- 途中失敗 ----

  test('FREQ-529-AC-04: 途中失敗(割当の解除の途中・受取行・操作の記録の INSERT に故障を注入)では、台帳・在庫・割当・納品累計・履歴が全部残らず、同じ要求番号は後で作り直せる', async () => {
    const s = await setup([4]);
    const c = s.fixtures[0];
    const old = await waitingOrder(c, 2, '2025-12-01T00:00:00Z');
    const young = await waitingOrder(c, 2, '2026-01-01T00:00:00Z');
    const received = await receivedAll(s, [4]);
    const key = randomUUID();
    const call = () => reverse({
      actor: s.actor, orderId: s.order.id, version: received.version, receiptId: received.receiptId, reason: REASON, expected: 3, key,
      lines: [{ receiptLineId: received.rows[0].id, quantity: 3 }],
    });
    await db().query(`create function public.g2_inject_release_event_failure() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'release' then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
            detail = (select count(*)::text from public.stock_movements where allocation_operation_id = new.operation_id);
        end if;
        return new;
      end $$`);
    await db().query(`create function public.g2_inject_offset_line_failure() returns trigger language plpgsql as $$
      begin
        if new.quantity < 0 then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001',
            detail = (select count(*)::text from public.stock_movements m
              where m.reason = 'allocation_release'
                and m.allocation_operation_id = (select r.operation_id from public.purchase_order_receipts r where r.id = new.receipt_id));
        end if;
        return new;
      end $$`);
    await db().query(`create function public.g2_inject_operation_failure() returns trigger language plpgsql as $$
      begin
        if new.operation = 'purchase_order_receipt_reverse' then
          raise exception 'INJECTED_FAILURE' using errcode = 'P0001', detail = new.operation;
        end if;
        return new;
      end $$`);
    const before = await snapshot();

    // 1) 最初の割当の解除イベントで失敗: 先に台帳の解放 1 行(young の 2 点)は書かれた後
    await db().query('create trigger g2_inject_release_event before insert on public.order_item_allocation_events for each row execute function public.g2_inject_release_event_failure()');
    expect(await rejected(call)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '1' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_release_event on public.order_item_allocation_events');

    // 2) 相殺の受取行で失敗: 2 つの解放と、調整の台帳は書かれた後(解放 2 行)
    await db().query('create trigger g2_inject_offset_line before insert on public.purchase_order_receipt_lines for each row execute function public.g2_inject_offset_line_failure()');
    expect(await rejected(call)).toMatchObject({ code: 'P0001', message: 'INJECTED_FAILURE', detail: '2' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_offset_line on public.purchase_order_receipt_lines');

    // 3) 最後の操作の記録で失敗: 先に書いた物が全部残らない
    await db().query('create trigger g2_inject_operation before insert on private.group_g_operations for each row execute function public.g2_inject_operation_failure()');
    expect(await rejected(call)).toMatchObject({ code: 'P0001', detail: 'purchase_order_receipt_reverse' });
    expect(await snapshot()).toEqual(before);
    await db().query('drop trigger g2_inject_operation on private.group_g_operations');
    expect([await allocated(old.line), await allocated(young.line)]).toEqual([2, 2]);

    expect((await call()).replayed).toBe(false);
    expect([await allocated(old.line), await allocated(young.line)]).toEqual([1, 0]);
  });

  // ---- 関数の形と ACL ----

  test('FREQ-540-AC-07: 取消の private 本体は DEFINER・postgres・search_path 空で service_role だけが EXECUTE でき、public 入口は SQL の INVOKER 委譲。一覧に private 本体だけが入る', async () => {
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
    const names = ['_purchase_order_id', '_expected_version', '_receipt_id', '_lines', '_reason', '_expected_release_quantity', '_actor_id', '_request_key'];
    expect(await read(`private.${REVERSE_SIGNATURE}`)).toEqual({ ...common, definer: true, language: 'plpgsql', names });
    expect(await read(`public.${REVERSE_SIGNATURE}`)).toEqual({ ...common, definer: false, language: 'sql', names });
    const list = (await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows;
    const oids = new Set(list.map((row) => row.oid));
    const privateOid = (await db().query('select $1::regprocedure::oid::text as oid', [`private.${REVERSE_SIGNATURE}`])).rows[0].oid;
    const publicOid = (await db().query('select $1::regprocedure::oid::text as oid', [`public.${REVERSE_SIGNATURE}`])).rows[0].oid;
    expect(oids.has(privateOid)).toBe(true);
    expect(oids.has(publicOid)).toBe(false);
  });

  test('FREQ-540-AC-07: anon / authenticated は public 入口も private 本体も呼べず(42501)、service_role は public 入口から実行できる', async () => {
    const s = await setup([5]);
    const received = await receivedAll(s, [5]);
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
      `select ${schema}.admin_reverse_purchase_order_receipt($1::uuid, $2::integer, $3::uuid, $4::jsonb, $5::text, $6::integer, $7::uuid, $8::uuid) as r`,
      [s.order.id, received.version, received.receiptId, JSON.stringify([{ receiptLineId: received.rows[0].id, quantity: 1 }]), REASON, null, s.actor, randomUUID()],
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const schema of ['public', 'private']) expect(await attempt(role, ...call(schema))).toEqual({ code: '42501' });
    }
    const ok = await attempt('service_role', ...call('public'));
    expect(ok.rows?.[0].r).toMatchObject({ version: received.version + 1, releasedQuantity: 0, replayed: false });
  });
});
