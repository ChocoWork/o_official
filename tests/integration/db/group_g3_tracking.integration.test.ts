/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb, connectLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { seedGroupG3ReadyOrder, seedGroupG3Slip, withRolePermissions } from './helpers/group-g3-fixtures';
import { leaseDeliveryRegistration, patchDeliveryRegistration, recordReadResult, setDeliveryTracking } from './helpers/delivery-tracking-fixtures';
import { G3C_ALLOWLIST, G3D_ALLOWLIST, replaceAllowlistSql } from './helpers/group-g-allowlist';

/**
 * G-3 Task 7（FREQ-534-AC-01・AC-02・AC-04・AC-05、FREQ-535-AC-04、FREQ-540-AC-10・AC-11）: 発送票単位の伝票番号の後入力・訂正と手動の配達済み。
 * private.admin_update_shipment_slip_tracking / admin_mark_shipment_slip_delivered とそれぞれの公開入口（service_role のみ）。
 * 処理順は「引数検証 → 押さえ → 権限 → 指紋と再送 → 存在 → 段階 → 版 → 業務規則 → 書込み → 操作の記録（最後）」。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 */
jest.setTimeout(90000);

type Confirmed = { id: string; number: string; version: number; fulfillments: { orderId: string; fulfillmentId: string; number: number; completesOrder: boolean }[] };
type Updated = { id: string; version: number; trackingVersion: number; replayed: boolean };
type Delivered = { id: string; version: number; deliveredAt: string; replayed: boolean };
const trackingSignature = 'admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)';
const deliveredSignature = 'admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)';
const MIGRATION = '20261025134538_group_g3_shipping_actions.sql';
const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', MIGRATION), 'utf8');
const PERMISSIONS = ['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'];

