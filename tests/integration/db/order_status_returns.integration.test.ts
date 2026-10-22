/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createDeliveryActor } from './helpers/delivery-tracking-fixtures';
import { insertCancelRequest, insertReturnRecord } from './helpers/order-fixtures';
import {
  asOrderStatusRole, createOrderStatusFixture, createOrderStatusReturnsFixture, installLegacyCustomerReturns,
  orderStatusSqlError, ORDER_STATUS_INTERNAL_SENTINEL, ORDER_STATUS_PRIVATE_SENTINEL,
  setOrderStatusReturnSettings, type OrderStatusReturnScenario,
} from './helpers/order-status-fixtures';

jest.setTimeout(60000);

type Row = Record<string, any>;
type CustomerOrder = { orderId: string; customerId: string | null };

const SCENARIOS: OrderStatusReturnScenario[] = [
  'requested', 'accepted', 'closed', 'declined', 'cancelled', 'exchange_pending', 'exchange_shipped',
  'partially_received', 'inspecting', 'awaiting_fee', 'awaiting_fee_and_partial',
  'refund_preparing', 'refund_pending', 'returned', 'sent_back',
];
const EXPECTED_CUSTOMER_STATUSES: Partial<Record<OrderStatusReturnScenario, string>> = {
  requested: 'requested', accepted: 'accepted', closed: 'returned', declined: 'declined',
  partially_received: 'partially_received', inspecting: 'inspecting', awaiting_fee: 'awaiting_fee',
  awaiting_fee_and_partial: 'awaiting_fee', refund_preparing: 'refund_preparing', returned: 'returned',
};
const INTERNAL_KEYS = [
  'shop_note', 'reason', 'reason_note', 'customer_note', 'decline_reason', 'source',
  'requested_by', 'approved_at', 'approved_by', 'declined_at', 'declined_by', 'created_at', 'created_by',
  'cancelled_at', 'cancelled_by', 'reopened_at', 'reopened_by', 'closed_by', 'resolved_at', 'resolved_by',
  'resolved_refund_id', 'resolved_by_cancel_at', 'request_key', 'request_fingerprint', 'notify_customer',
  'fee_due_amount', 'fee_settled_amount', 'fee_pending_deduction', 'fee_received_at', 'fee_received_by',
  'fee_received_note', 'fee_waived', 'exchange_released_at', 'exchange_released_by', 'exchange_method',
  'exchange_fee', 'exchange_shipping_fee', 'restocking_fee_percent', 'return_carrier', 'return_tracking_number',
  'requested_exchange_variant_id', 'exchange_variant_id', 'return_line_id', 'order_item_id', 'fulfillment_id',
  'note', 'actor_id', 'actor_can_refund', 'refund_choice', 'refund_id', 'kind', 'storage_path',
];
const PRIVATE_KEYS = [
  'return_address', 'carrier', 'tracking_number', 'shipping_phone', 'shipping_email', 'shipping_full_name',
  'shipping_postal_code', 'shipping_prefecture', 'shipping_city', 'shipping_address', 'shipping_building', 'payment_method',
];

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...keysDeep(entry)]);
}

/** 公開型の差分は返送先と送り返しの業者・番号の3キーだけ。ほかの値・null・順序を落とさない。 */
function publicProjection(before: Row): Row {
  return {
    ...before,
    returns: before.returns.map((entry: Row) => ({
      ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'return_address')),
      sent_back: entry.sent_back.map((sent: Row) =>
        Object.fromEntries(Object.entries(sent).filter(([key]) => !['carrier', 'tracking_number'].includes(key)))),
    })),
  };
}

async function legacyReturns(db: PgClient, order: CustomerOrder): Promise<Row> {
  return (await db.query('select pg_temp.customer_returns_before($1,$2) as value',
    [order.orderId, order.customerId])).rows[0].value;
}

async function compareOwnerReturns(db: PgClient, order: CustomerOrder): Promise<Row> {
  const { before, after } = (await db.query(
    `select pg_temp.customer_returns_before($1,$2) as before,
            public.get_customer_order_returns($1,$2) as after`, [order.orderId, order.customerId],
  )).rows[0];
  expect(after).toEqual(before);
  return before;
}

