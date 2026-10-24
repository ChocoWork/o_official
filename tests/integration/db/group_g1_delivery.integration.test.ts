/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  correctDeliveryTrackingFixture, deliveryRecord, deliveryRegistration, enableDeliveryTracking, expectDeliveryRejected,
  leaseDeliveryRegistration, patchDeliveryRegistration, recordReadResult, trackedShipment,
} from './helpers/delivery-tracking-fixtures';

/**
 * G-1 Task 13: 配送の反映（record_delivery_read_result）と、版を含む再送キー。
 * 訂正は手元の合成の材料で作る（旧の admin_update_fulfillment_tracking の成功は確かめない。Task 14 で止まる）。
 */
jest.setTimeout(30000);

const APPLIED = { applied: true, changed: true, stopped: true };
const NOTHING = { applied: false, changed: false, stopped: false };
const KEY_EXPRESSION = "pg_catalog.md5('delivery:' || _fulfillment_id::text || ':' || _tracking_version::text || ':' || 'delivered')::uuid";

type Target = Awaited<ReturnType<typeof trackedShipment>>;

async function dbTime(client: PgClient, interval = '0 seconds') {
  return new Date((await client.query('select now() + $1::interval as at', [interval])).rows[0].at).toISOString();
}

function deliveredRead(at: string) {
  return { outcome: 'ok', status: 'delivered', provider_status: 'Delivered', provider_sub_status: 'Delivered_001',
    happened_at: at, delivered_at: at, read_at: at, error_code: null };
}

function statusRead(status: string, happenedAt: string, readAt: string) {
  return { outcome: 'ok', status, provider_status: 'InTransit', provider_sub_status: 'InTransit_001',
    happened_at: happenedAt, delivered_at: null, read_at: readAt, error_code: null };
}

/** 計画どおりの式（fulfillment_id + tracking_version + event）を DB で計算する。 */
async function keyOf(client: PgClient, fulfillmentId: string, version: number) {
  return (await client.query(
    "select pg_catalog.md5('delivery:' || $1::uuid::text || ':' || $2::integer::text || ':' || 'delivered')::uuid as key",
    [fulfillmentId, version],
  )).rows[0].key as string;
}

async function reflections(client: PgClient, fulfillmentId: string) {
  return (await client.query(
    `select id, operation, request_key, cause_type, cause_id, actor_id, exception_id, result
     from private.group_g_operations where operation='delivery_reflect' and cause_id=$1
     order by (result->>'tracking_version')::integer, id`, [fulfillmentId],
  )).rows;
}

async function reflectionEvents(client: PgClient, orderItemId: string) {
  return (await client.query(
    `select e.operation_id, e.unit_from, e.unit_to, e.from_status, e.to_status, e.sequence, e.reason, e.actor_id
     from public.order_item_state_events e join private.group_g_operations g on g.id=e.operation_id
     where e.order_item_id=$1 and g.operation='delivery_reflect' order by e.version`, [orderItemId],
  )).rows;
}