/** One function's text from its CREATE to its ALTER ... OWNER, so statement order can be read without a database. */
function functionText(createHead: string, alterHead: string): string {
  const from = sql.indexOf(createHead);
  const to = sql.indexOf(alterHead, from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return sql.slice(from, to);
}

function positionsIn(body: string, statements: string[]): number[] {
  return statements.map((statement) => {
    const position = body.indexOf(statement);
    expect({ statement, present: position >= 0 }).toEqual({ statement, present: true });
    return position;
  });
}

describe('G-3 tracking / delivered migration (no database)', () => {
  test('FREQ-540-AC-11: 移行は1本で時刻は slips より後・別セッションの認証の移行より後。BOM・CR・全角空白・NBSP・非 ASCII が無く、BEGIN・NOTIFY・COMMIT が1つ、節の印が1組', () => {
    const names = fs.readdirSync(path.join(process.cwd(), 'supabase/migrations'));
    expect(names.filter((name) => name.endsWith('_group_g3_shipping_actions.sql'))).toEqual([MIGRATION]);
    const stamp = (name: string): string => name.slice(0, name.indexOf('_'));
    expect(stamp(MIGRATION) > stamp(names.find((name) => name.endsWith('_group_g3_shipping_slips.sql')) as string)).toBe(true);
    for (const other of names.filter((name) => name.endsWith('_auth_return_intents.sql'))) expect(stamp(MIGRATION) > stamp(other)).toBe(true);
    expect(sql.charCodeAt(0)).not.toBe(0xfeff);
    expect(sql).not.toMatch(/[\r　 ﻿​-‍]/);
    expect(sql).not.toMatch(/[^\x00-\x7f]/);
    const lines = sql.split('\n');
    expect(lines.filter((line) => /^\s*BEGIN\s*;/i.test(line))).toEqual(['BEGIN;']);
    expect(lines.filter((line) => /^\s*COMMIT\s*;/i.test(line))).toEqual(['COMMIT;']);
    expect(sql.match(/NOTIFY pgrst/g)).toHaveLength(1);
    const markers = ['-- G3D_BODY_BEGIN', '-- G3D_BODY_END', '-- G3D_FINAL_ASSERT_BEGIN', '-- G3D_FINAL_ASSERT_END'];
    const positions = markers.map((marker) => {
      expect({ marker, count: sql.split(`\n${marker}\n`).length - 1 }).toEqual({ marker, count: 1 });
      return sql.indexOf(marker);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sql.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(positions[3]);
    expect(lines.filter((line) => line.trim() !== '').at(-1)).toBe('COMMIT;');
    const code = lines.filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bON\s+SCHEMA\s+private\b/i);
    expect(code).not.toMatch(/\bGRANT\b[^;]*\bTO\b[^;]*\b(?:PUBLIC|anon|authenticated)\b/i);
  });

  test('FREQ-534-AC-01: 伝票番号の後入力・訂正は 引数 → 押さえ → 権限 → 指紋・再送 → 存在 → 段階 → 版 → 変更なし → 書込みの順で、書込みの前に何も書かず、旧の窓口の道具を使わない', () => {
    const body = functionText('CREATE FUNCTION private.admin_update_shipment_slip_tracking(', 'ALTER FUNCTION private.admin_update_shipment_slip_tracking(');
    const positions = positionsIn(body, [
      "RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_TRACKING_INCOMPLETE'",
      'PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);',
      'private.group_g_actor_has_permissions(_actor_id,',
      "WHERE op.operation = 'shipment_slip_tracking_update' AND op.request_key = _request_key",
      "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_CANCELLED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_CONFIRMED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_TRACKING_UNCHANGED'",
      'v_before := private.capture_group_g_item_states(v_orders);',
      "PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);",
      'INSERT INTO public.order_fulfillment_tracking_changes(',
      "PERFORM pg_catalog.set_config('app.fulfillment_change', 'tracking_edit', true);",
      'UPDATE public.order_fulfillments AS f SET shipping_carrier',
      'INSERT INTO public.order_fulfillment_events(',
      'UPDATE public.orders SET shipping_carrier',
      "PERFORM private.stop_fulfillment_registrations(v_fulfillment_ids[1], 'replaced');",
      'PERFORM private.close_delivery_attention(v_fulfillment_ids[1]);',
      'PERFORM private.register_group_g_slip_tracking(_slip_id, v_new_version, _actor_id, v_operation);',
      'PERFORM private.enqueue_delivery_email(',
      "PERFORM pg_catalog.set_config('app.group_g_slip_change', 'tracking', true);",
      'UPDATE public.shipment_slips SET shipping_carrier',
      'INSERT INTO public.shipment_slip_versions(',
      'PERFORM private.record_group_g_item_state_changes(',
      'INSERT INTO private.group_g_operations(',
    ]);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The lock helper is the first thing that touches anything: the text before it has no table and no function call of public / private.
    const beforeLock = body.slice(body.indexOf('AS $$'), positions[2]);
    expect(beforeLock).not.toMatch(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?(?:public|private)\./i);
    expect(beforeLock).not.toMatch(/\b(?:public|private)\.[a-z_]+\(/i);
    // Nothing is written before the last refusal.
    expect(body.slice(0, positions[10])).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public|UPDATE\s+private|DELETE\s+FROM|set_config)\b/i);
    // The leader registration is stopped before the new one is created; the shipping_update email is enqueued after the registration.
    expect(body).not.toContain('enqueue_order_email');
    expect(body).not.toMatch(/UPDATE\s+public\.order_fulfillments[^;]*cancelled_at/);
    expect(body.match(/enqueue_delivery_email\(/g)).toHaveLength(1);
  });

  test('FREQ-534-AC-02: 手動の配達済みは 引数 → 押さえ → 権限 → 指紋・再送 → 存在 → 段階 → 版 → 配達済み → 届いた日 → 書込みの順で、書込みの前に何も書かない', () => {
    const body = functionText('CREATE FUNCTION private.admin_mark_shipment_slip_delivered(', 'ALTER FUNCTION private.admin_mark_shipment_slip_delivered(');
    const positions = positionsIn(body, [
      "RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'",
      'PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);',
      'private.group_g_actor_has_permissions(_actor_id,',
      "WHERE op.operation = 'shipment_slip_deliver' AND op.request_key = _request_key",
      "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_CANCELLED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_CONFIRMED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_ALREADY_DELIVERED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_DELIVERY_DATE_INVALID'",
      'v_before := private.capture_group_g_item_states(v_orders);',
      "PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);",
      "PERFORM pg_catalog.set_config('app.fulfillment_change', 'manual', true);",
      'UPDATE public.order_fulfillments SET delivery_status',
      'INSERT INTO public.order_fulfillment_events(',
      'UPDATE private.fulfillment_tracking_registrations AS r',
      'PERFORM private.close_delivery_attention(v_shipment.fulfillment_id);',
      "PERFORM private.enqueue_delivery_email(v_shipment.fulfillment_id, v_shipment.tracking_version, 'delivered');",
      "PERFORM pg_catalog.set_config('app.group_g_slip_change', 'deliver', true);",
      'UPDATE public.shipment_slips SET version = version + 1',
      'INSERT INTO public.shipment_slip_versions(',
      'PERFORM private.record_group_g_item_state_changes(',
      'INSERT INTO private.group_g_operations(',
    ]);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const beforeLock = body.slice(body.indexOf('AS $$'), positions[1]);
    expect(beforeLock).not.toMatch(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?(?:public|private)\./i);
    expect(beforeLock).not.toMatch(/\b(?:public|private)\.[a-z_]+\(/i);
    expect(body.slice(0, positions[10])).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public|UPDATE\s+private|DELETE\s+FROM|set_config)\b/i);
    // The delivered time and the manual event follow the E-4 rule (delivered_on 12:00 JST between the shipping time and now); orders are not touched.
    expect(body).toContain("GREATEST(v_shipment.shipped_at,\n        LEAST((_delivered_on + TIME '12:00') AT TIME ZONE 'Asia/Tokyo', pg_catalog.now()))");
    expect(body).not.toMatch(/UPDATE\s+public\.orders/);
  });

  test('FREQ-540-AC-11: 74本の閉集合は G3C の72本 + 伝票番号の後入力・配達済みの2本で、移行の関数と末尾assertに載る', () => {
    expect(G3C_ALLOWLIST).toHaveLength(72);
    expect(G3D_ALLOWLIST).toHaveLength(74);
    expect(new Set(G3D_ALLOWLIST).size).toBe(74);
    expect(G3D_ALLOWLIST.slice(0, 72)).toEqual([...G3C_ALLOWLIST]);
    expect(G3D_ALLOWLIST.slice(-2)).toEqual([`private.${trackingSignature}`, `private.${deliveredSignature}`]);
    const bodyStart = sql.indexOf('CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()');
    const assertStart = sql.indexOf('-- G3D_FINAL_ASSERT_BEGIN');
    const writersStart = sql.indexOf('v_writers text[] := ARRAY[');
    for (const section of [sql.slice(bodyStart, assertStart), sql.slice(writersStart, sql.indexOf('];', writersStart))]) {
      for (const signature of G3D_ALLOWLIST) expect({ signature, once: section.split(`'${signature}'`).length - 1 }).toEqual({ signature, once: 1 });
    }
    expect(sql.slice(assertStart)).toContain('<> 74');
    for (const name of ['admin_update_shipment_slip_tracking', 'admin_mark_shipment_slip_delivered']) {
      expect(sql).toContain(`CREATE FUNCTION private.${name}(`);
      expect(sql).toContain(`CREATE FUNCTION public.${name}(`);
    }
  });
});

describeLocalDb('G-3 shipment slip tracking / delivered', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string; let today: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']); today = await flow.today();
  });
  afterEach(async () => { await db().query('rollback'); });

  const ready = (input: Parameters<typeof seedGroupG3ReadyOrder>[1] = {}) => seedGroupG3ReadyOrder(db(), input);
  const draft = async (lines: { orderItemId: string; quantity: number }[]) => (await db().query(
    'select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r', [JSON.stringify(lines), actor, randomUUID()],
  )).rows[0].r as { id: string; number: string; version: number };
  type ConfirmOptions = { tracking?: string | null; carrier?: string | null; notify?: boolean };
  const confirm = async (id: string, o: ConfirmOptions = {}): Promise<Confirmed> => (await db().query(
    'select public.admin_confirm_shipment_slip($1,1,$2,$3,$4::date,$5,$6,$7) as r',
    [id, o.carrier === undefined ? 'yamato' : o.carrier, o.tracking === undefined ? 'ab-123' : o.tracking, today,
      o.notify === undefined ? true : o.notify, actor, randomUUID()],
  )).rows[0].r;
  /** Draft and confirm a slip over the given items (quantity per item). The slip is at version 2 afterwards. */
  const ship = async (lines: { orderItemId: string; quantity: number }[], o: ConfirmOptions = {}) => {
    const slip = await draft(lines);
    return { slip, confirmed: await confirm(slip.id, o) };
  };
  type UpdateOptions = { version?: number | null; carrier?: string | null; tracking?: string | null; notify?: boolean | null; by?: string | null; key?: string | null; schema?: 'public' | 'private' };
  const update = async (id: string | null, o: UpdateOptions = {}): Promise<Updated> => (await db().query(
    `select ${o.schema ?? 'public'}.admin_update_shipment_slip_tracking($1,$2,$3,$4,$5,$6,$7) as r`,
    [id, o.version === undefined ? 2 : o.version, o.carrier === undefined ? 'sagawa' : o.carrier, o.tracking === undefined ? 'NEW-456' : o.tracking,
      o.notify === undefined ? true : o.notify, o.by === undefined ? actor : o.by, o.key === undefined ? randomUUID() : o.key],
  )).rows[0].r;
  type DeliverOptions = { version?: number | null; on?: string | null; notify?: boolean | null; by?: string | null; key?: string | null; schema?: 'public' | 'private' };
  const deliver = async (id: string | null, o: DeliverOptions = {}): Promise<Delivered> => (await db().query(
    `select ${o.schema ?? 'public'}.admin_mark_shipment_slip_delivered($1,$2,$3::date,$4,$5,$6) as r`,
    [id, o.version === undefined ? 2 : o.version, o.on === undefined ? today : o.on, o.notify === undefined ? true : o.notify,
      o.by === undefined ? actor : o.by, o.key === undefined ? randomUUID() : o.key],
  )).rows[0].r;

  const tables = ['public.orders', 'public.item_variants', 'public.stock_movements', 'public.order_item_allocations',
    'public.order_item_allocation_events', 'public.order_item_state_events', 'public.order_fulfillments', 'public.order_fulfillment_lines',
    'public.order_fulfillment_events', 'public.order_fulfillment_tracking_changes', 'public.order_fulfillment_attention',
    'public.shipment_slips', 'public.shipment_slip_lines', 'public.shipment_slip_fulfillments', 'public.shipment_slip_versions',
    'public.shipment_date_history', 'private.group_g_operations', 'private.order_email_outbox',
    'private.shipment_tracking_registrations', 'private.fulfillment_tracking_registrations'];
  // Digests verify complete row content without exposing addresses or bodies in failed assertions.
  const snapshot = async () => Promise.all(tables.map(async (table) => (await db().query(
    `select md5(coalesce(string_agg(v, ',' order by v),'')) as digest from (select to_jsonb(t)::text as v from ${table} t) x`,
  )).rows[0].digest as string));
  const refusedUpdate = async (id: string | null, message: string, options: UpdateOptions = {}, code = '22023') => {
    const before = await snapshot();
    expect(await flow.rejected(() => update(id, options))).toEqual({ message, code });
    expect(await snapshot()).toEqual(before);
  };
  const refusedDeliver = async (id: string | null, message: string, options: DeliverOptions = {}, code = '22023') => {
    const before = await snapshot();
    expect(await flow.rejected(() => deliver(id, options))).toEqual({ message, code });
    expect(await snapshot()).toEqual(before);
  };
  const fulfillmentsOf = async (slipId: string) => (await db().query(`select f.id,f.order_id,f.shipping_carrier,f.tracking_number,f.notify_customer,
      f.delivery_status,f.delivery_status_at,f.delivered_at,f.tracking_version,f.shipped_at,f.completes_order,f.request_fingerprint
    from public.shipment_slip_fulfillments sf join public.order_fulfillments f on f.id=sf.fulfillment_id where sf.slip_id=$1 order by sf.order_id`, [slipId])).rows;
  const slipRow = async (id: string) => (await db().query('select * from public.shipment_slips where id=$1', [id])).rows[0];
  const operationOf = async (operation: string, key: string) => (await db().query(
    'select * from private.group_g_operations where request_key=$1 and operation=$2', [key, operation])).rows[0];
  const emailsOf = async (kind: string, orderIds: string[]) => (await db().query(
    `select order_id,fulfillment_id,tracking_version,tracking_change_id,status,origin from private.order_email_outbox
     where kind=$1 and order_id=any($2::uuid[]) order by order_id`, [kind, orderIds])).rows;
  const orderOf = async (orderId: string) => (await db().query(
    'select status::text as status, shipped_at is not null as stamped, shipping_carrier, tracking_number from public.orders where id=$1', [orderId])).rows[0];
  const markDeliveredDirect = async (ids: string[]) => {
    await db().query("select set_config('app.fulfillment_change', 'manual', true)");
    await db().query("update public.order_fulfillments set delivery_status='delivered', delivery_status_at=now(), delivered_at=now() where id=any($1::uuid[])", [ids]);
    await db().query("select set_config('app.fulfillment_change', '', true)");
  };
  const enableTracking = async () => { await setDeliveryTracking(db(), true, await flow.createActor(['admin'])); };

  describe('FREQ-534-AC-01 伝票番号の後入力・訂正', () => {
    test('FREQ-534-AC-01: 番号なしで確定した票へ運送会社と番号を後から入れると、全注文の発送が同じ値・tracking_version 2・変更行（from が NULL）になり、注文ごとに shipping_update が1通ずつ積まれ、票の版・tracking_version・versions（kind tracking_update）が進む', async () => {
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })), { carrier: null, tracking: null });
      const orderIds = confirmed.fulfillments.map((row) => row.orderId);
      const before = await fulfillmentsOf(slip.id);
      expect(before.map((row) => [row.shipping_carrier, row.tracking_number, row.tracking_version])).toEqual([[null, null, 1], [null, null, 1]]);
      const key = randomUUID();
      const result = await update(slip.id, { key, tracking: ' New-456 ' });
      expect(result).toEqual({ id: slip.id, version: 3, trackingVersion: 2, replayed: false });
      const op = await operationOf('shipment_slip_tracking_update', key);
      expect(op).toMatchObject({ cause_type: 'shipment_slip', cause_id: slip.id, actor_id: actor, result });
      expect(op.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      const after = await fulfillmentsOf(slip.id);
      for (const row of after) {
        expect(row).toMatchObject({ shipping_carrier: 'sagawa', tracking_number: 'New-456', notify_customer: true, tracking_version: 2,
          delivery_status: 'confirmed', delivered_at: null });
        expect(row.request_fingerprint).toBe(before.find((x) => x.id === row.id)!.request_fingerprint);
      }
      const changes = (await db().query(`select c.*,
          c.request_key=md5('slip_tracking:' || $2::text || ':' || f.id::text)::uuid as derived,
          c.request_fingerprint=md5(jsonb_build_object('order_id',f.order_id,'fulfillment_id',f.id,'shipping_carrier',c.to_carrier,
            'tracking_number',c.to_tracking_number,'notify_customer',c.notify_customer)::text) as fingerprint_ok
        from public.order_fulfillment_tracking_changes c join public.order_fulfillments f on f.id=c.fulfillment_id
        where c.fulfillment_id=any($1::uuid[]) order by f.order_id`, [after.map((row) => row.id), key])).rows;
      expect(changes).toHaveLength(2);
      for (const change of changes) {
        expect(change).toMatchObject({ from_carrier: null, from_tracking_number: null, to_carrier: 'sagawa', to_tracking_number: 'New-456',
          tracking_version: 2, notify_customer: true, changed_by: actor, derived: true, fingerprint_ok: true });
      }
      for (const row of after) {
        expect((await db().query("select tracking_version,status,source from public.order_fulfillment_events where fulfillment_id=$1 and source='tracking_edit'", [row.id])).rows)
          .toEqual([{ tracking_version: 2, status: 'confirmed', source: 'tracking_edit' }]);
      }
      const emails = await emailsOf('shipping_update', orderIds);
      expect(emails).toHaveLength(2);
      expect(emails.map((email) => email.tracking_change_id).sort()).toEqual(changes.map((change) => change.id).sort());
      for (const email of emails) {
        expect(email).toMatchObject({ tracking_version: 2, status: 'pending', origin: 'auto' });
        expect(after.some((row) => row.id === email.fulfillment_id && row.order_id === email.order_id)).toBe(true);
      }
      expect(await slipRow(slip.id)).toMatchObject({ stage: 'confirmed', version: 3, tracking_version: 2, shipping_carrier: 'sagawa', tracking_number: 'New-456' });
      expect((await db().query('select version,kind,shipping_carrier,tracking_number,tracking_version,shipment_date::text as shipment_date,actor_id,operation_id from public.shipment_slip_versions where slip_id=$1 order by version', [slip.id])).rows)
        .toEqual([
          { version: 2, kind: 'confirm', shipping_carrier: null, tracking_number: null, tracking_version: 1, shipment_date: today, actor_id: actor, operation_id: expect.any(String) },
          { version: 3, kind: 'tracking_update', shipping_carrier: 'sagawa', tracking_number: 'New-456', tracking_version: 2, shipment_date: today, actor_id: actor, operation_id: op.id },
        ]);
      // the parent row of version 2 is created with the upper-cased number and the leader (first order by id) shipment
      expect((await db().query('select tracking_version,leader_fulfillment_id,carrier,tracking_number,operation_id from private.shipment_tracking_registrations where slip_id=$1', [slip.id])).rows)
        .toEqual([{ tracking_version: 2, leader_fulfillment_id: after[0].id, carrier: 'sagawa', tracking_number: 'NEW-456', operation_id: op.id }]);
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-01: 通知オフなら shipping_update は1通も積まれないが、変更行（notify_customer=false）と発送の値は変わる', async () => {
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })), { carrier: null, tracking: null });
      await update(slip.id, { notify: false });
      expect(await emailsOf('shipping_update', confirmed.fulfillments.map((row) => row.orderId))).toEqual([]);
      for (const row of await fulfillmentsOf(slip.id)) expect(row).toMatchObject({ notify_customer: false, tracking_version: 2, tracking_number: 'NEW-456' });
      expect((await db().query('select count(*)::int n from public.order_fulfillment_tracking_changes where notify_customer=false and fulfillment_id=any($1::uuid[])',
        [confirmed.fulfillments.map((row) => row.fulfillmentId)])).rows[0].n).toBe(2);
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-01: 番号ありの訂正で全注文に反映され、配達済みの発送は confirmed・delivered_at NULL に戻り、品物状態が delivered→shipped になり、全部送った注文の orders.shipping_carrier/tracking_number も同じ値になる（一部の注文は変わらない）', async () => {
      const full = await ready(); const partial = await ready();
      const { slip, confirmed } = await ship([{ orderItemId: full.orderItemId, quantity: 4 }, { orderItemId: partial.orderItemId, quantity: 2 }]);
      const ids = confirmed.fulfillments.map((row) => row.fulfillmentId);
      await markDeliveredDirect(ids);
      expect((await fulfillmentsOf(slip.id)).every((row) => row.delivered_at !== null)).toBe(true);
      const key = randomUUID();
      expect(await update(slip.id, { key, carrier: 'japanpost', tracking: 'JP-9' })).toEqual({ id: slip.id, version: 3, trackingVersion: 2, replayed: false });

      for (const row of await fulfillmentsOf(slip.id)) {
        expect(row).toMatchObject({ shipping_carrier: 'japanpost', tracking_number: 'JP-9', tracking_version: 2, delivery_status: 'confirmed', delivered_at: null });
        expect(row.delivery_status_at).toBeInstanceOf(Date);
      }
      const changes = (await db().query(`select from_carrier,from_tracking_number,to_carrier,to_tracking_number,tracking_version from public.order_fulfillment_tracking_changes
        where fulfillment_id=any($1::uuid[])`, [ids])).rows;
      expect(changes).toEqual([{ from_carrier: 'yamato', from_tracking_number: 'ab-123', to_carrier: 'japanpost', to_tracking_number: 'JP-9', tracking_version: 2 },
        { from_carrier: 'yamato', from_tracking_number: 'ab-123', to_carrier: 'japanpost', to_tracking_number: 'JP-9', tracking_version: 2 }]);
      expect(await orderOf(full.orderId)).toEqual({ status: 'shipped', stamped: true, shipping_carrier: 'japanpost', tracking_number: 'JP-9' });
      expect((await orderOf(partial.orderId)).status).toBe('paid');
      expect(await orderOf(partial.orderId)).toMatchObject({ shipping_carrier: null, tracking_number: null });
      const op = await operationOf('shipment_slip_tracking_update', key);
      expect((await db().query(`select order_item_id,from_status,to_status,unit_to-unit_from as n,reason from public.order_item_state_events
        where operation_id=$1 order by n`, [op.id])).rows).toEqual([
        { order_item_id: partial.orderItemId, from_status: 'delivered', to_status: 'shipped', n: 2, reason: 'shipment_slip_tracking_update' },
        { order_item_id: full.orderItemId, from_status: 'delivered', to_status: 'shipped', n: 4, reason: 'shipment_slip_tracking_update' },
      ]);
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-01: 追跡オンなら旧版の代表の登録が replaced で止まり、開いていた要対応は auto で閉じ、新しい版の代表の登録だけが pending で作られる（参加の発送には作らない）', async () => {
      await enableTracking();
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      const [leader, participant] = confirmed.fulfillments;
      await patchDeliveryRegistration(db(), leader.fulfillmentId, 'state=\'registered\',ever_registered=true,registered_at=now()', 1);
      await db().query("insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1,'delivery_failure')", [leader.fulfillmentId]);
      await update(slip.id);

      const registrations = (await db().query(`select fulfillment_id,tracking_version,carrier,tracking_number,state,stop_reason,provider_stop_pending,
          expires_at=now()+interval '30 days' as expires_in_30_days
        from private.fulfillment_tracking_registrations where fulfillment_id=any($1::uuid[]) order by tracking_version`,
      [confirmed.fulfillments.map((row) => row.fulfillmentId)])).rows;
      expect(registrations).toEqual([
        // 版1の期限は発送した時刻 + 30日で、この試験では発送も訂正も同じ取引の now() なので、版2と同じ値になる
        { fulfillment_id: leader.fulfillmentId, tracking_version: 1, carrier: 'yamato', tracking_number: 'AB-123', state: 'stopped', stop_reason: 'replaced',
          provider_stop_pending: true, expires_in_30_days: true },
        { fulfillment_id: leader.fulfillmentId, tracking_version: 2, carrier: 'sagawa', tracking_number: 'NEW-456', state: 'pending', stop_reason: null,
          provider_stop_pending: false, expires_in_30_days: true },
      ]);
      expect(registrations.some((row) => row.fulfillment_id === participant.fulfillmentId)).toBe(false);
      expect((await db().query('select resolved_at is not null as resolved,resolution from public.order_fulfillment_attention where fulfillment_id=$1', [leader.fulfillmentId])).rows)
        .toEqual([{ resolved: true, resolution: 'auto' }]);
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-04: 追跡オフでも訂正が動き、外への登録行は作られない（票×版の親の行だけがある）', async () => {
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      expect((await db().query('select delivery_tracking_enabled from public.shop_settings where id=1')).rows[0].delivery_tracking_enabled).toBe(false);
      expect(await update(slip.id)).toMatchObject({ version: 3, trackingVersion: 2 });
      const ids = confirmed.fulfillments.map((row) => row.fulfillmentId);
      expect((await db().query('select count(*)::int n from private.fulfillment_tracking_registrations where fulfillment_id=any($1::uuid[])', [ids])).rows[0].n).toBe(0);
      expect((await db().query('select tracking_version from private.shipment_tracking_registrations where slip_id=$1 order by tracking_version', [slip.id])).rows)
        .toEqual([{ tracking_version: 1 }, { tracking_version: 2 }]);
      expect(await emailsOf('shipping_update', confirmed.fulfillments.map((row) => row.orderId))).toHaveLength(2);
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-01: 同じ値（番号は大文字小文字違いも）は GROUP_G_SLIP_TRACKING_UNCHANGED。番号なしから番号ありは変更、運送会社だけの変更・番号だけの変更は通る', async () => {
      const f = await ready();
      const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await refusedUpdate(slip.id, 'GROUP_G_SLIP_TRACKING_UNCHANGED', { carrier: 'yamato', tracking: 'ab-123' });
      await refusedUpdate(slip.id, 'GROUP_G_SLIP_TRACKING_UNCHANGED', { carrier: 'yamato', tracking: 'AB-123' });
      await refusedUpdate(slip.id, 'GROUP_G_SLIP_TRACKING_UNCHANGED', { carrier: 'yamato', tracking: 'AB-123', notify: false });
      expect(await update(slip.id, { carrier: 'sagawa', tracking: 'ab-123' })).toMatchObject({ version: 3, trackingVersion: 2 });
      expect(await update(slip.id, { version: 3, carrier: 'sagawa', tracking: 'zz-1' })).toMatchObject({ version: 4, trackingVersion: 3 });
      const none = await ship([{ orderItemId: (await ready()).orderItemId, quantity: 2 }], { carrier: null, tracking: null });
      expect(await update(none.slip.id, { carrier: 'yamato', tracking: 'ab-123' })).toMatchObject({ version: 3, trackingVersion: 2 });
      await db().query('set constraints all immediate');
    });

    test.each([
      ['書式違反の番号', { tracking: 'bad number!' }], ['長すぎる番号', { tracking: 'A'.repeat(65) }], ['知らない運送会社', { carrier: 'dhl' }],
      ['通知NULL', { notify: null }], ['版NULL', { version: null }], ['版0', { version: 0 }], ['actorNULL', { by: null }], ['keyNULL', { key: null }],
    ] as const)('FREQ-534-AC-01: %s は GROUP_G_ARGUMENT_INVALID で、何も変わらない', async (_label, options) => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await refusedUpdate(slip.id, 'GROUP_G_ARGUMENT_INVALID', options);
      await refusedUpdate(null, 'GROUP_G_ARGUMENT_INVALID');
    });

    test.each([
      ['運送会社が空', { carrier: null }], ['番号がNULL', { tracking: null }], ['番号が空文字', { tracking: '' }], ['番号が空白だけ', { tracking: '   ' }],
      ['両方空（空で消す訂正）', { carrier: null, tracking: null }],
    ] as const)('FREQ-534-AC-01: %s は GROUP_G_SLIP_TRACKING_INCOMPLETE（空には戻せない）で、何も変わらない', async (_label, options) => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await refusedUpdate(slip.id, 'GROUP_G_SLIP_TRACKING_INCOMPLETE', options);
    });

    test('FREQ-534-AC-01: 下書き・破棄済みは GROUP_G_SLIP_NOT_CONFIRMED、取消済みは GROUP_G_SLIP_CANCELLED、票が無ければ P0002、版違いは VERSION_CONFLICT。どれも何も変えない', async () => {
      const f = await ready();
      const drafted = await draft([{ orderItemId: f.orderItemId, quantity: 2 }]);
      const discarded = await seedGroupG3Slip(db(), { actorId: actor, stage: 'discarded' });
      const cancelled = await ship([{ orderItemId: (await ready()).orderItemId, quantity: 2 }]);
      await db().query('select public.admin_cancel_shipment_slip($1,2,$2,$3)', [cancelled.slip.id, actor, randomUUID()]);
      const live = await ship([{ orderItemId: (await ready()).orderItemId, quantity: 2 }]);
      await refusedUpdate(drafted.id, 'GROUP_G_SLIP_NOT_CONFIRMED', { version: 1 }, '55000');
      await refusedUpdate(discarded, 'GROUP_G_SLIP_NOT_CONFIRMED', { version: 1 }, '55000');
      await refusedUpdate(cancelled.slip.id, 'GROUP_G_SLIP_CANCELLED', { version: 3 }, '55000');
      await refusedUpdate(randomUUID(), 'GROUP_G_SLIP_NOT_FOUND', {}, 'P0002');
      await refusedUpdate(live.slip.id, 'GROUP_G_SLIP_VERSION_CONFLICT', { version: 1 }, '55000');
      await refusedUpdate(live.slip.id, 'GROUP_G_SLIP_VERSION_CONFLICT', { version: 3 }, '55000');
      expect((await update(live.slip.id)).version).toBe(3);
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-01: 同じ request_key の再送は replayed:true で変更行・出来事・メールが増えず、同キーで異なる内容・別の実行者・別の票は GROUP_G_REQUEST_KEY_CONFLICT', async () => {
      const a = await ready(); const b = await ready();
      const { slip } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      const key = randomUUID();
      const first = await update(slip.id, { key });
      const before = await snapshot();
      expect(await update(slip.id, { key, version: 999 })).toEqual({ ...first, replayed: true });
      expect(await snapshot()).toEqual(before);
      await refusedUpdate(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { key, tracking: 'OTHER-1', version: 3 }, '23505');
      await refusedUpdate(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { key, notify: false, version: 3 }, '23505');
      await refusedUpdate(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { key, by: await flow.createActor(['supporter']), version: 3 }, '23505');
      await refusedUpdate(randomUUID(), 'GROUP_G_REQUEST_KEY_CONFLICT', { key }, '23505');
      // 別の要求番号で同じ値を送ると、変わっていないので UNCHANGED
      await refusedUpdate(slip.id, 'GROUP_G_SLIP_TRACKING_UNCHANGED', { version: 3 });
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-01: 旧版の追跡通知は現行へ適用されない（訂正前の版の lease で record_delivery_read_result を呼ぶと applied=false で発送の状況が変わらない）。新しい版の lease は適用できる', async () => {
      await enableTracking();
      const f = await ready();
      const { slip, confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 4 }]);
      const fulfillmentId = confirmed.fulfillments[0].fulfillmentId;
      await patchDeliveryRegistration(db(), fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 1);
      const oldLease = await leaseDeliveryRegistration(db(), fulfillmentId, 1);
      await update(slip.id);
      // 訂正で発送の状況の時刻（delivery_status_at）は今の取引時刻になったので、読み取りの時刻はそれより後にする
      const at = new Date((await db().query("select now() + interval '1 minute' as at")).rows[0].at).toISOString();
      const read = { outcome: 'ok', status: 'in_transit', provider_status: 'InTransit', provider_sub_status: null, happened_at: at, delivered_at: null, read_at: at, error_code: null };
      const stateOf = async () => (await db().query('select delivery_status,tracking_version,delivered_at from public.order_fulfillments where id=$1', [fulfillmentId])).rows[0];
      const eventsOf = async () => (await db().query('select count(*)::int n from public.order_fulfillment_events where fulfillment_id=$1', [fulfillmentId])).rows[0].n as number;
      const stateBefore = await stateOf(); const eventsBefore = await eventsOf();
      expect(await recordReadResult(db(), oldLease, read)).toEqual({ applied: false, changed: false, stopped: false });
      // 旧版の登録を追跡中・有効な借りの印に戻しても、発送の版が違うので書かない
      await patchDeliveryRegistration(db(), fulfillmentId, "state='registered',stop_reason=null,stopped_at=null", 1);
      expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), fulfillmentId, 1), read)).toEqual({ applied: false, changed: false, stopped: false });
      expect(await stateOf()).toEqual(stateBefore);
      expect(await eventsOf()).toBe(eventsBefore);
      expect(stateBefore).toMatchObject({ delivery_status: 'confirmed', tracking_version: 2 });
      // 新しい版（2）の登録を追跡中にして借りれば、適用できる
      await patchDeliveryRegistration(db(), fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 2);
      expect((await recordReadResult(db(), await leaseDeliveryRegistration(db(), fulfillmentId, 2), read)).applied).toBe(true);
      expect((await stateOf()).delivery_status).toBe('in_transit');
    });

    test('FREQ-534-AC-01: 途中の失敗（2番目の発送の更新の故障）は変更行・発送・出来事・登録・メール・票を含め全部を原状へ戻す', async () => {
      await enableTracking();
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      const ids = confirmed.fulfillments.map((row) => row.fulfillmentId);
      const last = confirmed.fulfillments[1];
      await db().query(`create function public.g3_tracking_fault() returns trigger language plpgsql as $f$ begin
        if new.id='${last.fulfillmentId}'::uuid and new.tracking_version=2 then
          if (select count(*) from public.order_fulfillment_tracking_changes where fulfillment_id in ('${ids[0]}'::uuid,'${ids[1]}'::uuid)) <> 2
            or (select tracking_version from public.order_fulfillments where id='${confirmed.fulfillments[0].fulfillmentId}'::uuid) <> 2
            or (select count(*) from public.order_fulfillment_events where fulfillment_id='${confirmed.fulfillments[0].fulfillmentId}'::uuid and source='tracking_edit') <> 1 then
            raise exception 'G3_FAULT_PROGRESS_MISSING' using errcode='P0001';
          end if;
          raise exception 'G3_INJECTED' using errcode='P0001';
        end if; return new; end $f$`);
      await db().query('create trigger g3_tracking_fault before update on public.order_fulfillments for each row execute function public.g3_tracking_fault()');
      await refusedUpdate(slip.id, 'G3_INJECTED', {}, 'P0001');
    });

    test.each(PERMISSIONS)('FREQ-540-AC-10: 伝票番号の後入力・訂正は4権限を全て必要とする（%s が無い役割は GROUP_G_FORBIDDEN）', async (code) => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await withRolePermissions(db(), 'supporter', [], [code], () => refusedUpdate(slip.id, 'GROUP_G_FORBIDDEN', {}, '42501'));
      expect((await update(slip.id)).version).toBe(3);
      await db().query('set constraints all immediate');
    });
  });

  describe('FREQ-534-AC-02 手動の配達済み', () => {
    test('FREQ-534-AC-02: 手動の配達済みで有効な全発送が delivered・delivered_at＝GREATEST(shipped_at, LEAST(届いた日JSTの正午, now()))・出来事 manual(派生の request_key)、代表の登録が stopped/delivered、要対応が auto で閉じ、通知は注文ごとに1通、品物状態 shipped→delivered', async () => {
      await enableTracking();
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 4 })));
      const [leader, participant] = confirmed.fulfillments;
      await db().query("insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1,'delivery_failure')", [leader.fulfillmentId]);
      await patchDeliveryRegistration(db(), leader.fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 1);
      const key = randomUUID();
      const result = await deliver(slip.id, { key });
      expect(result).toEqual({ id: slip.id, version: 3, deliveredAt: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/), replayed: false });
      const op = await operationOf('shipment_slip_deliver', key);
      expect(op).toMatchObject({ cause_type: 'shipment_slip', cause_id: slip.id, actor_id: actor, result });

      const rows = (await db().query(`select f.id,f.delivery_status,f.delivery_status_at=f.delivered_at as same_time,f.tracking_version,
          f.delivered_at=greatest(f.shipped_at, least((($2::date + time '12:00') at time zone 'Asia/Tokyo'), now())) as expected_time,
          to_char(f.delivered_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as text
        from public.shipment_slip_fulfillments sf join public.order_fulfillments f on f.id=sf.fulfillment_id where sf.slip_id=$1 order by sf.order_id`, [slip.id, today])).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ delivery_status: 'delivered', same_time: true, expected_time: true, tracking_version: 1 });
      expect(result.deliveredAt).toBe(rows[0].text);
      for (const row of rows) {
        const events = (await db().query(`select tracking_version,status,source,created_by,happened_at=(select delivered_at from public.order_fulfillments where id=$1) as at_delivery,
            request_key=md5('slip_delivered:' || $2::text || ':' || $1::text)::uuid as derived, request_fingerprint is not null as fingerprint
          from public.order_fulfillment_events where fulfillment_id=$1 and source='manual'`, [row.id, key])).rows;
        expect(events).toEqual([{ tracking_version: 1, status: 'delivered', source: 'manual', created_by: actor, at_delivery: true, derived: true, fingerprint: true }]);
      }
      expect((await db().query('select state,stop_reason,lease_token from private.fulfillment_tracking_registrations where fulfillment_id=$1', [leader.fulfillmentId])).rows)
        .toEqual([{ state: 'stopped', stop_reason: 'delivered', lease_token: null }]);
      expect((await db().query('select count(*)::int n from private.fulfillment_tracking_registrations where fulfillment_id=$1', [participant.fulfillmentId])).rows[0].n).toBe(0);
      expect((await db().query('select resolved_at is not null as resolved,resolution from public.order_fulfillment_attention where fulfillment_id=$1', [leader.fulfillmentId])).rows)
        .toEqual([{ resolved: true, resolution: 'auto' }]);
      const emails = await emailsOf('delivered', [a.orderId, b.orderId]);
      expect(emails.map((email) => [email.fulfillment_id, email.tracking_version, email.status, email.origin]).sort()).toEqual(
        confirmed.fulfillments.map((row) => [row.fulfillmentId, 1, 'pending', 'auto']).sort());
      expect((await db().query(`select from_status,to_status,unit_to-unit_from as n,reason from public.order_item_state_events where operation_id=$1 order by order_item_id`, [op.id])).rows
        .map((row) => ({ ...row }))).toEqual([{ from_status: 'shipped', to_status: 'delivered', n: 4, reason: 'shipment_slip_deliver' },
        { from_status: 'shipped', to_status: 'delivered', n: 4, reason: 'shipment_slip_deliver' }]);
      expect(await slipRow(slip.id)).toMatchObject({ stage: 'confirmed', version: 3, tracking_version: 1, shipping_carrier: 'yamato', tracking_number: 'ab-123' });
      expect((await db().query('select version,kind,tracking_version,operation_id from public.shipment_slip_versions where slip_id=$1 order by version', [slip.id])).rows)
        .toEqual([{ version: 2, kind: 'confirm', tracking_version: 1, operation_id: expect.any(String) }, { version: 3, kind: 'delivered', tracking_version: 1, operation_id: op.id }]);
      // the order is not touched by the manual delivery (status stays shipped)
      expect((await orderOf(a.orderId)).status).toBe('shipped');
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-02: 通知は 発送の通知 と 入力 の両方がオンの時だけ（どちらかがオフなら0通）', async () => {
      const cases: Array<[boolean, boolean, number]> = [[true, true, 1], [true, false, 0], [false, true, 0], [false, false, 0]];
      for (const [shipNotify, inputNotify, expected] of cases) {
        const f = await ready();
        const { slip, confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 4 }], { notify: shipNotify });
        await deliver(slip.id, { notify: inputNotify });
        expect({ shipNotify, inputNotify, mails: (await emailsOf('delivered', [confirmed.fulfillments[0].orderId])).length }).toEqual({ shipNotify, inputNotify, mails: expected });
      }
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-02: 同じ request_key の再送は replayed:true で何も増えず、同キーで異なる内容は CONFLICT', async () => {
      const a = await ready(); const b = await ready();
      const { slip } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      const key = randomUUID();
      const first = await deliver(slip.id, { key });
      const before = await snapshot();
      expect(await deliver(slip.id, { key, version: 99 })).toEqual({ ...first, replayed: true });
      expect(await snapshot()).toEqual(before);
      await refusedDeliver(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { key, on: await flow.today(-1), version: 3 }, '23505');
      await refusedDeliver(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { key, notify: false, version: 3 }, '23505');
      await refusedDeliver(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { key, by: await flow.createActor(['supporter']), version: 3 }, '23505');
      await refusedDeliver(randomUUID(), 'GROUP_G_REQUEST_KEY_CONFLICT', { key }, '23505');
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-02: すでに配達済みの票は GROUP_G_SLIP_ALREADY_DELIVERED。一部の発送だけ配達済みでも断る', async () => {
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      await deliver(slip.id);
      await refusedDeliver(slip.id, 'GROUP_G_SLIP_ALREADY_DELIVERED', { version: 3 }, '55000');
      const other = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 1 })));
      await markDeliveredDirect([other.confirmed.fulfillments[0].fulfillmentId]);
      await refusedDeliver(other.slip.id, 'GROUP_G_SLIP_ALREADY_DELIVERED', {}, '55000');
      expect(confirmed.fulfillments).toHaveLength(2);
    });

    test('FREQ-534-AC-02: 届いた日が発送日（JST）より前・今日（JST）より後は GROUP_G_SLIP_DELIVERY_DATE_INVALID。発送日と今日そのものは通る', async () => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await refusedDeliver(slip.id, 'GROUP_G_SLIP_DELIVERY_DATE_INVALID', { on: await flow.today(-1) });
      await refusedDeliver(slip.id, 'GROUP_G_SLIP_DELIVERY_DATE_INVALID', { on: await flow.today(1) });
      await refusedDeliver(slip.id, 'GROUP_G_SLIP_DELIVERY_DATE_INVALID', { on: '2000-01-01' });
      expect(await deliver(slip.id, { on: today })).toMatchObject({ version: 3 });
      await db().query('set constraints all immediate');
    });

    test.each([
      ['届いた日NULL', { on: null }], ['通知NULL', { notify: null }], ['版NULL', { version: null }], ['版0', { version: 0 }], ['actorNULL', { by: null }], ['keyNULL', { key: null }],
    ] as const)('FREQ-534-AC-02: %s は GROUP_G_ARGUMENT_INVALID で、何も変わらない', async (_label, options) => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await refusedDeliver(slip.id, 'GROUP_G_ARGUMENT_INVALID', options);
      await refusedDeliver(null, 'GROUP_G_ARGUMENT_INVALID');
    });

    test('FREQ-534-AC-02: 下書き・破棄済みは NOT_CONFIRMED、取消済みは CANCELLED、票が無ければ P0002、版違いは VERSION_CONFLICT。どれも何も変えない', async () => {
      const f = await ready();
      const drafted = await draft([{ orderItemId: f.orderItemId, quantity: 2 }]);
      const discarded = await seedGroupG3Slip(db(), { actorId: actor, stage: 'discarded' });
      const cancelled = await ship([{ orderItemId: (await ready()).orderItemId, quantity: 2 }]);
      await db().query('select public.admin_cancel_shipment_slip($1,2,$2,$3)', [cancelled.slip.id, actor, randomUUID()]);
      const live = await ship([{ orderItemId: (await ready()).orderItemId, quantity: 2 }]);
      await refusedDeliver(drafted.id, 'GROUP_G_SLIP_NOT_CONFIRMED', { version: 1 }, '55000');
      await refusedDeliver(discarded, 'GROUP_G_SLIP_NOT_CONFIRMED', { version: 1 }, '55000');
      await refusedDeliver(cancelled.slip.id, 'GROUP_G_SLIP_CANCELLED', { version: 3 }, '55000');
      await refusedDeliver(randomUUID(), 'GROUP_G_SLIP_NOT_FOUND', {}, 'P0002');
      await refusedDeliver(live.slip.id, 'GROUP_G_SLIP_VERSION_CONFLICT', { version: 1 }, '55000');
      expect((await deliver(live.slip.id)).version).toBe(3);
      await db().query('set constraints all immediate');
    });

    test('FREQ-535-AC-04: 手動の配達済みの後、返品の期限の起点が届いた日になる（E-4 と同じ fulfillment_line_returnable で、票のどの注文でも）。shipped_at は変わらない', async () => {
      await db().query("update public.shop_return_settings set window_days=7, window_start='each_item', delivery_buffer_days=3 where id=1");
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 4 })));
      const deadlines = async () => (await db().query(
        `select (select r.deadline_date::text from private.fulfillment_line_returnable($1) r limit 1) as a,
                (select r.deadline_date::text from private.fulfillment_line_returnable($2) r limit 1) as b`, [a.orderId, b.orderId])).rows[0] as { a: string; b: string };
      const shipped = await fulfillmentsOf(slip.id);
      const plusDays = async (day: string, days: number) => (await db().query('select ($1::date + $2::integer)::text as d', [day, days])).rows[0].d as string;
      // before: shipped date (JST) + buffer 3 + window 7
      expect(await deadlines()).toEqual({ a: await plusDays(today, 10), b: await plusDays(today, 10) });
      await deliver(slip.id);
      const deliveredJst = (await db().query(`select (delivered_at at time zone 'Asia/Tokyo')::date::text as d from public.order_fulfillments where id=$1`, [confirmed.fulfillments[0].fulfillmentId])).rows[0].d as string;
      // after: delivered date (JST) + window 7, for every order of the slip
      expect(await deadlines()).toEqual({ a: await plusDays(deliveredJst, 7), b: await plusDays(deliveredJst, 7) });
      expect((await fulfillmentsOf(slip.id)).map((row) => row.shipped_at)).toEqual(shipped.map((row) => row.shipped_at));
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-04: 追跡オフでも配達済みが動き、外への登録行は作られない', async () => {
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      expect(await deliver(slip.id)).toMatchObject({ version: 3 });
      expect((await db().query('select count(*)::int n from private.fulfillment_tracking_registrations where fulfillment_id=any($1::uuid[])',
        [confirmed.fulfillments.map((row) => row.fulfillmentId)])).rows[0].n).toBe(0);
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-02: 途中の失敗（2番目の発送の出来事の故障）は発送・出来事・登録・メール・票を含め全部を原状へ戻す', async () => {
      await enableTracking();
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      const [first, last] = confirmed.fulfillments;
      await db().query(`create function public.g3_delivered_fault() returns trigger language plpgsql as $f$ begin
        if new.source='manual' and new.fulfillment_id='${last.fulfillmentId}'::uuid then
          if (select delivery_status from public.order_fulfillments where id='${first.fulfillmentId}'::uuid) <> 'delivered'
            or (select count(*) from public.order_fulfillment_events where fulfillment_id='${first.fulfillmentId}'::uuid and source='manual') <> 1
            or (select delivery_status from public.order_fulfillments where id='${last.fulfillmentId}'::uuid) <> 'delivered' then
            raise exception 'G3_FAULT_PROGRESS_MISSING' using errcode='P0001';
          end if;
          raise exception 'G3_INJECTED' using errcode='P0001';
        end if; return new; end $f$`);
      await db().query('create trigger g3_delivered_fault before insert on public.order_fulfillment_events for each row execute function public.g3_delivered_fault()');
      await refusedDeliver(slip.id, 'G3_INJECTED', {}, 'P0001');
    });

    test.each(PERMISSIONS)('FREQ-540-AC-10: 手動の配達済みは4権限を全て必要とする（%s が無い役割は GROUP_G_FORBIDDEN）', async (code) => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await withRolePermissions(db(), 'supporter', [], [code], () => refusedDeliver(slip.id, 'GROUP_G_FORBIDDEN', {}, '42501'));
      expect((await deliver(slip.id)).version).toBe(3);
      await db().query('set constraints all immediate');
    });
  });

  describe('FREQ-540-AC-10 / AC-11 権限と押さえと公開入口', () => {
    test('FREQ-534-AC-01〜02 / FREQ-540-AC-10: correct_date だけを持つ役割・役割の無い人・無効な役割・期限切れの役割は、伝票番号も配達済みも GROUP_G_FORBIDDEN。有効な役割なら動く', async () => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await withRolePermissions(db(), 'supporter', ['admin.shipping.correct_date'], ['admin.shipping.manage', 'admin.orders.manage'], async () => {
        await refusedUpdate(slip.id, 'GROUP_G_FORBIDDEN', {}, '42501');
        await refusedDeliver(slip.id, 'GROUP_G_FORBIDDEN', {}, '42501');
      });
      for (const by of [await flow.createActor([]), await flow.createActor(['supporter'], { inactive: ['supporter'] }), await flow.createActor(['supporter'], { expired: ['supporter'] })]) {
        await refusedUpdate(slip.id, 'GROUP_G_FORBIDDEN', { by }, '42501');
        await refusedDeliver(slip.id, 'GROUP_G_FORBIDDEN', { by }, '42501');
      }
      expect((await update(slip.id)).version).toBe(3);
      expect((await deliver(slip.id, { version: 3 })).version).toBe(4);
      await db().query('set constraints all immediate');
    });

    test.each([
      ['伝票番号', (slipId: string, key: string) => ['select public.admin_update_shipment_slip_tracking($1,2,$2,$3,true,$4,$5)', [slipId, 'sagawa', 'NEW-456', actor, key]] as const],
      ['配達済み', (slipId: string, key: string) => ['select public.admin_mark_shipment_slip_delivered($1,2,$2::date,true,$3,$4)', [slipId, today, actor, key]] as const],
    ])('FREQ-540-AC-11: %sはadvisory待ちの間に設定・票・注文・variant・割当・発送・登録の行を持たない', async (_label, build) => {
      await enableTracking();
      const f = await ready(); const { slip, confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      const [statement, params] = build(slip.id, randomUUID());
      const other = await connectLocalDb(); let pending: Promise<unknown> | undefined;
      try {
        await other.query('begin'); await other.query("set local statement_timeout='10s'");
        const pid = (await other.query('select pg_backend_pid() pid')).rows[0].pid;
        pending = other.query(statement, [...params]).then(() => ({ ok: true }), () => ({ ok: false }));
        let waiting = false;
        for (let i = 0; i < 300 && !waiting; i += 1) waiting = (await db().query("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) waiting", [pid])).rows[0].waiting;
        expect(waiting).toBe(true);
        for (const [table, column, id] of [['public.shop_settings', 'id', 1], ['public.shipment_slips', 'id', slip.id], ['public.orders', 'id', f.orderId],
          ['public.item_variants', 'id', f.variantId], ['public.order_item_allocations', 'id', f.allocationId],
          ['public.order_fulfillments', 'id', confirmed.fulfillments[0].fulfillmentId]] as const) {
          await db().query(`select ${column} from ${table} where ${column}=$1 for update nowait`, [id]);
        }
        await db().query('select fulfillment_id from private.fulfillment_tracking_registrations where fulfillment_id=$1 for update nowait', [confirmed.fulfillments[0].fulfillmentId]);
        await db().query('select pg_cancel_backend($1)', [pid]); await pending;
      } finally { if (pending) await pending; await other.query('rollback'); await other.end(); }
    });

    test.each([
      [trackingSignature, 'perform 1 from only "public"."orders" limit 1;'],
      [trackingSignature, "perform private.group_g_actor_has_permissions(_actor_id,array['admin.shipping.manage']);"],
      [deliveredSignature, 'perform 1 from only "public"."orders" limit 1;'],
      [deliveredSignature, "perform private.group_g_actor_has_permissions(_actor_id,array['admin.shipping.manage']);"],
    ])('FREQ-540-AC-11: %s の押さえ前の参照も G3D の末尾assertが止める (%#)', async (signature, injected) => {
      const definition = (await db().query('select pg_get_functiondef($1::regprocedure) def', [`private.${signature}`])).rows[0].def as string;
      const tampered = definition.replace('PERFORM private.lock_group_g_shipment_slips(', `${injected} PERFORM private.lock_group_g_shipment_slips(`);
      expect(tampered).not.toBe(definition);
      const start = sql.indexOf('DO $g3d_final_objects$'); const end = sql.indexOf('$g3d_final_objects$;', start) + '$g3d_final_objects$;'.length;
      expect(await flow.rejected(async () => { await db().query(tampered); await db().query(sql.slice(start, end)); }))
        .toEqual({ message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', code: '55000', detail: 'shipment_slip_action_lock_order' });
    });

    test('FREQ-540-AC-11: G3D の末尾assertは今のDBで通り、崩れ（入口の欠落・EXECUTE・DEFINER・search_path・overload・一覧の増減と差し替え）で項目名つきで止まる', async () => {
      const start = sql.indexOf('DO $g3d_final_objects$'); const end = sql.indexOf('$g3d_final_objects$;', start) + '$g3d_final_objects$;'.length;
      const assertSql = sql.slice(start, end);
      const track = `private.${trackingSignature}`; const trackEntry = `public.${trackingSignature}`;
      const run = async (change: string | null) => {
        await db().query('savepoint g3d_assert');
        try {
          if (change !== null) await db().query(change);
          await db().query(assertSql);
          return null;
        } catch (error) {
          const e = error as { code: string; message: string; detail: string };
          return { code: e.code, message: e.message, detail: e.detail };
        } finally {
          await db().query('rollback to savepoint g3d_assert');
          await db().query('release savepoint g3d_assert');
        }
      };
      const failed = (detail: string) => ({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });
      expect(G3D_ALLOWLIST).toHaveLength(74);
      expect(await run(null)).toBeNull();
      expect(await run(`drop function ${trackEntry}`)).toEqual(failed('shipment_slip_action_functions'));
      expect(await run(`grant execute on function ${track} to anon`)).toEqual(failed('shipment_slip_action_functions'));
      expect(await run(`grant execute on function ${trackEntry} to public`)).toEqual(failed('shipment_slip_action_functions'));
      expect(await run(`revoke execute on function ${track} from service_role`)).toEqual(failed('shipment_slip_action_functions'));
      expect(await run(`alter function ${trackEntry} security definer`)).toEqual(failed('shipment_slip_action_functions'));
      expect(await run(`alter function ${track} set search_path = public`)).toEqual(failed('shipment_slip_action_functions'));
      expect(await run(`create function private.admin_update_shipment_slip_tracking(uuid) returns integer language sql as $$ select 1 $$`))
        .toEqual(failed('shipment_slip_action_function_set'));
      expect(await run(replaceAllowlistSql(G3D_ALLOWLIST.slice(0, -1)))).toEqual(failed('shipment_slip_action_writer_allowlist_missing'));
      expect(await run(replaceAllowlistSql([...G3D_ALLOWLIST, 'private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)']))).toEqual(failed('shipment_slip_action_writer_allowlist_missing'));
      expect(await run(replaceAllowlistSql(['private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)', ...G3D_ALLOWLIST.slice(1)]))).toEqual(failed('shipment_slip_action_writer_allowlist'));
    });

    test('FREQ-540-AC-11: 公開入口は INVOKER 委譲、private 本体は DEFINER で service_role だけが EXECUTE でき、許可一覧は74本で2本が入り入口は入らない', async () => {
      const rows = (await db().query(`select n.nspname,p.proname,p.prosecdef,p.prosrc,has_function_privilege('service_role',p.oid,'EXECUTE') service,
        has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
        exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_execute,
        p.oid::text as oid
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid=any($1::regprocedure[])`,
      [[`public.${trackingSignature}`, `private.${trackingSignature}`, `public.${deliveredSignature}`, `private.${deliveredSignature}`]])).rows;
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row).toMatchObject({ anon: false, authenticated: false, public_execute: false, service: true });
      for (const [name, argsText] of [['admin_update_shipment_slip_tracking', 'private.admin_update_shipment_slip_tracking(_slip_id, _expected_version, _carrier, _tracking_number, _notify_customer, _actor_id, _request_key)'],
        ['admin_mark_shipment_slip_delivered', 'private.admin_mark_shipment_slip_delivered(_slip_id, _expected_version, _delivered_on, _notify_customer, _actor_id, _request_key)']]) {
        const entry = rows.find((row) => row.nspname === 'public' && row.proname === name);
        expect(entry).toMatchObject({ prosecdef: false });
        expect(entry.prosrc).toContain(`SELECT ${argsText}`);
        expect(rows.find((row) => row.nspname === 'private' && row.proname === name)).toMatchObject({ prosecdef: true });
      }
      const allowlist = (await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows.map((row) => row.oid);
      expect(allowlist).toHaveLength(74);
      const expected = (await db().query('select to_regprocedure(s)::oid::text as oid from unnest($1::text[]) as s', [G3D_ALLOWLIST])).rows.map((row) => row.oid);
      expect([...allowlist].sort()).toEqual([...expected].sort());
      for (const row of rows) expect({ name: `${row.nspname}.${row.proname}`, listed: allowlist.includes(row.oid) }).toEqual({ name: `${row.nspname}.${row.proname}`, listed: row.nspname === 'private' });
      expect((await db().query('select cardinality(private.group_g_writer_allowlist()) n')).rows[0].n).toBe(74);
    });
  });

  describe('FREQ-534-AC-05 旧4RPCの停止と迂回経路0', () => {
    test('FREQ-534-AC-05: 旧4RPC（作成・取消・伝票の訂正・手動の配達済み）は引き続き LEGACY_FULFILLMENT_DISABLED / 55000 で拒否し、何も書かない', async () => {
      const f = await ready(); const { slip, confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      const target = confirmed.fulfillments[0];
      const lines = JSON.stringify([{ order_item_id: f.orderItemId, quantity: 1 }]);
      const legacy: Array<[string, unknown[]]> = [
        ['select * from public.admin_create_fulfillment($1,$2,$3,$4,$5,$6,$7::jsonb)', [f.orderId, actor, randomUUID(), 'yamato', 'LEGACY-1', true, lines]],
        ['select * from public.admin_cancel_fulfillment($1,$2,$3)', [f.orderId, target.fulfillmentId, actor]],
        ['select * from public.admin_update_fulfillment_tracking($1,$2,$3,$4,$5,$6,$7)', [f.orderId, target.fulfillmentId, actor, randomUUID(), 'sagawa', 'LEGACY-2', true]],
        ['select * from public.admin_mark_fulfillment_delivered($1,$2,$3,$4,$5::date,$6)', [f.orderId, target.fulfillmentId, actor, randomUUID(), today, true]],
      ];
      const before = await snapshot();
      for (const [statement, params] of legacy) {
        expect({ statement, error: await flow.rejected(() => db().query(statement, params)) }).toEqual({ statement, error: { message: 'LEGACY_FULFILLMENT_DISABLED', code: '55000' } });
      }
      expect(await snapshot()).toEqual(before);
      expect(await slipRow(slip.id)).toMatchObject({ version: 2, tracking_version: 1 });
    });

    test('FREQ-534-AC-05: authenticated・service_role は発送の表（order_fulfillments・order_fulfillment_lines）へ直接 INSERT・UPDATE できない（権限が無く、実際に断られる）', async () => {
      for (const role of ['authenticated', 'service_role']) {
        for (const table of ['public.order_fulfillments', 'public.order_fulfillment_lines']) {
          for (const privilege of ['INSERT', 'UPDATE']) {
            expect({ role, table, privilege, granted: (await db().query('select has_table_privilege($1,$2,$3) granted', [role, table, privilege])).rows[0].granted })
              .toEqual({ role, table, privilege, granted: false });
          }
        }
      }
      const f = await ready(); const { confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      const target = confirmed.fulfillments[0].fulfillmentId;
      for (const role of ['authenticated', 'service_role']) {
        for (const statement of [
          `update public.order_fulfillments set notify_customer = not notify_customer where id='${target}'`,
          `update public.order_fulfillment_lines set quantity = quantity where fulfillment_id='${target}'`,
          `insert into public.order_fulfillment_lines(fulfillment_id,order_item_id,quantity) values('${target}','${f.orderItemId}',1)`,
        ]) {
          const error = await flow.rejected(async () => { await db().query(`set local role ${role}`); await db().query(statement); });
          expect({ role, statement, code: error.code }).toEqual({ role, statement, code: '42501' });
        }
      }
    });

    test('FREQ-534-AC-05: 発送の作成・取消・伝票の変更・配達済みの経路は票の書き手だけ。発送の表へ書く関数は閉じた一覧の中にあり、停止の旧4RPCは何も書かない。裏付けの無い発送の行は消費の守りが遅延で断る', async () => {
      const procs = (await db().query(`select p.oid::text as oid, n.nspname as schema, p.proname as name, lower(regexp_replace(p.prosrc, '--[^\\n]*', ' ', 'g')) as src
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
        where n.nspname in ('public','private') and l.lanname in ('sql','plpgsql')`)).rows as Array<{ oid: string; schema: string; name: string; src: string }>;
      const allowlist = new Set((await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows.map((row) => String(row.oid)));
      const writes = /\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\s*\.\s*)?"?(?:order_fulfillments|order_fulfillment_lines)"?\b/;
      const writers = procs.filter((proc) => writes.test(proc.src.replace(/"/g, '')));
      expect(writers.filter((proc) => !allowlist.has(proc.oid)).map((proc) => `${proc.schema}.${proc.name}`)).toEqual([]);
      const names = writers.map((proc) => proc.name);
      for (const name of ['admin_confirm_shipment_slip', 'admin_cancel_shipment_slip', 'admin_update_shipment_slip_tracking', 'admin_mark_shipment_slip_delivered']) {
        expect({ name, found: names.includes(name) }).toEqual({ name, found: true });
      }
      for (const stopped of ['admin_create_fulfillment', 'admin_cancel_fulfillment', 'admin_update_fulfillment_tracking', 'admin_mark_fulfillment_delivered']) {
        expect({ stopped, writes: writers.some((proc) => proc.schema === 'public' && proc.name === stopped) }).toEqual({ stopped, writes: false });
      }
      // The consume-backing guard: a fulfillment line with no consume behind it is refused at the deferred check.
      const c = await ready({ quantity: 4, allocated: 3 });
      const fulfillment = (await db().query(`insert into public.order_fulfillments
        (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipment_date)
        values($1,1,gen_random_uuid(),null,null,false,false,(now() at time zone 'Asia/Tokyo')::date) returning id`, [c.orderId])).rows[0].id as string;
      const error = await flow.rejected(async () => {
        await db().query('insert into public.order_fulfillment_lines(fulfillment_id,order_item_id,quantity) values($1,$2,1)', [fulfillment, c.orderItemId]);
        await db().query('set constraints all immediate');
      });
      expect(error).toEqual({ code: '23514', message: 'GROUP_G_SHIPMENT_CONSUMPTION', detail: 'line_without_consume' });
    });
  });
});