async function statusReturns(db: PgClient, orderId: string | null, includePrivate?: boolean): Promise<Row | null> {
  const sql = includePrivate === undefined ? 'select public.get_order_status_returns($1) as value'
    : 'select public.get_order_status_returns($1,$2) as value';
  return (await db.query(sql, includePrivate === undefined ? [orderId] : [orderId, includePrivate])).rows[0].value;
}

describeLocalDb('integration: 注文状況の返品の読み出し（移行B）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await installLegacyCustomerReturns(db());
    await setOrderStatusReturnSettings(db(), false);
  });
  afterEach(async () => { await db().query('rollback'); });

  test('既存の持ち主用RPCは元のSQLのJSONと完全に一致する', async () => {
    const orders = [];
    for (const scenario of SCENARIOS) orders.push({ scenario, order: await createOrderStatusReturnsFixture(db(), scenario) });
    for (const hasAddress of [false, true]) {
      await setOrderStatusReturnSettings(db(), hasAddress);
      for (const { scenario, order } of orders) {
        const before = await compareOwnerReturns(db(), order);
        if (scenario === 'cancelled') {
          expect(before.returns).toEqual([]);
          continue;
        }
        expect(before.returns).toHaveLength(1);
        const entry = before.returns[0];
        if (EXPECTED_CUSTOMER_STATUSES[scenario]) expect(entry.customer_status).toBe(EXPECTED_CUSTOMER_STATUSES[scenario]);
        const open = !['requested', 'closed', 'declined', 'returned'].includes(scenario);
        expect(entry.return_address).toEqual(hasAddress && open ? {
          name: ORDER_STATUS_PRIVATE_SENTINEL, postal_code: '9999999', address: ORDER_STATUS_PRIVATE_SENTINEL, phone: '03-0000-0000',
        } : null);
        if (['requested', 'exchange_pending', 'exchange_shipped'].includes(scenario)) {
          expect(entry.lines[0]).toMatchObject({ requested_resolution: 'exchange', requested_exchange: { color: 'WHITE', size: 'L' },
            resolution: 'exchange', exchange: { color: scenario === 'requested' ? 'WHITE' : 'BLUE', size: scenario === 'requested' ? 'L' : 'S' } });
        }
        expect(entry.exchange_shipping).toBe(scenario === 'exchange_pending' ? 'pending' : scenario === 'exchange_shipped' ? 'shipped' : 'none');
        expect(entry.refund_amount).toBe(scenario === 'refund_pending' || scenario === 'returned' ? 8000 : null);
        if (scenario === 'sent_back') {
          expect(entry.sent_back).toHaveLength(2);
          expect(entry.sent_back[0]).toMatchObject({ quantity: 1, message: '返送のご案内', carrier: 'yamato', tracking_number: ORDER_STATUS_PRIVATE_SENTINEL });
          expect(entry.sent_back[1]).toMatchObject({ quantity: 1, message: null, carrier: null, tracking_number: null });
        }
      }
    }
    // 受付の4状態と期限の日付・空、キャンセル可否も、同じ取引時刻・同じ行で比較する。
    await setOrderStatusReturnSettings(db(), false);
    const fresh = orders.find(({ scenario }) => scenario === 'accepted')!.order;
    const past = await createOrderStatusReturnsFixture(db(), 'accepted', { shippedDaysAgo: 30 });
    expect((await compareOwnerReturns(db(), fresh)).availability).toEqual({ returns: 'available', ended_on: null, cancel: false });
    expect((await compareOwnerReturns(db(), past)).availability).toEqual({ returns: 'ended', ended_on: expect.any(String), cancel: false });
    await db().query('update public.shop_return_settings set window_days=null where id=1');
    expect((await compareOwnerReturns(db(), past)).availability.ended_on).toBeNull();
    await db().query('update public.shop_return_settings set requests_enabled=false where id=1');
    expect((await compareOwnerReturns(db(), fresh)).availability).toEqual({ returns: 'closed', ended_on: null, cancel: false });
    await setOrderStatusReturnSettings(db(), false);
    const owner = await createDeliveryActor(db());
    const unshipped = { ...await createOrderStatusFixture(db(), { customerId: owner.id }), customerId: owner.id };
    expect((await compareOwnerReturns(db(), unshipped)).availability).toEqual({ returns: 'none', ended_on: null, cancel: true });
  });

  test('持ち主以外とNULLと隠す状態の誤りも変わらない', async () => {
    const owner = await createDeliveryActor(db());
    const other = await createDeliveryActor(db());
    const visible = await createOrderStatusFixture(db(), { customerId: owner.id });
    const hiddenIds: string[] = [];
    for (const status of ['payment_in_progress', 'abandoned'] as const) {
      hiddenIds.push((await createOrderStatusFixture(db(), { customerId: owner.id, status })).orderId);
    }
    const args = [[visible.orderId, other.id], [null, owner.id], [visible.orderId, null],
      ...hiddenIds.map((id) => [id, owner.id])];
    const refusals = [];
    for (const params of args) {
      const before = await orderStatusSqlError(db(), 'select pg_temp.customer_returns_before($1,$2)', params);
      const after = await orderStatusSqlError(db(), 'select public.get_customer_order_returns($1,$2)', params);
      expect(after).toEqual(before);
      refusals.push({ code: after.code, message: after.symbol });
    }
    expect(refusals).toEqual(Array(5).fill({ code: 'P0002', message: 'ORDER_NOT_FOUND' }));
    const missingArgs = [randomUUID(), owner.id];
    expect(await orderStatusSqlError(db(), 'select public.get_customer_order_returns($1,$2)', missingArgs))
      .toEqual(await orderStatusSqlError(db(), 'select pg_temp.customer_returns_before($1,$2)', missingArgs));
  });

  test('注文番号で読むtrueは元の持ち主用と同じでゲストも読める', async () => {
    await setOrderStatusReturnSettings(db(), true);
    for (const scenario of SCENARIOS) {
      const order = await createOrderStatusReturnsFixture(db(), scenario);
      const before = await legacyReturns(db(), order);
      const byIdPrivate = await statusReturns(db(), order.orderId, true);
      expect(byIdPrivate).toEqual(before);
      const guest = await createOrderStatusReturnsFixture(db(), scenario, { guest: true });
      expect((await db().query('select user_id from public.orders where id=$1', [guest.orderId])).rows[0].user_id).toBeNull();
      const guestPrivate = await statusReturns(db(), guest.orderId, true);
      expect(guestPrivate).not.toBeNull();
      expect(guestPrivate!.returns).toHaveLength(scenario === 'cancelled' ? 0 : 1);
      expect(await statusReturns(db(), guest.orderId, false)).toEqual(publicProjection(guestPrivate!));
    }
    const cancelled = await createOrderStatusFixture(db(), { status: 'cancelled' });
    expect(await statusReturns(db(), cancelled.orderId, true)).not.toBeNull();
    const hiddenIds: string[] = [];
    for (const status of ['payment_in_progress', 'abandoned'] as const) {
      hiddenIds.push((await createOrderStatusFixture(db(), { status })).orderId);
    }
    for (const orderId of [null, randomUUID(), ...hiddenIds]) {
      for (const includePrivate of [undefined, false, true]) expect(await statusReturns(db(), orderId, includePrivate)).toBeNull();
    }
    expect(await orderStatusSqlError(db(), 'select public.get_order_status_returns($1,$2)', [cancelled.orderId, null]))
      .toEqual({ code: '22023', symbol: 'ORDER_STATUS_ARGUMENT_INVALID' });
  });

  test('注文番号で読むfalseと省略は返送先と送り返し番号を取得しない', async () => {
    const orders = [];
    for (const scenario of SCENARIOS) orders.push(await createOrderStatusReturnsFixture(db(), scenario));
    for (const hasAddress of [false, true]) {
      await setOrderStatusReturnSettings(db(), hasAddress);
      for (const order of orders) {
        const before = await legacyReturns(db(), order);
        const publicWithFalse = await statusReturns(db(), order.orderId, false);
        const publicWithDefault = await statusReturns(db(), order.orderId);
        expect(publicWithFalse).toEqual(publicWithDefault);
        expect(publicWithFalse).toEqual(publicProjection(before));
        const forbiddenKeys = keysDeep(publicWithFalse).filter((key) => PRIVATE_KEYS.includes(key));
        expect(forbiddenKeys).toEqual([]);
        expect(JSON.stringify(publicWithFalse).includes(ORDER_STATUS_PRIVATE_SENTINEL)).toBe(false);
      }
    }
  });

  test('取り消した返品と内部の情報を混ぜず既存の並びとnullを保つ', async () => {
    const order = await createOrderStatusReturnsFixture(db(), 'requested');
    await db().query(
      `update public.order_returns set status='open',approved_at=pg_catalog.now(),approved_by=$2,shop_note=$3 where id=$1`,
      [order.returnId, order.customerId, ORDER_STATUS_INTERNAL_SENTINEL],
    );
    const line = { fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1 };
    await insertReturnRecord(db(), { orderId: order.orderId, status: 'requested', lines: [line] });
    const declined = await insertReturnRecord(db(), { orderId: order.orderId, status: 'declined', lines: [line] });
    await db().query('update public.order_returns set decline_message=$2 where id=$1', [declined.returnId, '返品のお断りのご案内']);
    const cancelled = await insertReturnRecord(db(), { orderId: order.orderId, status: 'cancelled', lines: [line] });
    const times = (await db().query(
      `select (pg_catalog.now()-interval '2 minutes')::text as oldest,
              (pg_catalog.now()-interval '1 minute')::text as middle,pg_catalog.now()::text as newest`,
    )).rows[0];
    const cancelIds: string[] = [];
    for (const [status, requestedAt] of [['closed', times.oldest], ['declined', times.newest],
      ['requested', times.middle], ['resolved', times.newest]] as const) {
      const request = await insertCancelRequest(db(), { orderId: order.orderId, status, requestedAt,
        customerId: order.customerId!, customerNote: ORDER_STATUS_INTERNAL_SENTINEL,
        lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] });
      cancelIds.push(request.cancelRequestId);
    }
    const expectedNewestFirstIds = [...[cancelIds[1], cancelIds[3]].sort().reverse(), cancelIds[2], cancelIds[0]];
    const before = await compareOwnerReturns(db(), order);
    for (const includePrivate of [false, true]) {
      const result = (await statusReturns(db(), order.orderId, includePrivate))!;
      expect(result).toEqual(includePrivate ? before : publicProjection(before));
      const returnNumbers = result.returns.map((entry: Row) => entry.number);
      expect(returnNumbers).toEqual([3, 2, 1]);
      expect(result.returns.some((entry: Row) => entry.id === cancelled.returnId)).toBe(false);
      const cancelRequestIds = result.cancel_requests.map((entry: Row) => entry.id);
      expect(cancelRequestIds).toEqual(expectedNewestFirstIds);
      expect(result.cancel_requests.map((entry: Row) => entry.status).sort()).toEqual(['closed', 'declined', 'requested', 'resolved']);
      expect(result.cancel_requests.find((entry: Row) => entry.status === 'declined').decline_message).toBe('お断りの文');
      expect(result.cancel_requests.filter((entry: Row) => entry.status !== 'declined').every((entry: Row) => entry.decline_message === null)).toBe(true);
      const internalKeys = keysDeep(result).filter((key) => INTERNAL_KEYS.includes(key));
      expect(internalKeys).toEqual([]);
      expect(JSON.stringify(result).includes(ORDER_STATUS_INTERNAL_SENTINEL)).toBe(false);
      expect(result.returns[0].decline_message).toBe('返品のお断りのご案内');
      expect(result.returns[1]).toMatchObject({ requested_at: expect.any(String), closed_at: null, refund_amount: null,
        sent_back: [], decline_message: null, exchange_shipping: 'none' });
      expect(result.returns[1].lines[0]).toMatchObject({ requested_resolution: null, requested_exchange: null, exchange: null });
      if (includePrivate) expect(result.returns.every((entry: Row) => entry.return_address === null)).toBe(true);
    }
    const empty = { ...await createOrderStatusFixture(db(), { customerId: order.customerId }), customerId: order.customerId };
    const emptyBefore = await compareOwnerReturns(db(), empty);
    expect(emptyBefore).toEqual({ returns: [], cancel_requests: [], availability: { returns: 'none', ended_on: null, cancel: true } });
    expect(await statusReturns(db(), empty.orderId)).toEqual(emptyBefore);
  });

  test('新RPCもservice_role以外は呼べず芯は直接呼べない', async () => {
    const order = await createOrderStatusReturnsFixture(db());
    const signatures = [
      'public.get_customer_order_returns(uuid,uuid)', 'public.get_order_status_returns(uuid,boolean)',
      'private.build_customer_order_returns(public.orders,boolean)',
    ];
    for (const signature of signatures) {
      const core = signature.startsWith('private.');
      const row = (await db().query(
        `select p.prosecdef,p.provolatile,p.proconfig,l.lanname,pg_catalog.pg_get_userbyid(p.proowner) as owner,
                p.proargnames,p.pronargdefaults,pg_catalog.pg_get_expr(p.proargdefaults,0) as defaults,
                exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner)))
                       where grantee=0 and privilege_type='EXECUTE') as public_execute
         from pg_catalog.pg_proc as p join pg_catalog.pg_language as l on l.oid=p.prolang where p.oid=$1::regprocedure`,
        [signature],
      )).rows[0];
      expect(row).toEqual({ prosecdef: !core, provolatile: 's', proconfig: expect.arrayContaining(['search_path=""']),
        lanname: 'plpgsql', owner: 'postgres', public_execute: false,
        proargnames: core ? ['_order', '_include_private'] : signature.includes('get_order_status_returns')
          ? ['_order_id', '_include_private'] : ['_order_id', '_customer_id'],
        pronargdefaults: signature.includes('get_order_status_returns') ? 1 : 0,
        defaults: signature.includes('get_order_status_returns') ? 'false' : null });
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const allowed = (await db().query("select pg_catalog.has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0].allowed;
        expect(allowed).toBe(role === 'service_role' && !core);
      }
    }
    const counts = (await db().query(
      `select n.nspname,p.proname,count(*)::integer as count from pg_catalog.pg_proc as p
       join pg_catalog.pg_namespace as n on n.oid=p.pronamespace
       where (n.nspname='public' and p.proname in ('get_customer_order_returns','get_order_status_returns'))
          or (n.nspname='private' and p.proname='build_customer_order_returns')
       group by n.nspname,p.proname`,
    )).rows;
    expect(counts).toHaveLength(3);
    expect(counts.every((row) => row.count === 1)).toBe(true);
    const before = await legacyReturns(db(), order);
    await asOrderStatusRole(db(), 'service_role', async () => {
      expect((await db().query('select public.get_customer_order_returns($1,$2) as value', [order.orderId, order.customerId])).rows[0].value).toEqual(before);
      expect(await statusReturns(db(), order.orderId, true)).toEqual(before);
      expect(await statusReturns(db(), order.orderId, false)).toEqual(publicProjection(before));
      expect(await statusReturns(db(), order.orderId)).toEqual(publicProjection(before));
    });
    const deniedCodes: Array<string | undefined> = [];
    for (const role of ['anon', 'authenticated'] as const) {
      await asOrderStatusRole(db(), role, async () => {
        for (const [sql, params] of [
          ['select public.get_customer_order_returns($1,$2)', [order.orderId, order.customerId]],
          ['select public.get_order_status_returns($1)', [order.orderId]],
          ['select public.get_order_status_returns($1,$2)', [order.orderId, false]],
          ['select public.get_order_status_returns($1,$2)', [order.orderId, true]],
        ] as Array<[string, unknown[]]>) deniedCodes.push((await orderStatusSqlError(db(), sql, params)).code);
      });
    }
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      await asOrderStatusRole(db(), role, async () => {
        for (const includePrivate of [false, true]) {
          deniedCodes.push((await orderStatusSqlError(db(),
            'select private.build_customer_order_returns(null::public.orders,$1)', [includePrivate])).code);
        }
      });
    }
    expect(deniedCodes).toHaveLength(14);
    expect(deniedCodes.every(code => code === '42501')).toBe(true);
  });
});
