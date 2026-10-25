/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connectLocalDb, describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { withGroupG1FixtureTransaction, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { seedGroupG3ReadyOrder, seedGroupG3Slip } from './helpers/group-g3-fixtures';

const apiUrl = process.env.LOCAL_SUPABASE_URL;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
jest.setTimeout(60000);

describeLocalDb('G-3 real supabase-js -> PostgREST -> SQL read paths', (db) => {
  if (!apiUrl || !serviceKey || !anonKey) {
    test.skip('FREQ-531-AC-04: LOCAL_SUPABASE_URL / LOCAL_SUPABASE_SERVICE_ROLE_KEY / LOCAL_SUPABASE_ANON_KEYのいずれかが未設定', () => {});
    return;
  }
  if (!isLocalDatabase(apiUrl)) {
    test('FREQ-531-AC-04: localhost以外のAPIには接続しない', () => { throw new Error('G3_POSTGREST_LOCAL_API_REQUIRED'); });
    return;
  }
  const service = createClient(apiUrl, serviceKey, options);
  const anon = createClient(apiUrl, anonKey, options);
  let authenticated: SupabaseClient;
  let authUserId: string | undefined;
  let actor: string; let orderId: string; let itemId: string; let slipId: string;
  const calls = (): Array<[string, Record<string, unknown>]> => [
    ['list_admin_packing', { _slip_id: slipId, _limit: 100, _offset: 0, _actor_id: actor }],
    ['list_admin_shipment_slips', { _stage: null, _limit: 100, _offset: 0, _actor_id: actor }],
    ['get_admin_shipment_slip', { _slip_id: slipId, _actor_id: actor }],
    ['list_admin_order_shipment_slips', { _order_id: orderId, _actor_id: actor }],
    ['list_shipment_accounting_inputs', { _from: '2026-10-01', _to: '2026-10-31', _limit: 100 }],
  ];
  beforeAll(async () => {
    const email = `g3-rpc-${randomUUID()}@example.invalid`;
    const password = `G3-${randomUUID()}-aA1!`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error('G3_AUTH_FIXTURE_CREATE_FAILED');
    authUserId = created.data.user.id;
    actor = authUserId;
    authenticated = createClient(apiUrl, anonKey, options);
    const signedIn = await authenticated.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw new Error('G3_AUTH_FIXTURE_SIGN_IN_FAILED');
    await withGroupG1FixtureTransaction(db(), async () => {
      // Reuse the actual authenticated user as the permitted actor; no second auth user is needed.
      await db().query(`insert into public.user_roles(user_id,role_id,active)
        select $1,id,true from public.roles where code='supporter'`, [actor]);
      const f = await seedGroupG3ReadyOrder(db()); orderId = f.orderId; itemId = f.orderItemId;
      slipId = await seedGroupG3Slip(db(), { actorId: actor, expired: true,
        draftLines: [{ orderItemId: itemId, quantity: 2 }] });
    }); // Commit is required: PostgREST reads from a separate connection.
  });
  afterAll(async () => {
    try {
      // describeLocalDb's own afterAll (registered first) already closed db(); use a client this hook owns.
      if (orderId) {
        const cleanup = await connectLocalDb();
        try {
          await withGroupG1FixtureTransaction(cleanup, () => setOrderStatusForFixture(cleanup, [orderId], 'cancelled'));
        } finally {
          await cleanup.end();
        }
      }
    } finally {
      if (authenticated) await authenticated.auth.signOut();
      if (authUserId) {
        const deleted = await service.auth.admin.deleteUser(authUserId);
        if (deleted.error) throw new Error('G3_AUTH_FIXTURE_CLEANUP_FAILED');
      }
    }
  });

  test('FREQ-531-AC-01: 5本の公開入口はservice_roleで実行でき、packingの数・camelCase詳細を返す', async () => {
    for (const [name, args] of calls()) {
      const result = await service.rpc(name, args);
      expect({ name, ok: result.error === null, status: result.status }).toEqual({ name, ok: true, status: 200 });
      if (name === 'list_admin_packing') {
        let row = result.data.find((r: { order_item_id: string }) => r.order_item_id === itemId);
        const total = Number(result.data[0]?.total_count ?? 0);
        for (let offset = 100; !row && offset < total; offset += 100) {
          const page = await service.rpc(name, { ...args, _offset: offset });
          expect(page.error === null).toBe(true);
          row = page.data?.find((r: { order_item_id: string }) => r.order_item_id === itemId);
        }
        expect(row).toMatchObject({ ready_quantity: 4, shippable_quantity: 4, selected_quantity: 2, bundle_ok: true });
      }
      if (name === 'get_admin_shipment_slip') expect(result.data).toMatchObject({ id: slipId, expired: true,
        lines: [expect.objectContaining({ orderItemId: itemId, quantity: 2, readyQuantity: 4 })] });
    }
  });
  test('FREQ-531-AC-04: 権限なしactorは実PostgREST越しでもGROUP_G_FORBIDDEN / 42501', async () => {
    for (const [name, args] of calls().slice(0, 4)) {
      const r = await service.rpc(name, { ...args, _actor_id: randomUUID() });
      expect({ name, code: r.error?.code, forbidden: r.error?.message === 'GROUP_G_FORBIDDEN', status: r.status })
        .toEqual({ name, code: '42501', forbidden: true, status: 403 });
    }
  });
  test('FREQ-540-AC-10: anon・実authenticated JWTはactor権限があっても5本すべてのEXECUTEを拒む', async () => {
    for (const client of [anon, authenticated]) for (const [name, args] of calls()) {
      const r = await client.rpc(name, args);
      expect({ name, code: r.error?.code, denied: [401, 403].includes(r.status) })
        .toEqual({ name, code: '42501', denied: true });
    }
  });
});
