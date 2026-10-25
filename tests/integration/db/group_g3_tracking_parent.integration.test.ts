/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb, connectLocalDb, type PgClient } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { seedGroupG3ReadyOrder } from './helpers/group-g3-fixtures';
import { withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';
import {
  claimDeliveryFor, deliveryShipment, enableDeliveryTracking, leaseDeliveryRegistration, patchDeliveryRegistration, recordReadResult,
  recordRegistrationResult, restoreCommittedDeliveryState, setDeliveryTracking, trackedShipment, waitForDeliveryLock,
} from './helpers/delivery-tracking-fixtures';
import { loadOrderStatusPublicMaterial, type OrderStatusStore } from '@/lib/orders/status/status-store';
import { getOrderDeliveryDetail } from '@/lib/orders/tracking/delivery-store';
import { buildCustomerOrderPublicView } from '@/lib/orders/customer-order-view';
import { toOrderNumber } from '@/lib/orders/order-number';

/**
 * G-3 Task 8（FREQ-534-AC-04、FREQ-541-AC-03）: 追跡の親（代表の登録）と、配送の読み直しの結果の票への展開。
 * 外部への登録は票×追跡の版に1つで、代表（有効な発送の order_id が最小）の既存E-4の登録行だけが持つ。参加の発送に登録行は作らない。
 * 読み直しの結果は代表の借りの印で書き、票の全注文の有効な発送へ同じ内容で反映する（登録の更新・要対応・戻り値は代表について1回だけ）。
 * お客様向けの2つの読取（get_order_delivery_detail・get_order_status_public_material）は、参加の発送にも代表の登録の状態を返す。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 * 2接続の試験（ロック・並行）だけは準備を commit し、最後に共有の配送の状態を戻す（消せない注文は次の reset で捨てる）。
 */
jest.setTimeout(120000);

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const READS = fs.readFileSync(path.join(MIGRATIONS, '20261025070821_group_g3_shipping_reads.sql'), 'utf8');
const ACTIONS = fs.readFileSync(path.join(MIGRATIONS, '20261025134538_group_g3_shipping_actions.sql'), 'utf8');
const G1 = fs.readFileSync(path.join(MIGRATIONS, '20261023211425_group_g1_allocation.sql'), 'utf8');
const E4_ADMIN = fs.readFileSync(path.join(MIGRATIONS, '20261021221140_delivery_tracking_admin.sql'), 'utf8');
const E5_LINKS = fs.readFileSync(path.join(MIGRATIONS, '20261022084844_order_status_links.sql'), 'utf8');

/** `from` から `to` の手前まで（どちらも無ければ試験を落とす） */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = start < 0 ? -1 : text.indexOf(to, start + from.length);
  expect({ from, found: start >= 0 && end > start }).toEqual({ from, found: true });
  return text.slice(start, end);
}
/** `CREATE …` から最初の `$$;` まで */
function functionText(text: string, head: string): string {
  return between(text, head, '\n$$;') + '\n$$;';
}
const codeLines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('--'));
const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();

const READ_RESULT_G1 = (): string => between(G1, 'CREATE FUNCTION private.record_delivery_read_result(', 'ALTER FUNCTION private.record_delivery_read_result(');
const READ_RESULT_NEW = (): string => between(ACTIONS, 'CREATE OR REPLACE FUNCTION private.record_delivery_read_result(', '-- 3. The closed list of writers.');
const LOCK_STATEMENT = /PERFORM \w+\.id FROM public\.(\w+) AS \w+[^;]*?FOR UPDATE;/g;
const lockStatements = (text: string): Array<{ table: string; text: string }> =>
  [...codeLines(text).join(' ').matchAll(LOCK_STATEMENT)].map((match) => ({ table: match[1], text: norm(match[0]) }));

type Fulfillment = { orderId: string; fulfillmentId: string; number: number; completesOrder: boolean };
type Confirmed = { id: string; number: string; version: number; fulfillments: Fulfillment[] };
type Updated = { id: string; version: number; trackingVersion: number; replayed: boolean };

