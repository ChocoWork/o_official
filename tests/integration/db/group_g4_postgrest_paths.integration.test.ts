/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connectLocalDb, describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { withGroupG1FixtureTransaction, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { seedGroupG3ReadyOrder } from './helpers/group-g3-fixtures';
import { AdminOrderError, listAdminOrderItemRows, exportAdminOrderItemRows, getAdminOrderDetailCore, listAdminOrderItemStateHistory } from '@/lib/orders/admin-orders/admin-order-store';
import { ADMIN_ORDER_ERRORS } from '@/lib/orders/admin-orders/admin-order-types';

const apiUrl = process.env.LOCAL_SUPABASE_URL;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
jest.setTimeout(60000);

// 未設定ならDB接続のフックも登録しない。キーもURLもエラーの詳細も表示しない。
if (!apiUrl || !serviceKey || !anonKey) {
  test.skip('FREQ-540-AC-13: LOCAL_SUPABASE_URL / LOCAL_SUPABASE_SERVICE_ROLE_KEY / LOCAL_SUPABASE_ANON_KEY未設定', () => {});
} else if (!isLocalDatabase(apiUrl)) {
  test('FREQ-540-AC-13: localhost以外のAPIには接続しない', () => { throw new Error('G4_POSTGREST_LOCAL_API_REQUIRED'); });
} else {
  describeLocalDb('G-4 real store -> supabase-js -> PostgREST -> SQL', (db) => {
    const service = createClient(apiUrl, serviceKey, options);
    const anon = createClient(apiUrl, anonKey, options);
    let authenticated: SupabaseClient | undefined;
    let actor: string | undefined; let orderId: string | undefined;
    const email = `g4-rpc-${randomUUID()}@example.invalid`;
    const calls = (actorId: string, id: string): Array<[string, Record<string, unknown>]> => [
      ['list_admin_order_item_rows', { _filters: { email }, _limit: 20, _offset: 0, _actor_id: actorId }],
      ['export_admin_order_item_rows', { _filters: { email }, _actor_id: actorId }],
      ['get_admin_order_detail', { _order_id: id, _actor_id: actorId }],
      ['list_admin_order_item_state_history', { _order_id: id, _actor_id: actorId }],
    ];
    const ids = (): [string, string] => {
      if (!actor || !orderId) throw new Error('G4_POSTGREST_FIXTURE_REQUIRED');
      return [actor, orderId];
    };
    beforeAll(async () => {
      const password = `G4-${randomUUID()}-aA1!`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) throw new Error('G4_AUTH_FIXTURE_CREATE_FAILED');
      actor = created.data.user.id;
      authenticated = createClient(apiUrl, anonKey, options);
      const signedIn = await authenticated.auth.signInWithPassword({ email, password });
      if (signedIn.error || !signedIn.data.session) throw new Error('G4_AUTH_FIXTURE_SIGN_IN_FAILED');
      await withGroupG1FixtureTransaction(db(), async () => {
        await db().query(`insert into public.user_roles(user_id,role_id,active) select $1,id,true from public.roles where code='supporter'`, [actor]);
        const order = await seedGroupG3ReadyOrder(db(), { email, quantity: 2 }); orderId = order.orderId;
      }); // 別接続のPostgRESTで読むためcommitが必要。controllerの使い捨てDBだけで実行。
    });
    afterAll(async () => {
      try {
        if (orderId) {
          const cleanup = await connectLocalDb();
          try { await withGroupG1FixtureTransaction(cleanup, () => setOrderStatusForFixture(cleanup, [ids()[1]], 'cancelled')); } finally { await cleanup.end(); }
        }
      } finally {
        if (authenticated) await authenticated.auth.signOut();
        if (actor) { const deleted = await service.auth.admin.deleteUser(actor); if (deleted.error) throw new Error('G4_AUTH_FIXTURE_CLEANUP_FAILED'); }
      }
    });
    test('FREQ-540-AC-13: service_roleの実storeで4本の入口とcamelCase検査を通る', async () => {
      const [actorId, id] = ids();
      const page = await listAdminOrderItemRows(service, actorId, { email }, 1);
      expect(page.totalOrders).toBe(1); expect(page.totalRows).toBe(1); expect(page.rows[0]).toMatchObject({ orderId: id, quantity: 2, status: 'ready' });
      const exported = await exportAdminOrderItemRows(service, actorId, { email });
      expect(exported.rowCount).toBe(exported.rows.length); expect(exported.rowCount).toBe(1); expect(exported.orderCount).toBe(1); expect(exported.rows[0].orderId).toBe(id);
      const detail = await getAdminOrderDetailCore(service, actorId, id);
      expect(detail.order.id).toBe(id); expect(detail.permissions.read).toBe(true); expect(detail.rows[0]).toMatchObject({ status: 'ready', quantity: 2 });
      const history = await listAdminOrderItemStateHistory(service, actorId, id);
      expect(Array.isArray(history.entries)).toBe(true); expect(history.truncated).toBe(false);
    });
    test.each(['anon', 'authenticated'] as const)('FREQ-540-AC-13: %sは4本とも実行不可', async (role) => {
      const client = role === 'anon' ? anon : authenticated;
      if (!client) throw new Error('G4_AUTH_FIXTURE_REQUIRED');
      for (const [name, args] of calls(...ids())) {
        const result = await client.rpc(name, args);
        expect({ name, status: result.status, code: result.error?.code }).toEqual({ name, status: role === 'anon' ? 401 : 403, code: '42501' });
      }
    });
    test('FREQ-540-AC-13: storeは権限不足・注文不在・引数不正を完全一致で分類する', async () => {
      const [actorId, id] = ids(); const missing = randomUUID();
      const failures: Array<[string, () => Promise<unknown>]> = [
        ['GROUP_G_FORBIDDEN', () => listAdminOrderItemRows(service, missing, { email }, 1)],
        ['GROUP_G_FORBIDDEN', () => exportAdminOrderItemRows(service, missing, { email })],
        ['GROUP_G_FORBIDDEN', () => getAdminOrderDetailCore(service, missing, id)],
        ['GROUP_G_FORBIDDEN', () => listAdminOrderItemStateHistory(service, missing, id)],
        ['GROUP_G_ORDER_NOT_FOUND', () => getAdminOrderDetailCore(service, actorId, missing)],
        ['GROUP_G_ORDER_NOT_FOUND', () => listAdminOrderItemStateHistory(service, actorId, missing)],
        ['GROUP_G_ARGUMENT_INVALID', () => listAdminOrderItemRows(service, actorId, { dateFrom: 'invalid' }, 1)],
        ['GROUP_G_ARGUMENT_INVALID', () => exportAdminOrderItemRows(service, actorId, { dateFrom: 'invalid' })],
      ];
      for (const [code, call] of failures) {
        const failure = await call().then(() => null, (error: unknown) => error);
        expect(failure instanceof AdminOrderError).toBe(true);
        const [, status, message] = ADMIN_ORDER_ERRORS[code]; expect(failure).toMatchObject({ code, status, message }); expect(failure).not.toHaveProperty('cause');
      }
    });
    test('FREQ-536-AC-03: 一覧はlimit=101を拒否し、exportは単一jsonbの全行件数と一致', async () => {
      const [actorId] = ids();
      const rejected = await service.rpc('list_admin_order_item_rows', { _filters: { email }, _limit: 101, _offset: 0, _actor_id: actorId });
      expect({ message: rejected.error?.message, code: rejected.error?.code }).toEqual({ message: 'GROUP_G_ARGUMENT_INVALID', code: '22023' });
      const exported = await service.rpc('export_admin_order_item_rows', { _filters: { email }, _actor_id: actorId });
      expect(exported.error === null).toBe(true); expect(Array.isArray(exported.data)).toBe(false);
      expect(exported.data.rowCount).toBe(exported.data.rows.length); expect(exported.data.rowCount).toBe(1);
    });
  });
}
