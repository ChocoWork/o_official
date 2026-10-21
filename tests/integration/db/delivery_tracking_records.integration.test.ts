/** @jest-environment node */
import { randomUUID } from 'crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { insertDeliveryFixture } from './helpers/delivery-tracking-fixtures';
import {
  createCatalogFixture, insertOrderWithLines, insertRefundRecord, insertReturnRecord, insertCancelRequest,
} from './helpers/order-fixtures';

/** 移行 A だけで守る契約を試す。管理・追跡の RPC（移行 B/C）には依存させない。 */
jest.setTimeout(30000);

const SHIPPED_AT = '2026-10-20T03:00:00.000Z';
const STATUSES = ['confirmed', 'in_transit', 'out_for_delivery', 'attempted_delivery', 'ready_for_pickup', 'delivered', 'delayed', 'failure'];
const SOURCES = ['shipment', 'tracking', 'manual', 'tracking_edit'];
const ATTENTION_KINDS = ['delivery_failure', 'attempted_delivery', 'tracking_not_found', 'tracking_registration_failed', 'tracking_stalled'];
const DELIVERY_KINDS = ['out_for_delivery', 'delivered', 'shipping_update'] as const;
const TABLES = [
  'public.order_fulfillment_events',
  'public.order_fulfillment_tracking_changes',
  'public.order_fulfillment_attention',
  'private.fulfillment_tracking_registrations',
  'private.delivery_tracking_provider_gate',
] as const;
const PRIVATE_FUNCTIONS = [
  'private.restrict_fulfillment_record_update()',
  'private.guard_delivery_settings_update()',
  'private.reject_delivery_record_change()',
  'private.guard_delivery_attention_update()',
  'private.backfill_delivery_events()',
  'private.enqueue_order_email(uuid,text,text,uuid,uuid)',
];
const CLAIM_COLUMNS = [
  'email_id', 'order_id', 'kind', 'variant', 'origin', 'attempts', 'lease_token', 'subject', 'body_text',
  'payment_expired_sent', 'fulfillment_id', 'refund_id', 'return_id', 'return_receipt_id', 'cancel_request_id',
  'tracking_version', 'tracking_change_id',
];

/** 拒否された SQL の影響を戻して、同じ取引で次の守りも確かめられるようにする。 */
async function sqlError(client: PgClient, sql: string, params: unknown[] = []): Promise<{ code: string }> {
  await client.query('savepoint delivery_rejected');
  let caught: unknown;
  try {
    await client.query(sql, params);
  } catch (error) {
    caught = error;
  } finally {
    await client.query('rollback to savepoint delivery_rejected');
    await client.query('release savepoint delivery_rejected');
  }
  expect(caught).toBeDefined();
  return caught as { code: string };
}

/** 期待の失敗や照合の失敗があっても、後の試験にロールを持ち越さない。 */
async function asRole<T>(client: PgClient, role: 'anon' | 'authenticated' | 'service_role', action: () => Promise<T>): Promise<T> {
  await client.query('savepoint delivery_role');
  await client.query(`set local role ${role}`);
  try {
    return await action();
  } finally {
    await client.query('rollback to savepoint delivery_role');
    await client.query('reset role');
    await client.query('release savepoint delivery_role');
  }
}

async function createOrder(client: PgClient) {
  const catalog = await createCatalogFixture(client, { stock: 4 });
  const order = await insertOrderWithLines(client, {
    status: 'paid', paidAmount: 10000,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 2, fulfillmentType: 'stock' }],
  });
  return { orderId: order.orderId, orderItemId: order.orderItemIds[0] };
}

async function createShipment(client: PgClient) {
  const order = await createOrder(client);
  const shipment = await insertDeliveryFixture(client, { orderId: order.orderId, shippedAt: SHIPPED_AT });
  await client.query(
    'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, 1)',
    [shipment.fulfillmentId, order.orderItemId],
  );
  return { ...order, ...shipment };
}