describe('G-3 tracking parent migrations (no database)', () => {
  test('FREQ-540-AC-11: reads の移行は ASCII だけ・BOM と CR と全角空白が無く、BEGIN・NOTIFY・COMMIT が1つ、G3B の節の印が1組で、private の USAGE を変える文が無い', () => {
    expect(READS.charCodeAt(0)).not.toBe(0xfeff);
    expect(READS).not.toMatch(/[\r　 ﻿​-‍]/);
    expect(READS).not.toMatch(/[^\x00-\x7f]/);
    const lines = READS.split('\n');
    expect(lines.filter((line) => /^\s*BEGIN\s*;/i.test(line))).toEqual(['BEGIN;']);
    expect(lines.filter((line) => /^\s*COMMIT\s*;/i.test(line))).toEqual(['COMMIT;']);
    expect(READS.match(/NOTIFY pgrst/g)).toHaveLength(1);
    const markers = ['-- G3B_BODY_BEGIN', '-- G3B_BODY_END', '-- G3B_FINAL_ASSERT_BEGIN', '-- G3B_FINAL_ASSERT_END'];
    const positions = markers.map((marker) => {
      expect({ marker, count: READS.split(`\n${marker}\n`).length - 1 }).toEqual({ marker, count: 1 });
      return READS.indexOf(marker);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(READS.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(positions[3]);
    const code = lines.filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bON\s+SCHEMA\s+private\b/i);
    expect(code).not.toMatch(/\bGRANT\b[^;]*\bTO\b[^;]*\b(?:PUBLIC|anon|authenticated)\b/i);
  });

  test('FREQ-534-AC-04: 置換する3つの読取は、E-4・E-5 の本文から指定の1か所だけが違い（登録の引きが owner、バックフィルは owner が自分の時だけ）、助けは読むだけの内部関数で誰にも EXECUTE させない', () => {
    const registration = '            FROM private.fulfillment_tracking_registrations AS r\n            WHERE r.fulfillment_id = f.id\n              AND r.tracking_version = f.tracking_version';
    const owner = '            FROM private.fulfillment_tracking_registrations AS r\n            WHERE r.fulfillment_id = private.tracking_registration_owner(f.id, f.tracking_version)\n              AND r.tracking_version = f.tracking_version';
    const expectedDetail = functionText(E4_ADMIN, 'CREATE OR REPLACE FUNCTION public.get_order_delivery_detail(_order_id uuid)').replace(registration, owner);
    const expectedMaterial = functionText(E5_LINKS, 'CREATE OR REPLACE FUNCTION public.get_order_status_public_material(_order_id uuid)').replace(registration, owner);
    const backfill = functionText(E4_ADMIN, 'CREATE OR REPLACE FUNCTION private.delivery_tracking_backfill_targets()');
    const guard = "    AND COALESCE(r.expires_at, s.started_at + interval '30 days') > pg_catalog.now()\n$$;";
    expect(backfill.split(guard)).toHaveLength(2);
    // 関数で置き換える（文字列の置換では `$$` が `$` に化ける）
    const expectedBackfill = backfill.replace(guard, () => guard.replace('\n$$;', () => '\n    AND private.tracking_registration_owner(f.id, f.tracking_version) = f.id\n$$;'));
    expect(expectedDetail).not.toBe(functionText(E4_ADMIN, 'CREATE OR REPLACE FUNCTION public.get_order_delivery_detail(_order_id uuid)'));
    expect(expectedMaterial).not.toBe(functionText(E5_LINKS, 'CREATE OR REPLACE FUNCTION public.get_order_status_public_material(_order_id uuid)'));
    for (const expected of [expectedDetail, expectedMaterial, expectedBackfill]) {
      expect({ head: expected.split('\n')[0], once: READS.split(expected).length - 1 }).toEqual({ head: expected.split('\n')[0], once: 1 });
    }
    const helper = functionText(READS, 'CREATE FUNCTION private.tracking_registration_owner(');
    expect(helper).toContain('LANGUAGE sql STABLE SECURITY DEFINER SET search_path = \'\'');
    expect(READS).toContain('ALTER FUNCTION private.tracking_registration_owner(uuid,integer) OWNER TO postgres;');
    expect(READS).toContain('REVOKE ALL ON FUNCTION private.tracking_registration_owner(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;');
    expect(READS).not.toMatch(/GRANT EXECUTE ON FUNCTION private\.tracking_registration_owner/);
    expect(helper).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i);
  });

  test('FREQ-541-AC-03: 読み直しの結果の置換は、G-1 の本体から指定の13行だけを外し（コメントを除く）、共通の押さえは1回・在庫の閉包の道具は呼ばない', () => {
    const g1Lines = codeLines(READ_RESULT_G1());
    const newLines = new Set(codeLines(READ_RESULT_NEW()));
    expect(g1Lines.filter((line) => !newLines.has(line))).toEqual([
      'CREATE FUNCTION private.record_delivery_read_result(',
      "VALUES (_fulfillment_id, _tracking_version, v_status, v_event_at, 'tracking', v_provider_sub)",
      'v_delivered_at := GREATEST(COALESCE(v_delivered, v_event_at), v_f.shipped_at);',
      "v_request_key := pg_catalog.md5('delivery:' || _fulfillment_id::text || ':' || _tracking_version::text || ':' || 'delivered')::uuid;",
      'v_before := private.capture_group_g_item_states(ARRAY[v_order_id]);',
      "PERFORM private.apply_tracking_status(_fulfillment_id, 'delivered', v_delivered_at, v_delivered_at);",
      "PERFORM private.enqueue_delivery_email(_fulfillment_id, _tracking_version, 'delivered');",
      'PERFORM private.record_group_g_item_state_changes(v_before, ARRAY[v_order_id], v_operation, 1,',
      "'operation', 'delivery_reflect', 'fulfillment_id', _fulfillment_id, 'tracking_version', _tracking_version,",
      "'fulfillment', _fulfillment_id::text, NULL,",
      "pg_catalog.jsonb_build_object('fulfillment_id', _fulfillment_id, 'order_id', v_order_id,",
      'PERFORM private.apply_tracking_status(_fulfillment_id, v_status, v_event_at, NULL);',
      "PERFORM private.enqueue_delivery_email(_fulfillment_id, _tracking_version, 'out_for_delivery');",
    ]);
    const body = between(READ_RESULT_NEW(), 'AS $$', '\n$$;');
    expect(body.split('pg_advisory_xact_lock')).toHaveLength(2);
    expect(body).not.toMatch(/lock_group_g_inventory|lock_group_g_shipment_slips|allocate_group_g_fifo/);
    expect(body).not.toMatch(/\bpublic\.[a-z_]+\(/);
    // 登録の行・要対応・戻り値は代表（_fulfillment_id）にだけ書く。対象ごとの繰り返しの中で登録の表を更新するのは、代表の時だけ
    expect(body).toContain('IF v_target = _fulfillment_id THEN\n              UPDATE private.fulfillment_tracking_registrations AS r');
    expect(body.match(/set_delivery_attention\(v_target|close_delivery_attention\(v_target/g)).toBeNull();
  });

  test('FREQ-541-AC-03: 票の代表の読み直しの結果は、G-1 の本体と同じ表の並びを、表ごとに票の全注文をまとめて固定し（orders → order_items → 割当 → 返品 → … → 取消申請の行 → 発送 → 代表の登録）、ある表を取った後に前の表へ戻らない（prosrc の突き合わせ）', () => {
    const g1 = lockStatements(READ_RESULT_G1());
    expect(g1.map((statement) => statement.table)).toEqual([
      'orders', 'order_items', 'order_item_allocations', 'order_returns', 'order_return_lines', 'order_return_receipts',
      'order_return_receipt_lines', 'order_refunds', 'order_refund_lines', 'order_cancel_requests', 'order_cancel_request_lines', 'order_fulfillments',
    ]);
    const body = between(READ_RESULT_NEW(), 'AS $$', '\n$$;');
    const all = lockStatements(body);
    expect(all).toHaveLength(24);
    const single = all.slice(0, 12);
    const slip = all.slice(12);
    // 票の代表でない発送は G-1 のとおり自分の注文だけ（文が一字も違わない）
    expect(single.map((statement) => statement.text)).toEqual(g1.map((statement) => statement.text));
    // 票の代表は同じ12表を同じ順序で、各表を票の全注文（= ANY(v_orders)、id 昇順）で1回ずつ。単独の注文の変数は使わない
    const toSlip = (text: string): string => text.replace(/= v_order_id/g, '= ANY(v_orders)')
      .replace('WHERE o.id = ANY(v_orders) FOR UPDATE', 'WHERE o.id = ANY(v_orders) ORDER BY o.id FOR UPDATE');
    expect(slip.map((statement) => statement.text)).toEqual(g1.map((statement) => toSlip(statement.text)));
    expect(new Set(slip.map((statement) => statement.table)).size).toBe(12);
    for (const statement of slip) expect(statement.text).not.toContain('v_order_id');
    for (const statement of slip) expect(statement.text).toMatch(/ORDER BY \w+\.id FOR UPDATE;$/);
    // 文の並び: 共通の押さえ → 設定（FOR SHARE）→ 票の引き → 分岐 → … → 発送の読み → 代表の登録の行
    const mark = (text: string): number => {
      const at = body.indexOf(text);
      expect({ text, found: at >= 0 }).toEqual({ text, found: true });
      return at;
    };
    const elseAt = body.indexOf('\n  ELSE\n', mark('FROM public.order_fulfillments AS f WHERE f.order_id = v_order_id ORDER BY f.id FOR UPDATE'));
    const positions = [
      mark('pg_catalog.pg_advisory_xact_lock(190521, 1)'), mark('FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE'),
      mark('FROM private.shipment_tracking_registrations AS sr'), mark('IF v_slip_id IS NULL THEN'),
      body.indexOf('FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE'), elseAt,
      body.indexOf('FROM public.orders AS o WHERE o.id = ANY(v_orders) ORDER BY o.id FOR UPDATE'),
      body.indexOf('FROM public.order_fulfillments AS f WHERE f.order_id = ANY(v_orders) ORDER BY f.id FOR UPDATE'),
      mark('SELECT f.* INTO v_f FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id;'),
      mark('FROM private.fulfillment_tracking_registrations AS r\n  WHERE r.fulfillment_id = _fulfillment_id\n    AND r.tracking_version = _tracking_version\n  FOR UPDATE;'),
      mark('v_targets := ARRAY[_fulfillment_id];'),
    ];
    expect(positions.every((at) => at > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
    // 最初の行の鍵（FOR UPDATE / FOR SHARE）は共通の押さえの後
    expect(Math.min(body.indexOf('FOR UPDATE'), body.indexOf('FOR SHARE'))).toBeGreaterThan(positions[0]);
  });
});

describeLocalDb('G-3 tracking parent: leader registration and fan-out of read results', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string; let admin: string; let today: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']); admin = await flow.createActor(['admin']); today = await flow.today();
  });
  afterEach(async () => { await db().query('rollback'); });

  const ready = () => seedGroupG3ReadyOrder(db());
  const readyOrders = async (count: number) => {
    const rows: Awaited<ReturnType<typeof ready>>[] = [];
    for (let index = 0; index < count; index += 1) rows.push(await ready());
    return rows;
  };
  const draft = async (lines: { orderItemId: string; quantity: number }[]) => (await db().query(
    'select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r', [JSON.stringify(lines), actor, randomUUID()],
  )).rows[0].r as { id: string; number: string; version: number };
  type ConfirmOptions = { tracking?: string | null; carrier?: string | null; notify?: boolean };
  const confirm = async (id: string, o: ConfirmOptions & { number: string | null }): Promise<Confirmed> => (await db().query(
    'select public.admin_confirm_shipment_slip($1,1,$2,$3,$4::date,$5,$6,$7) as r',
    [id, o.carrier === undefined ? 'yamato' : o.carrier, o.number, today, o.notify === undefined ? true : o.notify, actor, randomUUID()],
  )).rows[0].r;
  /**
   * n 注文の票を作って確定する。代表（order_id が最小）を先頭にした発送の並びも返す。
   * 伝票番号は試験ごとに違う値にする（同じ（運送会社, 番号）の組が他の追跡中の行と重なると、借り出しや外への停止の印の結果が変わるため）。
   */
  const shipSlip = async (count: number, o: ConfirmOptions & { quantity?: number } = {}) => {
    const orders = await readyOrders(count);
    const slip = await draft(orders.map((f) => ({ orderItemId: f.orderItemId, quantity: o.quantity ?? 2 })));
    const raw = o.tracking === undefined ? `pt-${randomUUID().replace(/-/g, '').slice(0, 10)}` : o.tracking;
    const confirmed = await confirm(slip.id, { ...o, number: raw });
    const sorted = [...confirmed.fulfillments].sort((x, y) => (x.orderId < y.orderId ? -1 : x.orderId > y.orderId ? 1 : 0));
    const [leader, ...participants] = sorted;
    return { orders, slip, confirmed, leader, participants, all: sorted, ids: sorted.map((row) => row.fulfillmentId), number: raw === null ? null : raw.toUpperCase() };
  };
  const updateTracking = async (slipId: string, o: { version?: number; tracking?: string; notify?: boolean } = {}): Promise<Updated> => (await db().query(
    'select public.admin_update_shipment_slip_tracking($1,$2,$3,$4,$5,$6,$7) as r',
    [slipId, o.version ?? 2, 'sagawa', o.tracking ?? 'NEW-456', o.notify ?? true, actor, randomUUID()],
  )).rows[0].r;
  const markRegistered = (fulfillmentId: string, version = 1, everRegistered = true) => patchDeliveryRegistration(
    db(), fulfillmentId, `state='registered',ever_registered=${everRegistered},registered_at=now()`, version);
  const at = async (minutes: number): Promise<string> => new Date((await db().query(
    'select now() + make_interval(mins => $1::int) as at', [minutes])).rows[0].at).toISOString();
  const read = (status: string, when: string): Record<string, unknown> => ({
    outcome: 'ok', status, provider_status: status, provider_sub_status: null, happened_at: when,
    delivered_at: status === 'delivered' ? when : null, read_at: when, error_code: null,
  });
  /** 代表の借りの印を置いて、読み直しの結果を書く（借り出しを通さない） */
  const applyRead = async (leaderId: string, status: string, minutes: number, version = 1) => recordReadResult(
    db(), await leaseDeliveryRegistration(db(), leaderId, version), read(status, await at(minutes)));

  const parents = async (slipId: string) => (await db().query(
    `select tracking_version, leader_fulfillment_id, carrier, tracking_number from private.shipment_tracking_registrations
     where slip_id=$1 order by tracking_version`, [slipId])).rows;
  const registrations = async (ids: string[]) => (await db().query(
    `select fulfillment_id, tracking_version, state, stop_reason, ever_registered, provider_stop_pending, carrier, tracking_number
     from private.fulfillment_tracking_registrations where fulfillment_id=any($1::uuid[]) order by tracking_version, fulfillment_id`, [ids])).rows;
  const statusesOf = async (ids: string[]) => (await db().query(
    `select id, delivery_status, tracking_version, delivered_at is not null as delivered, delivered_at >= shipped_at as after_shipped
     from public.order_fulfillments where id=any($1::uuid[]) order by id`, [ids])).rows;
  const trackingEvents = async (id: string) => (await db().query(
    `select tracking_version, status from public.order_fulfillment_events where fulfillment_id=$1 and source='tracking'
     order by happened_at, status`, [id])).rows;
  const emails = async (kind: string, ids: string[]) => (await db().query(
    `select order_id, fulfillment_id, tracking_version, status from private.order_email_outbox
     where kind=$1 and fulfillment_id=any($2::uuid[]) order by order_id`, [kind, ids])).rows;
  const attention = async (ids: string[]) => (await db().query(
    `select fulfillment_id, kind, resolved_at is null as open from public.order_fulfillment_attention
     where fulfillment_id=any($1::uuid[]) order by opened_at, kind`, [ids])).rows;
  const itemStates = async (orderId: string) => Object.fromEntries((await db().query(
    `select status, sum(quantity)::int as n from public.list_admin_order_item_states($1::uuid[]) group by status order by status`, [[orderId]],
  )).rows.map((row) => [row.status, row.n]));
  const owner = async (fulfillmentId: string, version: number) => (await db().query(
    'select private.tracking_registration_owner($1::uuid,$2::integer) as id', [fulfillmentId, version])).rows[0].id as string;

  describe.each([2, 3])('FREQ-534-AC-04 追跡オンで %i 注文の票を確定する', (count) => {
    test(`FREQ-534-AC-04: 追跡オンで番号つきの${count}注文の票を確定すると、親の行が票×版に1行、代表(order_id が最小)の登録行が1行(pending)だけで、参加の発送には登録行が無い`, async () => {
      await enableDeliveryTracking(db());
      const { slip, leader, participants, ids, number } = await shipSlip(count);
      expect(participants).toHaveLength(count - 1);
      expect(await parents(slip.id)).toEqual([{ tracking_version: 1, leader_fulfillment_id: leader.fulfillmentId, carrier: 'yamato', tracking_number: number }]);
      expect(await registrations(ids)).toEqual([expect.objectContaining({
        fulfillment_id: leader.fulfillmentId, tracking_version: 1, state: 'pending', ever_registered: false, carrier: 'yamato', tracking_number: number })]);
      expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
      // owner: 参加の発送の登録は代表の行が代わりに語る。親の行の無い版・票に属さない発送・知らない発送は自分
      for (const row of participants) {
        expect(await owner(row.fulfillmentId, 1)).toBe(leader.fulfillmentId);
        expect(await owner(row.fulfillmentId, 2)).toBe(row.fulfillmentId);
      }
      expect(await owner(leader.fulfillmentId, 1)).toBe(leader.fulfillmentId);
      const unknown = randomUUID();
      expect(await owner(unknown, 1)).toBe(unknown);
    });
  });

  test('FREQ-534-AC-04: claim_delivery_tracking は代表の1行だけを返す(外部登録は票×版に1回)。登録の結果 registered の後、同じ組の参加は借りられない', async () => {
    await enableDeliveryTracking(db());
    const { leader, participants, ids, number } = await shipSlip(3);
    const first = await claimDeliveryFor(db(), ids);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ fulfillment_id: leader.fulfillmentId, tracking_version: 1, carrier: 'yamato', tracking_number: number, action: 'register' });
    expect(await recordRegistrationResult(db(), first[0], 'registered')).toMatchObject({ applied: true, state: 'registered' });
    // 登録の後は今すぐ1回読む。借りられるのは、また代表の1行だけ（参加の発送は一度も借りられない）
    const second = await claimDeliveryFor(db(), ids);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ fulfillment_id: leader.fulfillmentId, action: 'read' });
    expect(await claimDeliveryFor(db(), ids)).toEqual([]);
    expect((await db().query(`select count(*)::int as n from private.fulfillment_tracking_registrations
      where fulfillment_id=any($1::uuid[]) and carrier='yamato' and tracking_number=$2`, [ids, number])).rows[0].n).toBe(1);
    expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
  });

  test('FREQ-534-AC-04: 読み直しの結果が in_transit→out_for_delivery→delivered のとき、代表と参加の両方の発送が同じ状況・出来事(source tracking)になり、配達中・配達済みのメールは注文ごとに1通、delivery_reflect の操作と品物状態(shipped→delivered)も注文ごとに1回、登録行は代表の1行だけが stopped/delivered', async () => {
    await enableDeliveryTracking(db());
    const { orders, leader, participants, ids } = await shipSlip(3);
    await markRegistered(leader.fulfillmentId);
    expect(await attention(ids)).toEqual([]);
    for (const order of orders) expect(await itemStates(order.orderId)).toEqual({ ready: 2, shipped: 2 });

    expect(await applyRead(leader.fulfillmentId, 'in_transit', 1)).toEqual({ applied: true, changed: true, stopped: false });
    expect((await statusesOf(ids)).map((row) => row.delivery_status)).toEqual(['in_transit', 'in_transit', 'in_transit']);
    for (const id of ids) expect(await trackingEvents(id)).toEqual([{ tracking_version: 1, status: 'in_transit' }]);
    expect(await emails('out_for_delivery', ids)).toEqual([]);

    expect(await applyRead(leader.fulfillmentId, 'out_for_delivery', 2)).toEqual({ applied: true, changed: true, stopped: false });
    expect((await statusesOf(ids)).map((row) => row.delivery_status)).toEqual(['out_for_delivery', 'out_for_delivery', 'out_for_delivery']);
    const outForDelivery = await emails('out_for_delivery', ids);
    expect(outForDelivery).toHaveLength(3);
    expect(outForDelivery.map((row) => row.order_id).sort()).toEqual(orders.map((order) => order.orderId).sort());
    for (const row of outForDelivery) expect(row).toMatchObject({ tracking_version: 1, status: 'pending' });
    expect(new Set(outForDelivery.map((row) => row.fulfillment_id)).size).toBe(3);
    expect(await registrations(ids)).toEqual([expect.objectContaining({ fulfillment_id: leader.fulfillmentId, state: 'registered' })]);

    expect(await applyRead(leader.fulfillmentId, 'delivered', 3)).toEqual({ applied: true, changed: true, stopped: true });
    expect(await statusesOf(ids)).toEqual(ids.slice().sort().map((id) => ({ id, delivery_status: 'delivered', tracking_version: 1, delivered: true, after_shipped: true })));
    for (const id of ids) {
      expect((await trackingEvents(id)).map((row) => row.status).sort()).toEqual(['delivered', 'in_transit', 'out_for_delivery']);
    }
    const delivered = await emails('delivered', ids);
    expect(delivered.map((row) => row.order_id).sort()).toEqual(orders.map((order) => order.orderId).sort());
    expect(new Set(delivered.map((row) => row.fulfillment_id)).size).toBe(3);
    // 操作の記録は対象ごとに1行。鍵は G-1 の式を対象の発送IDで
    const operations = (await db().query(`select cause_id, request_key = md5('delivery:' || cause_id || ':1:delivered')::uuid as derived
      from private.group_g_operations where operation='delivery_reflect' and cause_id=any($1::text[]) order by cause_id`, [ids])).rows;
    expect(operations).toEqual(ids.slice().sort().map((id) => ({ cause_id: id, derived: true })));
    for (const order of orders) {
      expect(await itemStates(order.orderId)).toEqual({ delivered: 2, ready: 2 });
      expect((await db().query(`select from_status, to_status, reason from public.order_item_state_events
        where order_item_id=$1 and reason='delivery_reflect'`, [order.orderItemId])).rows).toEqual([{ from_status: 'shipped', to_status: 'delivered', reason: 'delivery_reflect' }]);
    }
    // 登録行は代表の1行だけが stopped / delivered。参加には行が無い。要対応は付かない
    expect(await registrations(ids)).toEqual([expect.objectContaining({ fulfillment_id: leader.fulfillmentId, state: 'stopped', stop_reason: 'delivered' })]);
    expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
    expect(await attention(ids)).toEqual([]);
  });

  test('FREQ-534-AC-04: 配達失敗の読み直しは全注文の状況を failure にするが、要対応は代表の発送にだけ1行付き、配達中のメールは無い', async () => {
    await enableDeliveryTracking(db());
    const { leader, participants, ids } = await shipSlip(3);
    await markRegistered(leader.fulfillmentId);
    expect(await applyRead(leader.fulfillmentId, 'failure', 1)).toEqual({ applied: true, changed: true, stopped: false });
    expect((await statusesOf(ids)).map((row) => row.delivery_status)).toEqual(['failure', 'failure', 'failure']);
    expect(await attention(ids)).toEqual([{ fulfillment_id: leader.fulfillmentId, kind: 'delivery_failure', open: true }]);
    expect(await attention(participants.map((row) => row.fulfillmentId))).toEqual([]);
    // 状況が変われば代表の要対応だけが閉じる
    expect(await applyRead(leader.fulfillmentId, 'in_transit', 2)).toEqual({ applied: true, changed: true, stopped: false });
    expect(await attention(ids)).toEqual([{ fulfillment_id: leader.fulfillmentId, kind: 'delivery_failure', open: false }]);
  });

  test('FREQ-534-AC-04: 古い読み直し(同じ版の一番新しい出来事より前)は票の全注文の状況・出来事を変えず、同じ状況の再読は出来事を増やさない', async () => {
    await enableDeliveryTracking(db());
    const { leader, ids } = await shipSlip(2);
    await markRegistered(leader.fulfillmentId);
    expect(await applyRead(leader.fulfillmentId, 'out_for_delivery', 5)).toMatchObject({ applied: true, changed: true });
    const before = await Promise.all(ids.map(trackingEvents));
    expect(await applyRead(leader.fulfillmentId, 'in_transit', 1)).toEqual({ applied: true, changed: false, stopped: false });
    expect(await applyRead(leader.fulfillmentId, 'out_for_delivery', 6)).toEqual({ applied: true, changed: false, stopped: false });
    expect(await Promise.all(ids.map(trackingEvents))).toEqual(before);
    expect((await statusesOf(ids)).map((row) => row.delivery_status)).toEqual(['out_for_delivery', 'out_for_delivery']);
  });

  test('FREQ-534-AC-04: すでに配達済みの参加の発送には、あとの読み直しの結果を反映しない（状況・配達済みの時刻・出来事・メール・操作の記録が変わらない）。代表とほかの参加には反映する', async () => {
    await enableDeliveryTracking(db());
    const { leader, participants, ids } = await shipSlip(3);
    await markRegistered(leader.fulfillmentId);
    const [done, other] = participants;
    // 今のどの経路でも起きない状態（代表が未配達のまま参加だけが配達済み）を、手動の印で直接作る
    await db().query("select set_config('app.fulfillment_change', 'manual', true)");
    await db().query("update public.order_fulfillments set delivery_status='delivered', delivery_status_at=now(), delivered_at=now() where id=$1", [done.fulfillmentId]);
    await db().query("select set_config('app.fulfillment_change', '', true)");
    const doneRow = async () => (await db().query('select delivery_status, delivery_status_at, delivered_at from public.order_fulfillments where id=$1', [done.fulfillmentId])).rows[0];
    const before = await doneRow();
    expect(before.delivered_at).not.toBeNull();

    expect(await applyRead(leader.fulfillmentId, 'out_for_delivery', 2)).toEqual({ applied: true, changed: true, stopped: false });
    expect(await doneRow()).toEqual(before);
    expect(await trackingEvents(done.fulfillmentId)).toEqual([]);
    expect((await emails('out_for_delivery', ids)).map((row) => row.fulfillment_id).sort())
      .toEqual([leader.fulfillmentId, other.fulfillmentId].sort());
    expect((await statusesOf([leader.fulfillmentId, other.fulfillmentId])).map((row) => row.delivery_status)).toEqual(['out_for_delivery', 'out_for_delivery']);

    expect(await applyRead(leader.fulfillmentId, 'delivered', 3)).toEqual({ applied: true, changed: true, stopped: true });
    expect(await doneRow()).toEqual(before);
    expect(await trackingEvents(done.fulfillmentId)).toEqual([]);
    expect((await emails('delivered', ids)).map((row) => row.fulfillment_id).sort()).toEqual([leader.fulfillmentId, other.fulfillmentId].sort());
    expect((await db().query(`select cause_id from private.group_g_operations where operation='delivery_reflect' and cause_id=any($1::text[]) order by cause_id`, [ids])).rows
      .map((row) => row.cause_id)).toEqual([leader.fulfillmentId, other.fulfillmentId].sort());
  });

  test('FREQ-541-AC-03: 参加の注文について get_order_delivery_detail と get_order_status_public_material が代表の登録の状態(registered / 止めた)を返し、お客様向けの customer-order-view が配送の状況を出す。どの注文の出力にも他の注文の情報(注文番号・品物・発送)は入らない', async () => {
    await enableDeliveryTracking(db());
    const { orders, leader, participants, all } = await shipSlip(3);
    const store = { rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'get_order_status_public_material' && name !== 'get_order_delivery_detail') throw new Error('unexpected rpc');
      const rows = (await db().query(`select public.${name}($1::uuid) as r`, [args._order_id])).rows;
      return { data: rows[0].r, error: null };
    } } as unknown as OrderStatusStore;
    const customerView = async (orderId: string) => {
      const material = await loadOrderStatusPublicMaterial(store, orderId);
      if (!material) throw new Error('material expected');
      return buildCustomerOrderPublicView({ ...material, returnSection: null, trackingKeyConfigured: true, signImage: async () => null });
    };
    const rawOutputs = async (orderId: string) => JSON.stringify([
      (await db().query('select public.get_order_delivery_detail($1::uuid) as r', [orderId])).rows[0].r,
      (await db().query('select public.get_order_status_public_material($1::uuid) as r', [orderId])).rows[0].r,
    ]);
    const expectNoOtherOrders = async () => {
      for (const order of orders) {
        const text = await rawOutputs(order.orderId);
        expect(text).toContain(order.orderId);
        for (const other of orders.filter((candidate) => candidate.orderId !== order.orderId)) {
          for (const forbidden of [other.orderId, toOrderNumber(other.orderId), other.orderItemId, ...all.filter((row) => row.orderId === other.orderId).map((row) => row.fulfillmentId)]) {
            expect({ order: order.orderId, leaks: text.includes(forbidden) }).toEqual({ order: order.orderId, leaks: false });
          }
        }
        // 代表の登録の要約は、状態など登録の列だけ。代表の注文や発送の名指しは無い
        const detail = (await db().query('select public.get_order_delivery_detail($1::uuid) as r', [order.orderId])).rows[0].r;
        expect(Object.keys(detail.fulfillments[0].registration).sort()).toEqual(['ever_registered', 'expires_at', 'failure_kind', 'state', 'stop_reason']);
        const material = (await db().query('select public.get_order_status_public_material($1::uuid) as r', [order.orderId])).rows[0].r;
        expect(Object.keys(material.delivery_detail.fulfillments[0].registration).sort()).toEqual(['ever_registered', 'state']);
        expect(material.fulfillments.map((row: { fulfillment_id: string }) => row.fulfillment_id)).toEqual(all.filter((row) => row.orderId === order.orderId).map((row) => row.fulfillmentId));
      }
    };
    const registrationOf = async (orderId: string) => (await db().query('select public.get_order_delivery_detail($1::uuid) as r', [orderId])).rows[0].r.fulfillments[0].registration;

    // 代表の登録が pending: 参加の注文にも pending（客には配送の欄を出さない = 票に属さない発送と同じ）
    for (const row of all) expect(await registrationOf(row.orderId)).toMatchObject({ state: 'pending', ever_registered: false, failure_kind: null, stop_reason: null });
    for (const row of participants) expect((await customerView(row.orderId)).shipments[0]).not.toHaveProperty('delivery');
    await expectNoOtherOrders();

    // 登録済み: 参加の注文にも registered が出て、状況が出る
    await markRegistered(leader.fulfillmentId);
    for (const row of all) expect(await registrationOf(row.orderId)).toMatchObject({ state: 'registered', ever_registered: true });
    expect(await applyRead(leader.fulfillmentId, 'in_transit', 1)).toEqual({ applied: true, changed: true, stopped: false });
    for (const row of all) {
      const material = (await db().query('select public.get_order_status_public_material($1::uuid) as r', [row.orderId])).rows[0].r;
      expect(material.delivery_detail.fulfillments).toEqual([expect.objectContaining({
        fulfillment_id: row.fulfillmentId, delivery_status: 'in_transit', registration: { state: 'registered', ever_registered: true } })]);
      const view = await customerView(row.orderId);
      expect(view.orderNumber).toBe(toOrderNumber(row.orderId));
      expect(view.shipments).toHaveLength(1);
      // 経過は、その発送自身の同じ版の出来事を新しい順に全部（発送した時の confirmed と、読み直しの in_transit）。票に属さない発送と同じ
      expect(view.shipments[0]).toMatchObject({ id: row.fulfillmentId, deliveredAt: null, delivery: { status: 'in_transit',
        events: [{ status: 'in_transit', happenedAt: expect.any(String) }, { status: 'confirmed', happenedAt: expect.any(String) }] } });
      expect(view.items.map((item) => item.id)).toEqual([orders.find((order) => order.orderId === row.orderId)!.orderItemId]);
    }
    await expectNoOtherOrders();

    // 配達済み: 代表の登録は stopped（一度は登録できた）。参加の注文にも配達済みの状況が出る
    expect(await applyRead(leader.fulfillmentId, 'delivered', 2)).toEqual({ applied: true, changed: true, stopped: true });
    for (const row of all) {
      expect(await registrationOf(row.orderId)).toMatchObject({ state: 'stopped', stop_reason: 'delivered', ever_registered: true });
      const view = await customerView(row.orderId);
      expect(view.shipments[0]).toMatchObject({ id: row.fulfillmentId, delivery: { status: 'delivered' } });
      expect(view.shipments[0].deliveredAt).not.toBeNull();
      const detail = await getOrderDeliveryDetail(store as never, row.orderId);
      expect(detail.fulfillments).toEqual([expect.objectContaining({ fulfillmentId: row.fulfillmentId, deliveryStatus: 'delivered',
        registration: expect.objectContaining({ state: 'stopped', stopReason: 'delivered', everRegistered: true }) })]);
    }
    await expectNoOtherOrders();
  });

  test('FREQ-541-AC-03: 票に属さない発送の get_order_delivery_detail の登録・バックフィルの対象・owner は従来どおり（自分の行が自分を語り、登録の無い発送は取り込み対象）', async () => {
    await enableDeliveryTracking(db());
    const registered = await trackedShipment(db(), { state: 'registered' });
    expect(await owner(registered.fulfillmentId, 1)).toBe(registered.fulfillmentId);
    const detail = (await db().query('select public.get_order_delivery_detail($1::uuid) as r', [registered.orderId])).rows[0].r;
    expect(detail.fulfillments).toHaveLength(1);
    expect(detail.fulfillments[0].registration).toMatchObject({ state: 'registered', ever_registered: true });
    expect((await db().query('select fulfillment_id from private.delivery_tracking_backfill_targets() where fulfillment_id=$1', [registered.fulfillmentId])).rows).toEqual([]);
    // 追跡をオフにしている間に作った発送は、登録が無く、取り込み対象になる
    await setDeliveryTracking(db(), false, admin);
    const plain = await deliveryShipment(db(), { trackingNumber: `PLAIN-${randomUUID().slice(0, 8)}`, carrier: 'yamato' });
    expect((await db().query('select fulfillment_id, tracking_version from private.delivery_tracking_backfill_targets() where fulfillment_id=$1', [plain.fulfillmentId])).rows)
      .toEqual([{ fulfillment_id: plain.fulfillmentId, tracking_version: 1 }]);
    expect((await db().query('select public.get_order_delivery_detail($1::uuid) as r', [plain.orderId])).rows[0].r.fulfillments[0].registration).toBeNull();
  });

  test('FREQ-534-AC-01 / AC-04: 伝票番号の訂正で、旧版の代表の登録が replaced(外へ登録済みなら provider_stop_pending)になり、新しい親の行(版2)と代表の新しい登録行が1つずつできる。旧版の lease の結果は applied=false で参加を含め何も変えない', async () => {
    await enableDeliveryTracking(db());
    const { slip, leader, participants, ids, number } = await shipSlip(3);
    await markRegistered(leader.fulfillmentId, 1, true);
    const oldLease = await leaseDeliveryRegistration(db(), leader.fulfillmentId, 1);
    expect(await updateTracking(slip.id)).toMatchObject({ version: 3, trackingVersion: 2 });

    expect(await parents(slip.id)).toEqual([
      { tracking_version: 1, leader_fulfillment_id: leader.fulfillmentId, carrier: 'yamato', tracking_number: number },
      { tracking_version: 2, leader_fulfillment_id: leader.fulfillmentId, carrier: 'sagawa', tracking_number: 'NEW-456' },
    ]);
    expect(await registrations(ids)).toEqual([
      expect.objectContaining({ fulfillment_id: leader.fulfillmentId, tracking_version: 1, state: 'stopped', stop_reason: 'replaced', provider_stop_pending: true }),
      expect.objectContaining({ fulfillment_id: leader.fulfillmentId, tracking_version: 2, state: 'pending', ever_registered: false, carrier: 'sagawa', tracking_number: 'NEW-456' }),
    ]);
    expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
    for (const row of participants) expect(await owner(row.fulfillmentId, 2)).toBe(leader.fulfillmentId);

    // 旧版の借りの印: 参加を含め何も変わらない（状況・出来事・メール）
    const statusBefore = await statusesOf(ids);
    const eventsBefore = await Promise.all(ids.map(trackingEvents));
    const emailsBefore = await emails('out_for_delivery', ids);
    expect(await recordReadResult(db(), oldLease, read('in_transit', await at(1)))).toEqual({ applied: false, changed: false, stopped: false });
    // 旧版の登録を追跡中・有効な借りの印に戻しても、発送の版が違うので適用されない
    await patchDeliveryRegistration(db(), leader.fulfillmentId, "state='registered',stop_reason=null,stopped_at=null,provider_stop_pending=false", 1);
    expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), leader.fulfillmentId, 1), read('delivered', await at(1)))).toEqual({ applied: false, changed: false, stopped: false });
    expect(await statusesOf(ids)).toEqual(statusBefore);
    expect(await Promise.all(ids.map(trackingEvents))).toEqual(eventsBefore);
    expect(await emails('out_for_delivery', ids)).toEqual(emailsBefore);
    expect(await emails('delivered', ids)).toEqual([]);
    expect(statusBefore.map((row) => [row.delivery_status, row.tracking_version])).toEqual([['confirmed', 2], ['confirmed', 2], ['confirmed', 2]]);

    // 新しい版(2)の借りの印は票の全注文へ適用される
    await markRegistered(leader.fulfillmentId, 2);
    expect(await applyRead(leader.fulfillmentId, 'in_transit', 2, 2)).toEqual({ applied: true, changed: true, stopped: false });
    expect((await statusesOf(ids)).map((row) => row.delivery_status)).toEqual(['in_transit', 'in_transit', 'in_transit']);
    for (const id of ids) expect(await trackingEvents(id)).toEqual([{ tracking_version: 2, status: 'in_transit' }]);
  });

  test('FREQ-534-AC-01 / AC-04: 外へ登録できていない代表の登録は、訂正で replaced になっても外への停止の印は付かない', async () => {
    await enableDeliveryTracking(db());
    const { slip, leader, ids } = await shipSlip(2);
    await updateTracking(slip.id);
    expect(await registrations(ids)).toEqual([
      expect.objectContaining({ fulfillment_id: leader.fulfillmentId, tracking_version: 1, state: 'stopped', stop_reason: 'replaced', ever_registered: false, provider_stop_pending: false }),
      expect.objectContaining({ fulfillment_id: leader.fulfillmentId, tracking_version: 2, state: 'pending' }),
    ]);
  });

  test('FREQ-534-AC-03: 票の取消で代表の登録が cancelled になり(外へ登録済みなら provider_stop_pending)、参加の発送に外部停止の印は付かない。取消の後は読み直しの結果を適用しない', async () => {
    await enableDeliveryTracking(db());
    const { slip, leader, participants, ids } = await shipSlip(3);
    await markRegistered(leader.fulfillmentId);
    const lease = await leaseDeliveryRegistration(db(), leader.fulfillmentId, 1);
    await db().query('select public.admin_cancel_shipment_slip($1,2,$2,$3)', [slip.id, actor, randomUUID()]);
    expect(await registrations(ids)).toEqual([expect.objectContaining({
      fulfillment_id: leader.fulfillmentId, tracking_version: 1, state: 'stopped', stop_reason: 'cancelled', provider_stop_pending: true })]);
    expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
    expect((await db().query(`select count(*)::int as n from private.fulfillment_tracking_registrations
      where fulfillment_id=any($1::uuid[]) and provider_stop_pending`, [participants.map((row) => row.fulfillmentId)])).rows[0].n).toBe(0);
    expect(await recordReadResult(db(), lease, read('in_transit', await at(1)))).toEqual({ applied: false, changed: false, stopped: false });
    expect((await statusesOf(ids)).map((row) => row.delivery_status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
  });

  test('FREQ-534-AC-04: 追跡をオフにしたまま確定した票は親の行だけ(登録行は無い)で、後からオンにすると backfill_targets は代表だけを返し、admin_set_delivery_tracking の backfilled_count は票ごとに1', async () => {
    await setDeliveryTracking(db(), false, admin);
    const { slip, leader, participants, ids, number } = await shipSlip(3);
    expect(await parents(slip.id)).toEqual([{ tracking_version: 1, leader_fulfillment_id: leader.fulfillmentId, carrier: 'yamato', tracking_number: number }]);
    expect(await registrations(ids)).toEqual([]);
    const targets = async () => (await db().query('select fulfillment_id, tracking_version from private.delivery_tracking_backfill_targets()')).rows;
    const mine = (rows: { fulfillment_id: string }[]) => rows.filter((row) => ids.includes(row.fulfillment_id));
    // 参加の発送は番号・運送会社を持ち、取消も配達済みも登録も無い（従来の条件では取り込み対象）。それでも対象は代表だけ
    expect((await db().query(`select count(*)::int as n from public.order_fulfillments where id=any($1::uuid[]) and cancelled_at is null
      and delivered_at is null and shipping_carrier='yamato' and tracking_number is not null`, [ids])).rows[0].n).toBe(3);
    const before = await targets();
    expect(mine(before)).toEqual([{ fulfillment_id: leader.fulfillmentId, tracking_version: 1 }]);
    expect((await db().query('select backfill_count from public.get_delivery_tracking_settings()')).rows[0].backfill_count).toBe(before.length);
    const switched = await setDeliveryTracking(db(), true, admin);
    expect(switched.backfilled_count).toBe(before.length);
    expect(await registrations(ids)).toEqual([expect.objectContaining({
      fulfillment_id: leader.fulfillmentId, tracking_version: 1, state: 'pending', ever_registered: false, carrier: 'yamato', tracking_number: number })]);
    expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
    expect(mine(await targets())).toEqual([]);
    // 期限内にオフへ戻して再びオンにしても、戻るのは代表の行だけ
    await setDeliveryTracking(db(), false, admin);
    expect(await registrations(ids)).toEqual([expect.objectContaining({ fulfillment_id: leader.fulfillmentId, state: 'stopped', stop_reason: 'disabled' })]);
    expect(mine(await targets())).toEqual([{ fulfillment_id: leader.fulfillmentId, tracking_version: 1 }]);
    await setDeliveryTracking(db(), true, admin);
    expect(await registrations(ids)).toEqual([expect.objectContaining({ fulfillment_id: leader.fulfillmentId, state: 'pending' })]);
    expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
  });

  test('FREQ-534-AC-04: 追跡オフにしたまま番号を訂正・手動の配達済みにしても動き、親の行は版ごとに作られ、登録行は作られない。後からオンにすると現在の版の代表だけが取り込まれる', async () => {
    await setDeliveryTracking(db(), false, admin);
    const { slip, leader, participants, ids, number } = await shipSlip(2);
    expect(await updateTracking(slip.id)).toMatchObject({ version: 3, trackingVersion: 2 });
    expect(await parents(slip.id)).toEqual([
      { tracking_version: 1, leader_fulfillment_id: leader.fulfillmentId, carrier: 'yamato', tracking_number: number },
      { tracking_version: 2, leader_fulfillment_id: leader.fulfillmentId, carrier: 'sagawa', tracking_number: 'NEW-456' },
    ]);
    expect(await registrations(ids)).toEqual([]);
    for (const row of participants) {
      expect(await owner(row.fulfillmentId, 1)).toBe(leader.fulfillmentId);
      expect(await owner(row.fulfillmentId, 2)).toBe(leader.fulfillmentId);
    }
    const delivered = await db().query('select public.admin_mark_shipment_slip_delivered($1,3,$2::date,true,$3,$4) as r', [slip.id, today, actor, randomUUID()]);
    expect(delivered.rows[0].r).toMatchObject({ id: slip.id, version: 4, replayed: false });
    expect((await statusesOf(ids)).every((row) => row.delivery_status === 'delivered' && row.delivered)).toBe(true);
    expect(await registrations(ids)).toEqual([]);
  });

  test('FREQ-534-AC-04: 追跡オフのまま訂正した票(未配達)は、オンにすると現在の版2の代表だけが取り込まれる', async () => {
    await setDeliveryTracking(db(), false, admin);
    const { slip, leader, participants, ids } = await shipSlip(3);
    await updateTracking(slip.id);
    const switched = await setDeliveryTracking(db(), true, admin);
    expect(switched.backfilled_count).toBeGreaterThanOrEqual(1);
    expect(await registrations(ids)).toEqual([expect.objectContaining({
      fulfillment_id: leader.fulfillmentId, tracking_version: 2, state: 'pending', carrier: 'sagawa', tracking_number: 'NEW-456' })]);
    expect(await registrations(participants.map((row) => row.fulfillmentId))).toEqual([]);
  });

  test('FREQ-540-AC-11: reads の末尾 assert（追跡の親の節）は再実行でき、助けの ACL・volatility・置換した3つの読取の変更行の欠落を検出する', async () => {
    const section = between(READS, 'DO $g3b_tracking_parent$', '$g3b_tracking_parent$;') + '$g3b_tracking_parent$;';
    await db().query(section);
    const probes: Array<[string, string]> = [
      ['grant execute on function private.tracking_registration_owner(uuid,integer) to service_role', 'tracking_parent_functions'],
      ['alter function private.tracking_registration_owner(uuid,integer) volatile', 'tracking_parent_functions'],
      ['alter function private.delivery_tracking_backfill_targets() volatile', 'tracking_parent_functions'],
      ['grant execute on function public.get_order_delivery_detail(uuid) to authenticated', 'tracking_parent_functions'],
      ["alter function public.get_order_status_public_material(uuid) set search_path = 'public'", 'tracking_parent_functions'],
      [`create or replace function public.get_order_delivery_detail(_order_id uuid) returns jsonb language plpgsql stable security definer
        set search_path = '' as $$ begin return '{}'::jsonb; end $$`, 'tracking_parent_callers'],
      [`create or replace function private.delivery_tracking_backfill_targets()
        returns table (fulfillment_id uuid, tracking_version integer, expires_at timestamptz) language sql stable set search_path = ''
        as $$ select f.id, f.tracking_version, now() from public.order_fulfillments f where false $$`, 'tracking_parent_callers'],
    ];
    for (const [statement, detail] of probes) {
      await db().query('savepoint tracking_parent_probe');
      await db().query(statement);
      expect(await flow.rejected(() => db().query(section))).toMatchObject({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });
      await db().query('rollback to savepoint tracking_parent_probe');
    }
    await db().query(section);
  });

  test('FREQ-540-AC-11: actions の末尾 assert は読み直しの結果の置換（属性・ACL・押さえの数と位置・対象の展開）を確かめ、改変を検出する', async () => {
    const body = between(ACTIONS, '-- G3D_FINAL_ASSERT_BEGIN', '-- G3D_FINAL_ASSERT_END');
    await db().query(body);
    const replacement = `create or replace function private.record_delivery_read_result(_fulfillment_id uuid, _tracking_version integer, _lease_token uuid, _result jsonb)
      returns table (applied boolean, changed boolean, stopped boolean) language plpgsql security definer set search_path = ''
      as $$ begin return query select false, false, false; end $$`;
    const probes: Array<[string, string]> = [
      ['grant execute on function public.record_delivery_read_result(uuid,integer,uuid,jsonb) to authenticated', 'shipment_slip_read_result_function'],
      ['revoke execute on function private.record_delivery_read_result(uuid,integer,uuid,jsonb) from service_role', 'shipment_slip_read_result_function'],
      ["alter function private.record_delivery_read_result(uuid,integer,uuid,jsonb) set search_path = 'public'", 'shipment_slip_read_result_function'],
      [replacement, 'shipment_slip_read_result_body'],
    ];
    for (const [statement, detail] of probes) {
      await db().query('savepoint read_result_probe');
      await db().query(statement);
      expect(await flow.rejected(() => db().query(body))).toMatchObject({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });
      await db().query('rollback to savepoint read_result_probe');
    }
    await db().query(body);
  });
});

