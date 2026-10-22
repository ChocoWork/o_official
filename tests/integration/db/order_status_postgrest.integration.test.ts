/** @jest-environment node */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import {
  createOrderStatusFixture, orderStatusClock, readOrderStatusPause, restoreCommittedOrderStatusState,
  setOrderStatusLinkState, type OrderStatusPause,
} from './helpers/order-status-fixtures';

/** SQL 準備と HTTP は別の取引。--runInBand で使い、リンク・メール・pause は毎回片づける。 */
jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const LOCAL_ANON_KEY = process.env.LOCAL_SUPABASE_ANON_KEY;
const CLIENT_OPTIONS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

describeLocalDb('integration: 注文状況の新RPCを実際のPostgRESTに通す', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルのAPI以外では実行しない', () => {
      throw new Error('ORDER_STATUS_LOCAL_API_REQUIRED');
    });
    return;
  }
  const apiUrl = LOCAL_API_URL;
  const client = createClient(apiUrl, LOCAL_SERVICE_ROLE_KEY, CLIENT_OPTIONS);
  let orderIds: string[];
  let pause: OrderStatusPause | undefined;

  beforeEach(async () => {
    orderIds = [];
    pause = undefined;
    pause = await readOrderStatusPause(db());
  });
  afterEach(async () => {
    await db().query('rollback');
    if (pause) await restoreCommittedOrderStatusState(db(), orderIds, pause);
  });

  async function fixture(input: Parameters<typeof createOrderStatusFixture>[1] = {}) {
    const order = await createOrderStatusFixture(db(), input);
    orderIds.push(order.orderId);
    return order;
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await client.rpc(name, args);
    // 接続情報・トークン・電話・DBのDETAILを失敗表示に含めない。
    if (result.error) throw new Error(`ORDER_STATUS_RPC_FAILED:${name}:${result.error.code ?? 'unknown'}`);
    return result.data;
  }

  test('service_roleで4つの新RPCの引数と返り方を確かめる', async () => {
    const order = await fixture();
    const token: unknown = await rpc('ensure_order_status_link', { _order_id: order.orderId });
    expect(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect((await rpc('ensure_order_status_link', { _order_id: order.orderId })) === token).toBe(true);
    const initial = await rpc('get_order_status_link', { _token: token });
    expect(Array.isArray(initial) && initial.length === 1).toBe(true);
    expect(Object.keys(initial[0]).sort()).toEqual(['order_id', 'customer_id', 'verify_until', 'failed_attempts', 'phone_available'].sort());
    expect(initial).toEqual([{ order_id: order.orderId, customer_id: null, verify_until: null, failed_attempts: 0, phone_available: true }]);
    const clock = await orderStatusClock(db());
    await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: clock.future, failedAttempts: 2 });
    const verified = await rpc('verify_order_status_phone', { _token: token, _last_four: '5678' });
    expect(Array.isArray(verified) && verified.length === 1).toBe(true);
    expect(Object.keys(verified[0]).sort()).toEqual(['result', 'verify_until', 'failed_attempts'].sort());
    expect(verified).toEqual([{ result: 'ok', verify_until: expect.any(String), failed_attempts: 2 }]);
    const after = await rpc('get_order_status_link', { _token: token });
    expect(verified[0].verify_until === after[0].verify_until).toBe(true);
    expect(verified[0].failed_attempts).toBe(2);
    const material = await rpc('get_order_status_public_material', { _order_id: order.orderId });
    expect(Object.keys(material).sort()).toEqual(['order', 'line_rows', 'fulfillments', 'delivery_detail', 'delivery_summary', 'refund_rows'].sort());
    expect(material.order.id).toBe(order.orderId);
    expect(material.order.order_items).toHaveLength(1);
    expect(material.line_rows).toHaveLength(1);
    expect(material.fulfillments).toEqual([]);
    expect(material.delivery_detail).toEqual({ enabled: expect.any(Boolean), fulfillments: [] });
    expect(material.delivery_summary).toEqual({ active_count: 0, delivered_count: 0 });
    expect(material.refund_rows).toEqual([]);
    const serialized = JSON.stringify(material);
    expect(/shipping_phone|shipping_email|shipping_full_name|payment_method|tracking_number|return_address|ORDER-STATUS-PRIVATE-SENTINEL/.test(serialized)).toBe(false);
  });

  test('PostgRESTでも0行とSQL NULLとcancelledの可視を保つ', async () => {
    for (const token of ['bad-token', 'Z'.repeat(43)]) {
      expect(await rpc('get_order_status_link', { _token: token })).toEqual([]);
      expect(await rpc('verify_order_status_phone', { _token: token, _last_four: '5678' })).toEqual([]);
    }
    for (const orderId of [null, randomUUID()]) {
      expect(await rpc('get_order_status_public_material', { _order_id: orderId })).toBeNull();
    }
    for (const status of ['payment_in_progress', 'abandoned'] as const) {
      const order = await fixture({ status });
      const token = await rpc('ensure_order_status_link', { _order_id: order.orderId });
      expect(await rpc('get_order_status_link', { _token: token })).toEqual([]);
      expect(await rpc('verify_order_status_phone', { _token: token, _last_four: '5678' })).toEqual([]);
      expect(await rpc('get_order_status_public_material', { _order_id: order.orderId })).toBeNull();
    }
    const cancelled = await fixture({ status: 'cancelled' });
    const token = await rpc('ensure_order_status_link', { _order_id: cancelled.orderId });
    const clock = await orderStatusClock(db());
    await setOrderStatusLinkState(db(), { orderId: cancelled.orderId, verifyUntil: clock.future, failedAttempts: 0 });
    expect(await rpc('get_order_status_link', { _token: token })).toHaveLength(1);
    expect(await rpc('verify_order_status_phone', { _token: token, _last_four: '5678' })).toEqual([
      { result: 'ok', verify_until: expect.any(String), failed_attempts: 0 },
    ]);
    expect((await rpc('get_order_status_public_material', { _order_id: cancelled.orderId })).order.status).toBe('cancelled');
  });

  test('PostgRESTの拒否は固定のSQLSTATEと記号で返す', async () => {
    const order = await fixture();
    const token = await rpc('ensure_order_status_link', { _order_id: order.orderId });
    for (const [args, code, symbol] of [
      [{ _order_id: null }, '22023', 'ORDER_STATUS_ARGUMENT_INVALID'],
      [{ _order_id: randomUUID() }, 'P0002', 'ORDER_NOT_FOUND'],
    ] as const) {
      const result = await client.rpc('ensure_order_status_link', args);
      expect(result.error?.code).toBe(code);
      expect(result.error?.message === symbol).toBe(true);
    }
    for (const value of [null, '', '123', '12345', '５６７８', 'abcd']) {
      const result = await client.rpc('verify_order_status_phone', { _token: token, _last_four: value });
      expect(result.error?.code).toBe('22023');
    }
    const state = await rpc('get_order_status_link', { _token: token });
    expect(state[0].failed_attempts).toBe(0);
  });

  const testClientRoles = LOCAL_ANON_KEY ? test : test.skip;
  testClientRoles('anonとauthenticatedはRPCのEXECUTEと表の直接操作を拒む', async () => {
    if (!LOCAL_ANON_KEY) throw new Error('ORDER_STATUS_LOCAL_ANON_KEY_REQUIRED');
    const anon = createClient(apiUrl, LOCAL_ANON_KEY, CLIENT_OPTIONS);
    const authenticated = createClient(apiUrl, LOCAL_ANON_KEY, CLIENT_OPTIONS);
    const email = `order-status-auth-${randomUUID()}@example.invalid`;
    const password = `OrderStatus-${randomUUID()}-aA1!`;
    let userId: string | undefined;
    try {
      const created = await client.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) throw new Error('ORDER_STATUS_AUTH_FIXTURE_CREATE_FAILED');
      userId = created.data.user.id;
      const signedIn = await authenticated.auth.signInWithPassword({ email, password });
      if (signedIn.error || !signedIn.data.session) throw new Error('ORDER_STATUS_AUTH_FIXTURE_SIGN_IN_FAILED');
      const order = await fixture();
      const token = await rpc('ensure_order_status_link', { _order_id: order.orderId });
      // 欠落したRPCを拒否成功と取り違えないよう、同じ引数でservice_roleの成功を先に確かめる。
      const calls: Array<[string, Record<string, unknown>]> = [
        ['ensure_order_status_link', { _order_id: order.orderId }],
        ['get_order_status_link', { _token: token }],
        ['verify_order_status_phone', { _token: token, _last_four: '5678' }],
        ['get_order_status_public_material', { _order_id: order.orderId }],
        ['complete_order_email', { _email_id: randomUUID(), _lease_token: randomUUID(), _provider_message_id: null }],
      ];
      for (const [name, args] of calls) await rpc(name, args);
      const clients: SupabaseClient[] = [anon, authenticated];
      for (const deniedClient of clients) {
        for (const [name, args] of calls) {
          const result = await deniedClient.rpc(name, args);
          expect(result.error?.code).toBe('42501');
          expect([401, 403].includes(result.status)).toBe(true);
        }
        // privateがAPI未公開ならPGRST106、公開済みでもDB権限の42501で拒む。
        const table = deniedClient.schema('private').from('order_status_links');
        const attempts = [
          () => table.select('order_id'),
          () => table.insert({ order_id: order.orderId, token: 'A'.repeat(43) }),
          () => table.update({ failed_attempts: 1 }).eq('order_id', order.orderId),
          () => table.delete().eq('order_id', order.orderId),
        ];
        for (const attempt of attempts) {
          const result = await attempt();
          expect(['42501', 'PGRST106'].includes(result.error?.code ?? '')).toBe(true);
          expect([401, 403, 406].includes(result.status)).toBe(true);
        }
      }
    } finally {
      if (userId) {
        const removed = await client.auth.admin.deleteUser(userId);
        if (removed.error) throw new Error('ORDER_STATUS_AUTH_FIXTURE_DELETE_FAILED');
      }
    }
  });
});