function insertEvent(client: PgClient, fulfillmentId: string, input: {
  status?: string; source?: string; version?: number; at?: string; requestKey?: string | null;
  fingerprint?: string | null; actor?: string | null; providerSubStatus?: string | null;
} = {}) {
  return client.query(
    `insert into public.order_fulfillment_events
       (fulfillment_id, tracking_version, status, happened_at, source, request_key, request_fingerprint, created_by, provider_sub_status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [fulfillmentId, input.version ?? 1, input.status ?? 'confirmed', input.at ?? SHIPPED_AT, input.source ?? 'shipment',
      input.requestKey ?? null, input.fingerprint ?? null, input.actor ?? null, input.providerSubStatus ?? null],
  );
}

function insertChange(client: PgClient, fulfillmentId: string, version = 2, requestKey = randomUUID()) {
  return client.query(
    `insert into public.order_fulfillment_tracking_changes
       (fulfillment_id, from_carrier, to_carrier, from_tracking_number, to_tracking_number,
        tracking_version, notify_customer, request_key, request_fingerprint, changed_by)
     values ($1, 'yamato', 'sagawa', 'DELIVERY-123', 'SG-456', $2, true, $3, 'fixture', $4) returning id`,
    [fulfillmentId, version, requestKey, randomUUID()],
  );
}

function insertRegistration(client: PgClient, fulfillmentId: string, version = 1) {
  return client.query(
    `insert into private.fulfillment_tracking_registrations
       (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
     values ($1, $2, 'yamato', 'SHARED-123', $3::timestamptz + interval '30 days')`,
    [fulfillmentId, version, SHIPPED_AT],
  );
}

function insertEmail(client: PgClient, orderId: string, kind: string, input: {
  fulfillmentId?: string | null; version?: number | null; changeId?: string | null; variant?: string | null;
} = {}) {
  return client.query(
    `insert into private.order_email_outbox
       (order_id, kind, variant, origin, fulfillment_id, tracking_version, tracking_change_id)
     values ($1, $2, $3, 'auto', $4, $5, $6) returning id`,
    [orderId, kind, input.variant ?? null, input.fulfillmentId ?? null, input.version ?? null, input.changeId ?? null],
  );
}

describeLocalDb('integration: 配送の記録と守り（移行 A）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  test('最初は追跡オフで登録もメールも無い', async () => {
    const { fulfillmentId } = await createShipment(db());
    const settings = (await db().query('select delivery_tracking_enabled, delivery_tracking_updated_at, delivery_tracking_updated_by from public.shop_settings where id = 1')).rows[0];
    const registrations = (await db().query('select * from private.fulfillment_tracking_registrations')).rows;
    const deliveryEmails = (await db().query("select * from private.order_email_outbox where kind in ('out_for_delivery', 'delivered', 'shipping_update')")).rows;
    expect(settings.delivery_tracking_enabled).toBe(false);
    expect(settings.delivery_tracking_updated_at).toBeNull();
    expect(settings.delivery_tracking_updated_by).toBeNull();
    expect(registrations).toHaveLength(0);
    expect(deliveryEmails).toHaveLength(0);
    const fulfillment = (await db().query('select * from public.order_fulfillments where id = $1', [fulfillmentId])).rows[0];
    expect(fulfillment).toMatchObject({ delivery_status: 'confirmed', delivered_at: null, tracking_version: 1, request_fingerprint: null });
    expect(fulfillment.delivery_status_at.toISOString()).toBe(SHIPPED_AT);
    expect((await db().query('select id, next_call_at from private.delivery_tracking_provider_gate')).rows).toEqual([
      { id: true, next_call_at: expect.any(Date) },
    ]);
  });

  test('8状況・4つの出どころ・5つの要対応以外は23514', async () => {
    const { fulfillmentId, orderId } = await createShipment(db());
    for (const status of STATUSES) await insertEvent(db(), fulfillmentId, { status });
    for (const [index, source] of SOURCES.entries()) {
      await insertEvent(db(), fulfillmentId, {
        source, at: `2026-10-20T0${index + 4}:00:00.000Z`,
        ...(source === 'manual' ? { requestKey: randomUUID(), fingerprint: 'fixture', actor: randomUUID() } : {}),
      });
    }
    for (const kind of ATTENTION_KINDS) {
      await db().query('insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1, $2)', [fulfillmentId, kind]);
    }
    const invalidStatus = await sqlError(db(),
      `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
       values ($1, 1, 'unknown', now(), 'tracking')`, [fulfillmentId]);
    expect(invalidStatus.code).toBe('23514');
    const invalidSource = await sqlError(db(),
      `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
       values ($1, 1, 'confirmed', now(), 'unknown')`, [fulfillmentId]);
    expect(invalidSource.code).toBe('23514');
    const invalidKind = await sqlError(db(), 'insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1, $2)', [fulfillmentId, 'unknown']);
    expect(invalidKind.code).toBe('23514');
    const invalidCurrent = await sqlError(db(),
      `insert into public.order_fulfillments (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, delivery_status)
       values ($1, 2, gen_random_uuid(), 'yamato', 'VALID-123', false, false, 'unknown')`, [orderId]);
    expect(invalidCurrent.code).toBe('23514');
  });

  test('同じ発送・版・状況・時刻は1行だけ', async () => {
    const { fulfillmentId } = await createShipment(db());
    await insertEvent(db(), fulfillmentId);
    const duplicateEvent = await sqlError(db(),
      `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
       values ($1, 1, 'confirmed', $2, 'tracking')`, [fulfillmentId, SHIPPED_AT]);
    expect(duplicateEvent.code).toBe('23505');
    await insertEvent(db(), fulfillmentId, { version: 2 });
    await insertEvent(db(), fulfillmentId, { status: 'in_transit' });
    await insertEvent(db(), fulfillmentId, { at: '2026-10-20T04:00:00.000Z' });
    expect((await db().query('select id from public.order_fulfillment_events where fulfillment_id = $1', [fulfillmentId])).rows).toHaveLength(4);
  });

  test('同じ組の番号を2発送に記録できる', async () => {
    const first = await createShipment(db());
    const second = await insertDeliveryFixture(db(), { orderId: first.orderId, shippedAt: SHIPPED_AT });
    await insertRegistration(db(), first.fulfillmentId);
    await insertRegistration(db(), second.fulfillmentId);
    const pairRows = (await db().query("select * from private.fulfillment_tracking_registrations where carrier = 'yamato' and tracking_number = 'SHARED-123'")).rows;
    expect(pairRows).toHaveLength(2);
    expect(pairRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'pending', attempts: 0, read_attempts: 0, ever_registered: false, retry_allowed: true, signal_revision: '0' }),
    ]));
    const duplicate = await sqlError(db(),
      `insert into private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
       values ($1, 1, 'yamato', 'SHARED-123', now())`, [first.fulfillmentId]);
    expect(duplicate.code).toBe('23505');
  });

  test('届いた時刻は発送より前にならない', async () => {
    const { orderId } = await createOrder(db());
    const sql = `insert into public.order_fulfillments
      (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order,
       shipped_at, delivery_status, delivered_at)
      values ($1, 1, gen_random_uuid(), 'yamato', 'VALID-123', false, false, $2, $3, $4)`;
    const beforeShipment = await sqlError(db(), sql, [orderId, SHIPPED_AT, 'delivered', '2026-10-20T02:59:59.000Z']);
    expect(beforeShipment.code).toBe('23514');
    expect((await sqlError(db(), sql, [orderId, SHIPPED_AT, 'delivered', null])).code).toBe('23514');
    expect((await sqlError(db(), sql, [orderId, SHIPPED_AT, 'confirmed', SHIPPED_AT])).code).toBe('23514');
    await db().query(sql, [orderId, SHIPPED_AT, 'delivered', SHIPPED_AT]);
  });

  test('直接の書き込みはservice_roleも拒む', async () => {
    const { fulfillmentId } = await createShipment(db());
    const serviceRoleInsert = await asRole(db(), 'service_role', () => sqlError(db(),
      `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
       values ($1, 1, 'confirmed', now(), 'shipment')`, [fulfillmentId]));
    expect(serviceRoleInsert.code).toBe('42501');
    for (const table of TABLES) {
      await asRole(db(), 'service_role', async () => {
        await db().query(`select * from ${table} limit 1`);
        for (const statement of [`insert into ${table} default values`, `update ${table} set ${table.endsWith('provider_gate') ? 'next_call_at = now()' : 'fulfillment_id = fulfillment_id'}`, `delete from ${table}`, `truncate ${table} cascade`]) {
          expect((await sqlError(db(), statement)).code).toBe('42501');
        }
      });
    }
  });

  test.each(TABLES)('%s は RLS と RESTRICTIVE の拒否を持ち、anon/authenticated は読めない', async (table) => {
    const [schema, name] = table.split('.');
    const metadata = (await db().query(
      `select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2`, [schema, name])).rows;
    expect(metadata).toEqual([{ rls: true }]);
    for (const role of ['anon', 'authenticated'] as const) {
      expect((await asRole(db(), role, () => sqlError(db(), `select * from ${table} limit 1`))).code).toBe('42501');
      const policies = (await db().query(
        `select permissive, cmd, qual, with_check from pg_policies
         where schemaname = $1 and tablename = $2 and ($3::name = any(roles) or 'public'::name = any(roles))`,
        [schema, name, role])).rows;
      expect(policies).toEqual(expect.arrayContaining([
        expect.objectContaining({ permissive: 'RESTRICTIVE', cmd: 'ALL', qual: 'false', with_check: 'false' }),
      ]));
    }
  });

  test('GUCだけを真似ても配送の列は直せない', async () => {
    const { fulfillmentId } = await createShipment(db());
    // ACL の拒否だけで通ってしまわないよう、取引内だけ UPDATE を与えてトリガーを試す。
    await db().query('grant update on public.order_fulfillments to service_role');
    for (const [operation, assignment] of [
      ['tracking_edit', "tracking_number = 'EDIT-123', tracking_version = 2"],
      ['manual', "delivery_status = 'delivered', delivered_at = now(), delivery_status_at = now()"],
      ['tracking', "delivery_status = 'in_transit', delivery_status_at = now()"],
    ]) {
      await asRole(db(), 'service_role', async () => {
        await db().query("select set_config('app.fulfillment_change', $1, true)", [operation]);
        const error = await sqlError(db(), `update public.order_fulfillments set ${assignment} where id = $1`, [fulfillmentId]);
        const directUpdateRejected = error.code === '55000';
        expect(directUpdateRejected).toBe(true);
      });
    }
  });

  test('設定の配送3列もGUCを真似たservice_roleからは直せない', async () => {
    await db().query('grant update on public.shop_settings to service_role');
    await asRole(db(), 'service_role', async () => {
      await db().query("select set_config('app.delivery_tracking_setting', 'toggle', true)");
      for (const assignment of ['delivery_tracking_enabled = not delivery_tracking_enabled', 'delivery_tracking_updated_at = now()', 'delivery_tracking_updated_by = gen_random_uuid()']) {
        expect((await sqlError(db(), `update public.shop_settings set ${assignment} where id = 1`)).code).toBe('55000');
      }
    });
  });

  test('操作印の無いownerも配送の列と設定は直せない', async () => {
    const { fulfillmentId } = await createShipment(db());
    expect((await sqlError(db(), "update public.order_fulfillments set delivery_status = 'in_transit' where id = $1", [fulfillmentId])).code).toBe('55000');
    expect((await sqlError(db(), 'update public.shop_settings set delivery_tracking_enabled = true where id = 1')).code).toBe('55000');
  });

  test('設定の配送3列の守りは既存の2つのトグルのRPCを妨げない', async () => {
    const before = (await db().query('select * from public.shop_settings where id = 1')).rows[0];
    const actor = randomUUID();
    await asRole(db(), 'service_role', async () => {
      await db().query('select * from public.admin_update_shop_settings($1, $2, $3)', [
        !before.auto_refund_cancelled_order_payment, !before.auto_cancel_amount_mismatch, actor,
      ]);
      const settings = (await db().query('select * from public.shop_settings where id = 1')).rows[0];
      expect(settings).toMatchObject({
        auto_refund_cancelled_order_payment: !before.auto_refund_cancelled_order_payment,
        auto_cancel_amount_mismatch: !before.auto_cancel_amount_mismatch,
        delivery_tracking_enabled: before.delivery_tracking_enabled,
        delivery_tracking_updated_at: before.delivery_tracking_updated_at,
        delivery_tracking_updated_by: before.delivery_tracking_updated_by,
      });
    });
  });

  test('取消済みの配送変更・飛び越した版・追跡による配達済みの戻しはownerも拒む', async () => {
    const active = await createShipment(db());
    const cancelled = await createShipment(db());
    await db().query('update public.order_fulfillments set cancelled_at = now() where id = $1', [cancelled.fulfillmentId]);
    await db().query("select set_config('app.fulfillment_change', 'tracking_edit', true)");
    expect((await sqlError(db(), "update public.order_fulfillments set tracking_version = 2, tracking_number = 'EDIT-123' where id = $1", [cancelled.fulfillmentId])).code).toBe('55000');
    expect((await sqlError(db(), "update public.order_fulfillments set tracking_version = 3, tracking_number = 'EDIT-123' where id = $1", [active.fulfillmentId])).code).toBe('55000');
    expect((await sqlError(db(), 'update public.order_fulfillments set number = 99 where id = $1', [active.fulfillmentId])).code).toBe('55000');
    await db().query("select set_config('app.fulfillment_change', 'manual', true)");
    await db().query("update public.order_fulfillments set delivery_status = 'delivered', delivered_at = $2, delivery_status_at = $2 where id = $1", [active.fulfillmentId, SHIPPED_AT]);
    await db().query("select set_config('app.fulfillment_change', 'tracking', true)");
    expect((await sqlError(db(), "update public.order_fulfillments set delivery_status = 'in_transit', delivered_at = null where id = $1", [active.fulfillmentId])).code).toBe('55000');
  });

  test('作成時の指紋はlegacyのNULLをtracking_editで一度だけ補え、その後は変更もNULL化もできない', async () => {
    const { fulfillmentId } = await createShipment(db());
    await db().query("select set_config('app.fulfillment_change', 'manual', true)");
    expect((await sqlError(db(), "update public.order_fulfillments set request_fingerprint = 'created-input' where id = $1", [fulfillmentId])).code).toBe('55000');
    await db().query("select set_config('app.fulfillment_change', 'tracking_edit', true)");
    await db().query("update public.order_fulfillments set tracking_number = 'EDIT-123', tracking_version = 2, request_fingerprint = 'created-input' where id = $1", [fulfillmentId]);
    for (const fingerprint of ['changed-input', null]) {
      expect((await sqlError(db(), 'update public.order_fulfillments set request_fingerprint = $2 where id = $1', [fulfillmentId, fingerprint])).code).toBe('55000');
    }
  });

  test('追記の行は更新・削除・TRUNCATEできない', async () => {
    const { fulfillmentId } = await createShipment(db());
    const eventId = (await insertEvent(db(), fulfillmentId)).rows[0].id;
    const eventDelete = await sqlError(db(), 'delete from public.order_fulfillment_events where id = $1', [eventId]);
    expect(eventDelete.code).toBe('55000');
    expect((await sqlError(db(), "update public.order_fulfillment_events set status = 'in_transit' where id = $1", [eventId])).code).toBe('55000');
    expect((await sqlError(db(), 'truncate public.order_fulfillment_events')).code).toBe('55000');
    const changeId = (await insertChange(db(), fulfillmentId)).rows[0].id;
    expect((await sqlError(db(), "update public.order_fulfillment_tracking_changes set to_tracking_number = 'EDIT-999' where id = $1", [changeId])).code).toBe('55000');
    expect((await sqlError(db(), 'delete from public.order_fulfillment_tracking_changes where id = $1', [changeId])).code).toBe('55000');
    expect((await sqlError(db(), 'truncate public.order_fulfillment_tracking_changes cascade')).code).toBe('55000');
  });

  test('登録とprovider gateはpostgresからも削除・TRUNCATEできない', async () => {
    const { fulfillmentId } = await createShipment(db());
    await insertRegistration(db(), fulfillmentId);
    for (const table of ['private.fulfillment_tracking_registrations', 'private.delivery_tracking_provider_gate']) {
      expect((await sqlError(db(), `delete from ${table}`)).code).toBe('55000');
      expect((await sqlError(db(), `truncate ${table}`)).code).toBe('55000');
    }
  });

  test('要対応は開いた行の解決3列だけ一度更新できる', async () => {
    const { fulfillmentId } = await createShipment(db());
    const attentionId = (await db().query("insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1, 'delivery_failure') returning id", [fulfillmentId])).rows[0].id;
    expect((await sqlError(db(), "update public.order_fulfillment_attention set kind = 'tracking_stalled' where id = $1", [attentionId])).code).toBe('55000');
    expect((await sqlError(db(), 'delete from public.order_fulfillment_attention where id = $1', [attentionId])).code).toBe('55000');
    expect((await sqlError(db(), 'truncate public.order_fulfillment_attention')).code).toBe('55000');
    await db().query("update public.order_fulfillment_attention set resolved_at = now(), resolution = 'auto' where id = $1", [attentionId]);
    expect((await sqlError(db(), "update public.order_fulfillment_attention set resolution = 'manual', resolved_by = gen_random_uuid() where id = $1", [attentionId])).code).toBe('55000');
    expect((await sqlError(db(), 'update public.order_fulfillment_attention set resolved_at = null, resolution = null where id = $1', [attentionId])).code).toBe('55000');
    await db().query("insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1, 'delivery_failure')", [fulfillmentId]);
    expect((await sqlError(db(), "insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1, 'delivery_failure')", [fulfillmentId])).code).toBe('23505');
  });

  test.each([
    [null, randomUUID(), null], [null, null, 'auto'], [SHIPPED_AT, null, null],
    [SHIPPED_AT, randomUUID(), 'auto'], [SHIPPED_AT, null, 'manual'], [SHIPPED_AT, null, 'unknown'],
  ])('要対応の不整合な解決（%s・%s・%s）は23514', async (at, actor, resolution) => {
    const { fulfillmentId } = await createShipment(db());
    expect((await sqlError(db(),
      `insert into public.order_fulfillment_attention (fulfillment_id, kind, resolved_at, resolved_by, resolution)
       values ($1, 'delivery_failure', $2, $3, $4)`, [fulfillmentId, at, actor, resolution])).code).toBe('23514');
  });

  test('手の出来事だけ要求の番号・指紋・実行者が必須で要求の番号は一意', async () => {
    const { fulfillmentId } = await createShipment(db());
    const key = randomUUID();
    const sql = `insert into public.order_fulfillment_events
      (fulfillment_id, tracking_version, status, happened_at, source, request_key, request_fingerprint, created_by)
      values ($1, $2, 'delivered', now(), $3, $4, $5, $6)`;
    for (const [source, requestKey, fingerprint, actor] of [
      ['manual', null, 'fixture', randomUUID()], ['manual', key, null, randomUUID()], ['manual', key, 'fixture', null],
      ['tracking', key, null, null], ['shipment', null, 'fixture', null], ['tracking_edit', key, 'fixture', null],
    ]) {
      expect((await sqlError(db(), sql, [fulfillmentId, 1, source, requestKey, fingerprint, actor])).code).toBe('23514');
    }
    await db().query(sql, [fulfillmentId, 1, 'manual', key, 'fixture', randomUUID()]);
    expect((await sqlError(db(), sql, [fulfillmentId, 2, 'manual', key, 'fixture', randomUUID()])).code).toBe('23505');
  });

  test('直しの記録は発送と版・要求の番号が一意でlegacyの前の番号はNULLにできる', async () => {
    const { fulfillmentId } = await createShipment(db());
    const key = randomUUID();
    await insertChange(db(), fulfillmentId, 2, key);
    const sql = `insert into public.order_fulfillment_tracking_changes
      (fulfillment_id, to_carrier, to_tracking_number, tracking_version, notify_customer, request_key, request_fingerprint, changed_by)
      values ($1, $2, $3, $4, false, $5, 'fixture', $6)`;
    const actor = randomUUID();
    expect((await sqlError(db(), sql, [fulfillmentId, 'yamato', 'VALID-123', 2, randomUUID(), actor])).code).toBe('23505');
    expect((await sqlError(db(), sql, [fulfillmentId, 'yamato', 'VALID-123', 3, key, actor])).code).toBe('23505');
    for (const [carrier, number, version] of [['other', 'VALID-123', 3], ['yamato', '', 3], ['yamato', 'bad number', 3], ['yamato', 'A'.repeat(65), 3], ['yamato', 'VALID-123', 1]]) {
      expect((await sqlError(db(), sql, [fulfillmentId, carrier, number, version, randomUUID(), actor])).code).toBe('23514');
    }
    const legacy = (await db().query(sql, [fulfillmentId, 'japanpost', 'A'.repeat(64), 3, randomUUID(), actor])).rowCount;
    expect(legacy).toBe(1);
  });

  test.each([
    "state = 'unknown'", "failure_kind = 'unknown'", "state = 'failed'", "failure_kind = 'invalid_number'",
    "state = 'stopped'", "stop_reason = 'unknown'", "stop_reason = 'expired'", 'stopped_at = now()',
    'lease_token = gen_random_uuid()', 'lease_expires_at = now()', 'ever_registered = true',
    'attempts = -1', 'read_attempts = -1', 'signal_revision = -1', 'tracking_version = 0',
    "tracking_number = 'lowercase'", "carrier = 'unknown'", "last_error_code = 'Bad Code'",
    "provider_status = ''", `provider_sub_status = '${'A'.repeat(101)}'`,
  ])('登録のCHECKは不正な%sを拒む', async (assignment) => {
    const { fulfillmentId } = await createShipment(db());
    await insertRegistration(db(), fulfillmentId);
    expect((await sqlError(db(), `update private.fulfillment_tracking_registrations set ${assignment} where fulfillment_id = $1`, [fulfillmentId])).code).toBe('23514');
  });

  test('登録のstate・failure_kind・stop_reasonは契約の全値を受け付ける', async () => {
    const { fulfillmentId } = await createShipment(db());
    await insertRegistration(db(), fulfillmentId);
    await db().query("update private.fulfillment_tracking_registrations set state = 'registered', ever_registered = true, registered_at = now() where fulfillment_id = $1", [fulfillmentId]);
    for (const failure of ['invalid_number', 'repeated_error']) {
      await db().query("update private.fulfillment_tracking_registrations set state = 'failed', failure_kind = $2 where fulfillment_id = $1", [fulfillmentId, failure]);
    }
    for (const reason of ['delivered', 'expired', 'replaced', 'cancelled', 'provider_stopped', 'disabled']) {
      await db().query("update private.fulfillment_tracking_registrations set state = 'stopped', failure_kind = null, stop_reason = $2, stopped_at = now() where fulfillment_id = $1", [fulfillmentId, reason]);
    }
  });

  test('新しい外部キーはpostgresでも参照先の無い行を拒み削除はRESTRICT', async () => {
    const missing = randomUUID();
    expect((await sqlError(db(), "insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source) values ($1, 1, 'confirmed', now(), 'shipment')", [missing])).code).toBe('23503');
    expect((await sqlError(db(), "insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1, 'delivery_failure')", [missing])).code).toBe('23503');
    expect((await sqlError(db(), "insert into private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at) values ($1, 1, 'yamato', 'VALID-123', now())", [missing])).code).toBe('23503');
    expect((await sqlError(db(), `insert into public.order_fulfillment_tracking_changes
      (fulfillment_id, to_carrier, to_tracking_number, tracking_version, notify_customer, request_key, request_fingerprint, changed_by)
      values ($1, 'yamato', 'VALID-123', 2, false, gen_random_uuid(), 'fixture', gen_random_uuid())`, [missing])).code).toBe('23503');
    const { orderId, fulfillmentId } = await createShipment(db());
    expect((await sqlError(db(), `insert into private.order_email_outbox (order_id, kind, origin, fulfillment_id, tracking_version, tracking_change_id)
      values ($1, 'shipping_update', 'auto', $2, 2, $3)`, [orderId, fulfillmentId, missing])).code).toBe('23503');
    const fks = (await db().query(
      `select conrelid::regclass::text as relation, confdeltype from pg_constraint
       where contype = 'f' and (conrelid = any($1::regclass[])
         or (conrelid = 'private.order_email_outbox'::regclass and confrelid = 'public.order_fulfillment_tracking_changes'::regclass))`,
      [TABLES])).rows;
    expect(fks).toHaveLength(5);
    for (const fk of fks) expect(fk.confdeltype).toBe('r');
  });

  test('バックフィルは取消以外とlegacy番号無しに初回2行・2回目0行で登録もメールも作らない', async () => {
    // ほかの試験が先に作った発送を揃えてから、このfixtureだけの追加件数を照合する。
    await db().query('select private.backfill_delivery_events()');
    const active = await createShipment(db());
    const cancelled = await createShipment(db());
    await db().query('update public.order_fulfillments set cancelled_at = now() where id = $1', [cancelled.fulfillmentId]);
    const legacyOrder = await createOrder(db());
    const legacyId = (await db().query(
      `insert into public.order_fulfillments (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, shipped_at, delivery_status_at, legacy)
       values ($1, 1, gen_random_uuid(), null, null, false, false, $2, $2, true) returning id`, [legacyOrder.orderId, SHIPPED_AT])).rows[0].id as string;
    const first = (await db().query('select private.backfill_delivery_events() as added')).rows[0].added;
    const second = (await db().query('select private.backfill_delivery_events() as added')).rows[0].added;
    expect(first).toBe(2);
    expect(second).toBe(0);
    const ids = [active.fulfillmentId, cancelled.fulfillmentId, legacyId];
    const events = (await db().query('select * from public.order_fulfillment_events where fulfillment_id = any($1::uuid[])', [ids])).rows;
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.fulfillment_id).sort()).toEqual([active.fulfillmentId, legacyId].sort());
    for (const event of events) {
      expect(event).toMatchObject({ tracking_version: 1, status: 'confirmed', source: 'shipment', request_key: null, request_fingerprint: null });
      expect(event.happened_at.toISOString()).toBe(SHIPPED_AT);
    }
    expect((await db().query('select * from private.fulfillment_tracking_registrations where fulfillment_id = any($1::uuid[])', [ids])).rows).toHaveLength(0);
    expect((await db().query('select * from private.order_email_outbox where fulfillment_id = any($1::uuid[])', [ids])).rows).toHaveLength(0);
  });

  test('claimの最後の2列を増やして既存の15列を保つ', async () => {
    const result = (await db().query(
      `select p.proargnames[array_length(p.proargtypes::oid[], 1) + 1:] as names,
              pg_get_function_result(p.oid) as result
       from pg_proc p where p.oid = 'public.claim_order_email(integer)'::regprocedure`)).rows[0];
    const columnNames = result.names as string[];
    expect(columnNames).toHaveLength(17);
    expect(columnNames).toEqual(CLAIM_COLUMNS);
    expect(columnNames.slice(-3)).toEqual(['cancel_request_id','tracking_version','tracking_change_id']);
    expect(result.result).toBe('TABLE(email_id uuid, order_id uuid, kind text, variant text, origin text, attempts integer, lease_token uuid, subject text, body_text text, payment_expired_sent boolean, fulfillment_id uuid, refund_id uuid, return_id uuid, return_receipt_id uuid, cancel_request_id uuid, tracking_version integer, tracking_change_id uuid)');
  });

  test.each(DELIVERY_KINDS)('outboxの%sは正しい参照とvariant NULLを保ちclaimで返す', async (kind) => {
    await db().query('delete from private.order_email_outbox');
    const { orderId, fulfillmentId } = await createShipment(db());
    const changeId = kind === 'shipping_update' ? (await insertChange(db(), fulfillmentId)).rows[0].id as string : null;
    const version = kind === 'shipping_update' ? 2 : 1;
    const saved = await insertEmail(db(), orderId, kind, { fulfillmentId, version, changeId });
    const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
    expect(Object.keys(claimed)).toEqual(CLAIM_COLUMNS);
    expect(claimed).toMatchObject({ email_id: saved.rows[0].id, order_id: orderId, kind, variant: null, fulfillment_id: fulfillmentId, tracking_version: version, tracking_change_id: changeId });
    const badVariant = await sqlError(db(), `insert into private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, tracking_version, tracking_change_id)
      values ($1, $2, 'standard', 'auto', $3, $4, $5)`, [orderId, kind, fulfillmentId, version, changeId]);
    expect(badVariant.code).toBe('23514');
  });

  test.each([
    ['out_for_delivery', true, null, false], ['delivered', true, null, false], ['shipping_update', true, null, true],
    ['shipping_update', true, 2, false], ['out_for_delivery', false, 1, false], ['delivered', false, 1, false],
    ['shipping_update', false, 2, true], ['out_for_delivery', true, 1, true], ['delivered', true, 1, true],
    ['shipped', true, 1, false], ['awaiting_payment', false, 1, false], ['awaiting_payment', false, null, true],
    ['delivered', true, 0, false],
  ] as const)('outboxの不正な組合せ %s・発送%s・版%s・直し%s は23514', async (kind, withFulfillment, version, withChange) => {
    const { orderId, fulfillmentId } = await createShipment(db());
    const changeId = withChange ? (await insertChange(db(), fulfillmentId)).rows[0].id as string : null;
    const error = await sqlError(db(), `insert into private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, tracking_version, tracking_change_id)
      values ($1, $2, null, 'auto', $3, $4, $5)`, [orderId, kind, withFulfillment ? fulfillmentId : null, version, changeId]);
    expect(error.code).toBe('23514');
  });

  test.each(['out_for_delivery', 'delivered'] as const)('%sは同じ注文の2発送・2版で4行、同じ発送と版では1行', async (kind) => {
    const first = await createShipment(db());
    const second = await insertDeliveryFixture(db(), { orderId: first.orderId, shippedAt: SHIPPED_AT });
    for (const fulfillmentId of [first.fulfillmentId, second.fulfillmentId]) {
      for (const version of [1, 2]) {
        await insertEmail(db(), first.orderId, kind, { fulfillmentId, version });
        const duplicate = await sqlError(db(), `insert into private.order_email_outbox (order_id, kind, origin, fulfillment_id, tracking_version)
          values ($1, $2, 'auto', $3, $4)`, [first.orderId, kind, fulfillmentId, version]);
        expect(duplicate.code).toBe('23505');
      }
    }
    expect((await db().query('select * from private.order_email_outbox where order_id = $1 and kind = $2', [first.orderId, kind])).rows).toHaveLength(4);
  });

  test('shipping_updateは直し1件に1行で2発送・2版を別の行にできる', async () => {
    const first = await createShipment(db());
    const second = await insertDeliveryFixture(db(), { orderId: first.orderId, shippedAt: SHIPPED_AT });
    for (const fulfillmentId of [first.fulfillmentId, second.fulfillmentId]) {
      for (const version of [2, 3]) {
        const changeId = (await insertChange(db(), fulfillmentId, version)).rows[0].id as string;
        await insertEmail(db(), first.orderId, 'shipping_update', { fulfillmentId, version, changeId });
        expect((await sqlError(db(), `insert into private.order_email_outbox (order_id, kind, origin, fulfillment_id, tracking_version, tracking_change_id)
          values ($1, 'shipping_update', 'auto', $2, $3, $4)`, [first.orderId, fulfillmentId, version, changeId])).code).toBe('23505');
      }
    }
    expect((await db().query("select * from private.order_email_outbox where order_id = $1 and kind = 'shipping_update'", [first.orderId])).rows).toHaveLength(4);
  });

  test.each(['paid', 'awaiting_payment', 'canceled', 'refund', 'return_requested', 'cancel_request_shop', 'shipped'])('既存の%sのenqueueはON CONFLICTの誤りなく各1回', async (kind) => {
    const order = await createShipment(db());
    let sql = 'select private.enqueue_order_email($1::uuid, $2::text, $3::text, $4::uuid, $5::uuid) as enqueued';
    let params: unknown[] = [order.orderId, kind, kind === 'paid' ? 'order_confirmed' : kind === 'canceled' ? 'pending' : null, kind === 'shipped' ? order.fulfillmentId : null, null];
    if (kind === 'refund') {
      const refund = await insertRefundRecord(db(), { orderId: order.orderId, status: 'succeeded', amount: 100 });
      params = [order.orderId, kind, 'standard', null, refund.refundId];
    } else if (kind === 'return_requested') {
      const returned = await insertReturnRecord(db(), { orderId: order.orderId, status: 'requested', lines: [{ fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }] });
      sql = 'select private.enqueue_return_email($1::uuid, $2::text, $3::uuid, $4::uuid) as enqueued';
      params = [order.orderId, kind, returned.returnId, null];
    } else if (kind === 'cancel_request_shop') {
      const request = await insertCancelRequest(db(), { orderId: order.orderId, lines: [{ orderItemId: order.orderItemId, quantity: 1 }] });
      sql = 'select private.enqueue_cancel_request_email($1::uuid, $2::text, $3::uuid) as enqueued';
      params = [order.orderId, kind, request.cancelRequestId];
    }
    expect((await db().query(sql, params)).rows).toEqual([{ enqueued: true }]);
    expect((await db().query(sql, params)).rows).toEqual([{ enqueued: false }]);
    expect((await db().query('select * from private.order_email_outbox where order_id = $1 and kind = $2', [order.orderId, kind])).rows).toHaveLength(1);
  });

  test.each(['webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge', 'delivery_tracking'])('opsの%sは心拍を記録できる', async (job) => {
    await db().query(`insert into public.ops_job_heartbeats (job) values ($1) on conflict (job) do update set updated_at = now()`, [job]);
    expect((await db().query('select job from public.ops_job_heartbeats where job = $1', [job])).rows).toEqual([{ job }]);
  });

  test('opsの未知jobは23514', async () => {
    const error = await sqlError(db(), "insert into public.ops_job_heartbeats (job) values ('unknown_delivery_job')");
    expect(error.code).toBe('23514');
  });

  test('public関数のEXECUTEはservice_roleだけでSECURITY DEFINERと空のsearch_pathを保つ', async () => {
    const signature = 'public.claim_order_email(integer)';
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const result = await db().query("select has_function_privilege($1::text, $2::text, 'EXECUTE') as allowed", [role, signature]);
      expect(result.rows).toEqual([{ allowed: role === 'service_role' }]);
    }
    const result = (await db().query(
      `select prosecdef, proconfig,
        exists(select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) where grantee = 0 and privilege_type = 'EXECUTE') as public_execute
       from pg_proc where oid = $1::regprocedure`, [signature])).rows[0];
    expect(result).toEqual({ prosecdef: true, proconfig: expect.arrayContaining(['search_path=""']), public_execute: false });
  });

  test.each(PRIVATE_FUNCTIONS)('%sにPUBLIC EXECUTEが無い', async (signature) => {
    const result = (await db().query(
      `select exists(select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner)))
        where grantee = 0 and privilege_type = 'EXECUTE') as public_execute
       from pg_proc where oid = $1::regprocedure`, [signature])).rows;
    expect(result).toEqual([{ public_execute: false }]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db().query("select has_function_privilege($1::text, $2::text, 'EXECUTE') as allowed", [role, signature])).rows).toEqual([{ allowed: false }]);
    }
  });
});