describeLocalDb('G-3 tracking parent: locks and concurrency (committed material)', (db) => {
  const flow = createPurchaseFlow(db);

  /** 追跡オン・n 注文の確定票・代表の登録済みの行と借りの印。commit する（別接続から見えるように） */
  async function committedSlip(count: number) {
    return withGroupG1FixtureTransaction(db(), async () => {
      await enableDeliveryTracking(db());
      const actor = await flow.createActor(['supporter']);
      const today = await flow.today();
      const orders: Awaited<ReturnType<typeof seedGroupG3ReadyOrder>>[] = [];
      for (let index = 0; index < count; index += 1) orders.push(await seedGroupG3ReadyOrder(db()));
      const slip = (await db().query('select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r',
        [JSON.stringify(orders.map((f) => ({ orderItemId: f.orderItemId, quantity: 2 }))), actor, randomUUID()])).rows[0].r as { id: string };
      const confirmed = (await db().query('select public.admin_confirm_shipment_slip($1,1,$2,$3,$4::date,true,$5,$6) as r',
        [slip.id, 'yamato', `LK-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`, today, actor, randomUUID()])).rows[0].r as Confirmed;
      const sorted = [...confirmed.fulfillments].sort((x, y) => (x.orderId < y.orderId ? -1 : x.orderId > y.orderId ? 1 : 0));
      const leader = sorted[0];
      await patchDeliveryRegistration(db(), leader.fulfillmentId, 'state=\'registered\',ever_registered=true,registered_at=now()', 1);
      const lease = await leaseDeliveryRegistration(db(), leader.fulfillmentId, 1);
      return { actor, slipId: slip.id, orders, leader, lease, ids: sorted.map((row) => row.fulfillmentId), orderIds: sorted.map((row) => row.orderId) };
    });
  }
  const readSql = 'select applied, changed, stopped from public.record_delivery_read_result($1::uuid,$2::integer,$3::uuid,$4::jsonb)';
  const readParams = async (m: { leader: Fulfillment; lease: { lease_token: string } }) => {
    const when = new Date((await db().query('select now() as at')).rows[0].at).toISOString();
    return [m.leader.fulfillmentId, 1, m.lease.lease_token, JSON.stringify({ outcome: 'ok', status: 'in_transit', provider_status: 'InTransit',
      provider_sub_status: null, happened_at: when, delivered_at: null, read_at: when, error_code: null })];
  };
  const pid = async (client: PgClient): Promise<number> => (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  /** 他の接続が行の鍵を持っているか（NOWAIT が 55P03 で断られる = true）。取れた場合は savepoint で戻す */
  const lockedByOthers = async (probe: PgClient, statement: string, params: unknown[]): Promise<boolean> => {
    await probe.query('savepoint lock_probe');
    try {
      const result = await probe.query(statement, params);
      expect(result.rowCount).toBeGreaterThan(0);
      return false;
    } catch (error) {
      if ((error as { code?: string }).code === '55P03') return true;
      throw error;
    } finally {
      await probe.query('rollback to savepoint lock_probe');
      await probe.query('release savepoint lock_probe');
    }
  };
  async function withConnections<T>(run: (c: { holder: PgClient; worker: PgClient; probe: PgClient; pids: { holder: number; worker: number } }) => Promise<T>): Promise<T> {
    const holder = await connectLocalDb(); const worker = await connectLocalDb(); const probe = await connectLocalDb();
    try {
      for (const client of [holder, worker, probe]) await client.query("set statement_timeout='30s'");
      return await run({ holder, worker, probe, pids: { holder: await pid(holder), worker: await pid(worker) } });
    } finally {
      for (const client of [holder, worker, probe]) await client.query('rollback').catch(() => undefined);
      try { await restoreCommittedDeliveryState(db()); } finally { await Promise.all([holder.end(), worker.end(), probe.end()]); }
    }
  }
  const forOrders = (table: string, column: string) => `select ${column} from public.${table} where order_id = any($1::uuid[]) for update nowait`;

  test('FREQ-541-AC-03: 票の代表の読み直しの結果は、共通の押さえを待っている間は注文・商品・割当・発送・登録のどの行も固定せず、押さえを得てから票の全注文の行を固定して全員に適用する', async () => {
    const m = await committedSlip(2);
    await withConnections(async ({ holder, worker, probe, pids }) => {
      await holder.query('begin');
      await holder.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      const pending = worker.query(readSql, await readParams(m));
      void pending.catch(() => undefined);
      await waitForDeliveryLock(probe, pids.worker, pids.holder);
      await probe.query('begin');
      expect(await lockedByOthers(probe, 'select id from public.shop_settings where id=1 for update nowait', [])).toBe(false);
      expect(await lockedByOthers(probe, 'select id from public.orders where id = any($1::uuid[]) for update nowait', [m.orderIds])).toBe(false);
      expect(await lockedByOthers(probe, forOrders('order_items', 'id'), [m.orderIds])).toBe(false);
      expect(await lockedByOthers(probe, `select a.id from public.order_item_allocations a join public.order_items oi on oi.id = a.order_item_id
        where oi.order_id = any($1::uuid[]) for update of a nowait`, [m.orderIds])).toBe(false);
      expect(await lockedByOthers(probe, forOrders('order_fulfillments', 'id'), [m.orderIds])).toBe(false);
      expect(await lockedByOthers(probe, 'select fulfillment_id from private.fulfillment_tracking_registrations where fulfillment_id=$1 for update nowait', [m.leader.fulfillmentId])).toBe(false);
      await probe.query('rollback');
      await holder.query('rollback');
      expect((await pending).rows).toEqual([{ applied: true, changed: true, stopped: false }]);
      expect((await db().query('select delivery_status from public.order_fulfillments where id=any($1::uuid[]) order by id', [m.ids])).rows.map((row) => row.delivery_status))
        .toEqual(['in_transit', 'in_transit']);
    });
  });

  test('FREQ-541-AC-03: 票の代表の読み直しの結果は、表ごとに票の全注文をまとめて固定してから次の表へ進む（注文の表を2注文とも取ってから商品の表の最後の行で待ち、商品の表を全部取ってから割当の表の最後の行で待つ）', async () => {
    const m = await committedSlip(2);
    const items = (await db().query('select id from public.order_items where order_id = any($1::uuid[]) order by id', [m.orderIds])).rows.map((row) => row.id as string);
    expect(items).toHaveLength(2);
    const allocations = (await db().query(`select a.id from public.order_item_allocations a where a.order_item_id = any($1::uuid[]) order by a.id`, [items])).rows.map((row) => row.id as string);
    expect(allocations.length).toBeGreaterThanOrEqual(2);
    const state = {
      orders: ['select id from public.orders where id = $1 for update nowait'],
      items: ['select id from public.order_items where id = $1 for update nowait'],
      allocations: ['select id from public.order_item_allocations where id = $1 for update nowait'],
      fulfillment: ['select id from public.order_fulfillments where id = $1 for update nowait'],
      registration: ['select fulfillment_id from private.fulfillment_tracking_registrations where fulfillment_id = $1 for update nowait'],
    };
    // (1) 商品の表の最後の行で待たせる: 注文の行は2つとも固定済み、商品の先の行も固定済み、割当・発送・登録はまだ
    await withConnections(async ({ holder, worker, probe, pids }) => {
      await holder.query('begin');
      await holder.query(state.items[0].replace(' for update nowait', ' for update'), [items[1]]);
      const pending = worker.query(readSql, await readParams(m));
      void pending.catch(() => undefined);
      await waitForDeliveryLock(probe, pids.worker, pids.holder);
      await probe.query('begin');
      for (const orderId of m.orderIds) expect({ orderId, locked: await lockedByOthers(probe, state.orders[0], [orderId]) }).toEqual({ orderId, locked: true });
      expect(await lockedByOthers(probe, state.items[0], [items[0]])).toBe(true);
      for (const id of allocations) expect({ id, locked: await lockedByOthers(probe, state.allocations[0], [id]) }).toEqual({ id, locked: false });
      for (const id of m.ids) expect(await lockedByOthers(probe, state.fulfillment[0], [id])).toBe(false);
      expect(await lockedByOthers(probe, state.registration[0], [m.leader.fulfillmentId])).toBe(false);
      await probe.query('rollback');
      await holder.query('rollback');
      expect((await pending).rows).toEqual([{ applied: true, changed: true, stopped: false }]);
    });
    // (2) 割当の表の最後の行で待たせる: 注文・商品の行は全部固定済み、先の割当も固定済み、発送・登録はまだ
    const n = await committedSlip(2);
    const nItems = (await db().query('select id from public.order_items where order_id = any($1::uuid[]) order by id', [n.orderIds])).rows.map((row) => row.id as string);
    const nAllocations = (await db().query('select a.id from public.order_item_allocations a where a.order_item_id = any($1::uuid[]) order by a.id', [nItems])).rows.map((row) => row.id as string);
    await withConnections(async ({ holder, worker, probe, pids }) => {
      await holder.query('begin');
      await holder.query(state.allocations[0].replace(' for update nowait', ' for update'), [nAllocations[nAllocations.length - 1]]);
      const pending = worker.query(readSql, await readParams(n));
      void pending.catch(() => undefined);
      await waitForDeliveryLock(probe, pids.worker, pids.holder);
      await probe.query('begin');
      for (const orderId of n.orderIds) expect(await lockedByOthers(probe, state.orders[0], [orderId])).toBe(true);
      for (const id of nItems) expect({ id, locked: await lockedByOthers(probe, state.items[0], [id]) }).toEqual({ id, locked: true });
      expect(await lockedByOthers(probe, state.allocations[0], [nAllocations[0]])).toBe(true);
      for (const id of n.ids) expect(await lockedByOthers(probe, state.fulfillment[0], [id])).toBe(false);
      expect(await lockedByOthers(probe, state.registration[0], [n.leader.fulfillmentId])).toBe(false);
      await probe.query('rollback');
      await holder.query('rollback');
      expect((await pending).rows).toEqual([{ applied: true, changed: true, stopped: false }]);
    });
  });

  test('FREQ-541-AC-03: 2注文の票の読み直しの結果と、同じ票の伝票番号の訂正を別接続で同時に流しても deadlock は起きず、どちらの順でも最後は版2の確認済みで揃う', async () => {
    const m = await committedSlip(2);
    await withConnections(async ({ worker, probe }) => {
      const writer = probe;
      const results = await Promise.allSettled([
        worker.query(readSql, await readParams(m)),
        writer.query('select public.admin_update_shipment_slip_tracking($1,2,$2,$3,true,$4,$5) as r', [m.slipId, 'sagawa', 'RACE-456', m.actor, randomUUID()]),
      ]);
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [(result.reason as { code?: string; message?: string })] : []));
      expect(failures).toEqual([]);
      expect(['true', 'false']).toContain(String((results[0] as PromiseFulfilledResult<{ rows: { applied: boolean }[] }>).value.rows[0].applied));
      const finalStates = (await db().query(`select delivery_status, tracking_version from public.order_fulfillments where id=any($1::uuid[]) order by id`, [m.ids])).rows;
      expect(finalStates).toEqual([{ delivery_status: 'confirmed', tracking_version: 2 }, { delivery_status: 'confirmed', tracking_version: 2 }]);
      expect((await db().query('select tracking_version from public.shipment_slips where id=$1', [m.slipId])).rows[0].tracking_version).toBe(2);
    });
  });
});