async function itemStates(client: PgClient, orderId: string) {
  const rows = (await client.query(
    'select status, sum(quantity)::integer as n from public.list_admin_order_item_states($1::uuid[]) group by status order by status',
    [[orderId]],
  )).rows as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

/** 配送の反映が増やしうる物を全部まとめて見る（登録の借りの印は試験が書き換えるので含めない）。 */
async function snapshot(client: PgClient, target: Target) {
  return {
    operations: (await client.query('select count(*)::integer as n from private.group_g_operations')).rows[0].n as number,
    reflections: await reflections(client, target.fulfillmentId),
    stateEvents: (await client.query(
      `select e.id, e.operation_id, e.unit_from, e.unit_to, e.from_status, e.to_status
       from public.order_item_state_events e join public.order_items oi on oi.id=e.order_item_id
       where oi.order_id=$1 order by e.order_item_id, e.version`, [target.orderId],
    )).rows,
    fulfillment: (await client.query(
      'select delivery_status, delivery_status_at, delivered_at, tracking_version from public.order_fulfillments where id=$1',
      [target.fulfillmentId],
    )).rows[0],
    fulfillmentEvents: (await client.query(
      'select id from public.order_fulfillment_events where fulfillment_id=$1 order by id', [target.fulfillmentId],
    )).rows,
    deliveredEmails: (await client.query(
      "select tracking_version from private.order_email_outbox where fulfillment_id=$1 and kind='delivered' order by tracking_version",
      [target.fulfillmentId],
    )).rows,
    states: await itemStates(client, target.orderId),
  };
}

describeLocalDb('integration: G-1 配送の反映と版を含む再送キー（Task 13）', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function shipment() {
    await enableDeliveryTracking(db());
    // 3点のうち2点を送った発送。残りの1点は入金済みの割当（A）を持つ発送準備中
    return trackedShipment(db(), { state: 'registered', quantity: 3, shippedQuantity: 2, notifyCustomer: true });
  }

  test('公開口は private 本体への SECURITY INVOKER の委譲だけで、本体は共通の鍵を最初に取り、補助は取得済みの鍵だけで動く', async () => {
    const rows = (await db().query(
      `select p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig, l.lanname, p.prosrc
       from pg_proc p join pg_language l on l.oid=p.prolang
       where p.oid in ('public.record_delivery_read_result(uuid,integer,uuid,jsonb)'::regprocedure,
         'private.record_delivery_read_result(uuid,integer,uuid,jsonb)'::regprocedure,
         'private.apply_tracking_status(uuid,text,timestamptz,timestamptz)'::regprocedure)`,
    )).rows as Array<{ signature: string; prosecdef: boolean; proconfig: string[]; lanname: string; prosrc: string }>;
    const bySignature = Object.fromEntries(rows.map((row) => [row.signature.replace(/^public\./, ''), row]));
    const entry = bySignature['record_delivery_read_result(uuid,integer,uuid,jsonb)'];
    const body = bySignature['private.record_delivery_read_result(uuid,integer,uuid,jsonb)'];
    const helper = bySignature['private.apply_tracking_status(uuid,text,timestamp with time zone,timestamp with time zone)'];
    expect(entry).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], lanname: 'sql' });
    expect(entry.prosrc.trim())
      .toBe('SELECT * FROM private.record_delivery_read_result(_fulfillment_id, _tracking_version, _lease_token, _result);');
    expect(body).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'], lanname: 'plpgsql' });
    expect(helper).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], lanname: 'plpgsql' });

    // 本体: 共通の鍵 → 設定 → 注文 → 商品の行 → … → 発送 → 登録。共通の鍵より前に行の鍵を取らない
    const src = body.prosrc;
    const advisory = src.indexOf('pg_catalog.pg_advisory_xact_lock(190521, 1)');
    const settings = src.indexOf('FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE');
    const order = src.indexOf('FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE');
    const items = src.indexOf('FROM public.order_items AS oi WHERE oi.order_id = v_order_id ORDER BY oi.id FOR UPDATE');
    const fulfillments = src.indexOf('FROM public.order_fulfillments AS f WHERE f.order_id = v_order_id ORDER BY f.id FOR UPDATE');
    const registration = src.indexOf('FROM private.fulfillment_tracking_registrations AS r');
    expect(advisory).toBeGreaterThan(0);
    expect(src.split('pg_advisory_xact_lock').length).toBe(2);
    expect(Math.min(...['FOR UPDATE', 'FOR SHARE'].map((word) => src.indexOf(word)))).toBeGreaterThan(advisory);
    expect([advisory, settings, order, items, fulfillments, registration].every((at, index, all) => at > 0 && (index === 0 || at > all[index - 1])))
      .toBe(true);
    expect(src).toContain(KEY_EXPRESSION);
    expect(src).toContain("'delivery_reflect'");
    // 入れ子の公開 RPC・在庫の閉包・FIFO を呼ばない
    expect(src).not.toMatch(/\bpublic\.[a-z_]+\(/);
    expect(src).not.toMatch(/lock_group_g_inventory|allocate_group_g_fifo/);
    expect(helper.prosrc).toContain('GROUP_G_INVENTORY_LOCK_REQUIRED');
    expect(helper.prosrc).not.toMatch(/FOR UPDATE|FOR SHARE|pg_advisory_xact_lock/);

    for (const [signature, serviceRole] of [
      ['public.record_delivery_read_result(uuid,integer,uuid,jsonb)', true],
      ['private.record_delivery_read_result(uuid,integer,uuid,jsonb)', true],
      ['private.apply_tracking_status(uuid,text,timestamptz,timestamptz)', false],
    ] as const) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db().query("select has_function_privilege($1::text,$2::text,'EXECUTE') as allowed", [role, signature])).rows[0].allowed)
          .toBe(role === 'service_role' && serviceRole);
      }
    }

    // 補助は共通の鍵が無ければ断る（何も書かない）。鍵があれば知らない発送には何もしない
    await expectDeliveryRejected(db(), () => db().query(
      "select private.apply_tracking_status(gen_random_uuid(), 'in_transit', now(), null)",
    ), 'GROUP_G_INVENTORY_LOCK_REQUIRED', '55000');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await expect(db().query("select private.apply_tracking_status(gen_random_uuid(), 'in_transit', now(), null)")).resolves.toBeDefined();
  });

  test('版1の配達済みは操作1件と状態履歴を同じ取引で残し、同じ版の再送は何も足さない', async () => {
    const target = await shipment();
    expect(await itemStates(db(), target.orderId)).toEqual({ ready: 1, shipped: 2 });
    const operationsBefore = (await snapshot(db(), target)).operations;
    const lease = await leaseDeliveryRegistration(db(), target.fulfillmentId);
    const at = await dbTime(db());
    expect(await recordReadResult(db(), lease, deliveredRead(at))).toEqual(APPLIED);

    const ops = await reflections(db(), target.fulfillmentId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      operation: 'delivery_reflect', request_key: await keyOf(db(), target.fulfillmentId, 1),
      cause_type: 'fulfillment', cause_id: target.fulfillmentId, actor_id: null, exception_id: null,
    });
    expect(ops[0].result).toMatchObject({
      fulfillment_id: target.fulfillmentId, order_id: target.orderId, tracking_version: 1, event: 'delivered',
    });
    expect(await reflectionEvents(db(), target.orderItemId)).toEqual([{
      operation_id: ops[0].id, unit_from: 0, unit_to: 2, from_status: 'shipped', to_status: 'delivered',
      sequence: 1, reason: 'delivery_reflect', actor_id: null,
    }]);
    expect(await itemStates(db(), target.orderId)).toEqual({ delivered: 2, ready: 1 });
    expect(await deliveryRecord(db(), target.fulfillmentId)).toMatchObject({ delivery_status: 'delivered', tracking_version: 1 });
    const settled = await snapshot(db(), target);
    expect(settled.operations).toBe(operationsBefore + 1);
    expect(settled.deliveredEmails).toEqual([{ tracking_version: 1 }]);

    // 同じ借りの印・同じ結果の再送
    expect(await recordReadResult(db(), lease, deliveredRead(at))).toEqual(NOTHING);
    // 止まった登録への新しい借りの印
    expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), deliveredRead(at))).toEqual(NOTHING);
    // 届いた版の登録を追跡中へ戻しても（行2）、登録を止めるだけで操作・状態履歴・メールは増えない
    await patchDeliveryRegistration(db(), target.fulfillmentId, "state='registered',stop_reason=null,stopped_at=null");
    expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), deliveredRead(at)))
      .toEqual({ applied: true, changed: false, stopped: true });
    expect(await snapshot(db(), target)).toEqual(settled);
  });

  test('合成の訂正で版2の発送済みに戻すと、版2の正当な配達済みは2件目として残り、旧版と借りの印の違いは何も足さない', async () => {
    const target = await shipment();
    const at = await dbTime(db());
    expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), deliveredRead(at))).toEqual(APPLIED);

    const edit = await correctDeliveryTrackingFixture(db(), {
      orderId: target.orderId, fulfillmentId: target.fulfillmentId, actorId: target.actorId, requestKey: randomUUID(),
      carrier: 'sagawa', trackingNumber: `EDIT-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`, notifyCustomer: true,
    });
    expect(edit.tracking_version).toBe(2);
    expect(await deliveryRecord(db(), target.fulfillmentId)).toMatchObject({
      tracking_version: 2, delivery_status: 'confirmed', delivered_at: null,
    });
    expect(await itemStates(db(), target.orderId)).toEqual({ ready: 1, shipped: 2 });
    expect(await reflections(db(), target.fulfillmentId)).toHaveLength(1);
    expect(await deliveryRegistration(db(), target.fulfillmentId, 2)).toMatchObject({ state: 'pending' });
    await patchDeliveryRegistration(db(), target.fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 2);
    const lease2 = await leaseDeliveryRegistration(db(), target.fulfillmentId, 2);

    const beforeRefused = await snapshot(db(), target);
    // 版2の借りの印が違う
    expect(await recordReadResult(db(), { ...lease2, lease_token: randomUUID() }, deliveredRead(at))).toEqual(NOTHING);
    // 旧版（版1）。登録を追跡中・有効な借りの印にしても、発送の版が違うので書かない
    await patchDeliveryRegistration(db(), target.fulfillmentId, "state='registered',stop_reason=null,stopped_at=null", 1);
    expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId, 1), deliveredRead(at))).toEqual(NOTHING);
    expect(await snapshot(db(), target)).toEqual(beforeRefused);

    // 版2の正当な配達済み
    expect(await recordReadResult(db(), lease2, deliveredRead(at))).toEqual(APPLIED);
    const ops = await reflections(db(), target.fulfillmentId);
    const keys = [await keyOf(db(), target.fulfillmentId, 1), await keyOf(db(), target.fulfillmentId, 2)];
    expect(ops.map((op) => op.request_key)).toEqual(keys);
    expect(new Set(keys).size).toBe(2);
    expect(ops[1].result).toMatchObject({ fulfillment_id: target.fulfillmentId, tracking_version: 2, event: 'delivered' });
    expect(await reflectionEvents(db(), target.orderItemId)).toEqual(ops.map((op) => ({
      operation_id: op.id, unit_from: 0, unit_to: 2, from_status: 'shipped', to_status: 'delivered',
      sequence: 1, reason: 'delivery_reflect', actor_id: null,
    })));
    const after = await snapshot(db(), target);
    expect(after.operations).toBe(beforeRefused.operations + 1);
    expect(after.states).toEqual({ delivered: 2, ready: 1 });
    expect(after.deliveredEmails).toEqual([{ tracking_version: 1 }, { tracking_version: 2 }]);

    // 版2の再送も何も足さない
    expect(await recordReadResult(db(), lease2, deliveredRead(at))).toEqual(NOTHING);
    expect(await snapshot(db(), target)).toEqual(after);
  });

  test('配達済み以外の状況・見つからない・一時の失敗は、配送の契約どおり動き、操作も状態履歴も足さない', async () => {
    const target = await shipment();
    const before = await snapshot(db(), target);
    const now = await dbTime(db());
    for (const [index, status] of ['in_transit', 'out_for_delivery', 'attempted_delivery', 'failure'].entries()) {
      const happened = await dbTime(db(), `-${4 - index} hours`);
      expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), statusRead(status, happened, now)))
        .toEqual({ applied: true, changed: true, stopped: false });
    }
    for (const outcome of ['not_found', 'transient']) {
      expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), {
        outcome, status: null, provider_status: null, provider_sub_status: null, happened_at: null, delivered_at: null,
        read_at: now, error_code: outcome === 'transient' ? 'http_503' : null,
      })).toMatchObject({ applied: true, changed: false });
    }
    const after = await snapshot(db(), target);
    expect(after.fulfillment).toMatchObject({ delivery_status: 'failure', delivered_at: null });
    expect({ operations: after.operations, reflections: after.reflections, stateEvents: after.stateEvents, states: after.states })
      .toEqual({ operations: before.operations, reflections: before.reflections, stateEvents: before.stateEvents, states: before.states });
  });

  test('同じ版・同じ出来事の反映がすでに記録されていれば、配送の契約は進めるが操作も状態履歴も足さない', async () => {
    const target = await shipment();
    const key = await keyOf(db(), target.fulfillmentId, 1);
    await db().query(
      `insert into private.group_g_operations (id,operation,request_key,fingerprint,cause_type,cause_id,result)
       values (gen_random_uuid(),'delivery_reflect',$1,repeat('a',64),'fulfillment',$2,'{}')`, [key, target.fulfillmentId],
    );
    const before = await snapshot(db(), target);
    const at = await dbTime(db());
    expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), deliveredRead(at))).toEqual(APPLIED);
    const after = await snapshot(db(), target);
    expect(after.fulfillment).toMatchObject({ delivery_status: 'delivered' });
    expect(after.operations).toBe(before.operations);
    expect(after.reflections).toEqual(before.reflections);
    expect(after.stateEvents).toEqual(before.stateEvents);
  });

  test('状態履歴が書けなければ、配送の反映・登録・メール・操作は全部戻る', async () => {
    const target = await shipment();
    const lease = await leaseDeliveryRegistration(db(), target.fulfillmentId);
    const at = await dbTime(db());
    const before = await snapshot(db(), target);
    const registrationBefore = await deliveryRegistration(db(), target.fulfillmentId);
    await db().query('savepoint g1_delivery_injected');
    await db().query(`create function private.g1_delivery_injected_failure() returns trigger language plpgsql set search_path = '' as $f$
      begin raise exception 'G1_DELIVERY_INJECTED_FAILURE' using errcode = 'P0001'; end $f$`);
    await db().query(`create trigger g1_delivery_injected_failure before insert on public.order_item_state_events
      for each row execute function private.g1_delivery_injected_failure()`);
    await expectDeliveryRejected(db(), () => recordReadResult(db(), lease, deliveredRead(at)), 'G1_DELIVERY_INJECTED_FAILURE', 'P0001');
    expect(await snapshot(db(), target)).toEqual(before);
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toEqual(registrationBefore);
    await db().query('rollback to savepoint g1_delivery_injected');
    await db().query('release savepoint g1_delivery_injected');
    // 故障を外せば同じ借りの印で反映できる（材料が正しいことの確かめ）
    expect(await recordReadResult(db(), lease, deliveredRead(at))).toEqual(APPLIED);
    expect(await reflections(db(), target.fulfillmentId)).toHaveLength(1);
  });
});
