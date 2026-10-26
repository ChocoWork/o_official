/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connectLocalDb, describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { withGroupG1FixtureTransaction, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { seedGroupG3ReadyOrder } from './helpers/group-g3-fixtures';
import { AdminOrderError, listAdminOrderItemRows, exportAdminOrderItemRows, getAdminOrderDetailCore, listAdminOrderItemStateHistory } from '@/lib/orders/admin-orders/admin-order-store';
import { ADMIN_ORDER_ERRORS } from '@/lib/orders/admin-orders/admin-order-types';
import { AllocationSwapError, swapOrderAllocations, listAllocationSwapCandidates } from '@/lib/inventory/allocation-swap-store';
import { ALLOCATION_SWAP_ERRORS, type AllocationSwapInput } from '@/lib/inventory/allocation-swap-types';
import { seedGroupG4SwapPair } from './helpers/group-g4-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';

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
    let actor: string | undefined; let orderId: string | undefined; let swapActor: string | undefined;
    const swapOrders: string[] = [];
    type Pair = Awaited<ReturnType<typeof seedGroupG4SwapPair>>;
    let aclPair: Pair | undefined;
    const email = `g4-rpc-${randomUUID()}@example.invalid`;
    const calls = (actorId: string, id: string): Array<[string, Record<string, unknown>]> => {
      if (!aclPair || !swapActor) throw new Error('G4_SWAP_ACL_FIXTURE_REQUIRED');
      return [
      ['list_admin_order_item_rows', { _filters: { email }, _limit: 20, _offset: 0, _actor_id: actorId }],
      ['export_admin_order_item_rows', { _filters: { email }, _actor_id: actorId }],
      ['get_admin_order_detail', { _order_id: id, _actor_id: actorId }],
      ['list_admin_order_item_state_history', { _order_id: id, _actor_id: actorId }],
      // 業務上は成功するactor・注文・明細を使い、EXECUTEの拒否だけを検出する。
      ['admin_swap_order_allocations', { _order_id: aclPair.taker.orderId, _taker_order_item_id: aclPair.taker.orderItemId, _donor_order_item_id: aclPair.donor.orderItemId, _quantity: 1, _reason: 'fixture swap', _actor_id: swapActor, _request_key: randomUUID() }],
      ['list_admin_allocation_swap_candidates', { _order_id: aclPair.taker.orderId, _taker_order_item_id: aclPair.taker.orderItemId, _actor_id: swapActor }],
      ];
    };
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
        swapActor = await createPurchaseFlow(db).manager();
        aclPair = await seedGroupG4SwapPair(db());
        swapOrders.push(aclPair.donor.orderId, aclPair.taker.orderId);
      }); // 別接続のPostgRESTで読むためcommitが必要。controllerの使い捨てDBだけで実行。
    });
    afterAll(async () => {
      try {
        if (orderId || swapActor) {
          const cleanup = await connectLocalDb();
          try {
            if (swapActor) {
              // G-3のmanagerと同様、確定した履歴が参照するactorは残す。権限とセッションは先に外す。
              try {
                await withGroupG1FixtureTransaction(cleanup, async () => {
                  await cleanup.query('delete from public.user_roles where user_id=$1', [swapActor]);
                  await cleanup.query('delete from auth.sessions where user_id=$1', [swapActor]);
                  await cleanup.query('delete from public.sessions where user_id=$1', [swapActor]);
                });
              } catch { throw new Error('G4_AUTH_FIXTURE_REVOCATION_FAILED'); }
            }
            if (orderId) await withGroupG1FixtureTransaction(cleanup, () => setOrderStatusForFixture(cleanup, [ids()[1], ...swapOrders], 'cancelled'));
          } finally { await cleanup.end(); }
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
    test.each(['anon', 'authenticated'] as const)('FREQ-540-AC-13: %sは入替と候補を含む6本とも実行不可', async (role) => {
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

    const manager = (): string => { if (!swapActor) throw new Error('G4_SWAP_ACTOR_REQUIRED'); return swapActor; };
    async function pair(input: Parameters<typeof seedGroupG4SwapPair>[1] = {}): Promise<Pair> {
      return withGroupG1FixtureTransaction(db(), async () => {
        const material = await seedGroupG4SwapPair(db(), input);
        swapOrders.push(material.donor.orderId, material.taker.orderId);
        return material;
      });
    }
    const swapInput = (f: Pair): AllocationSwapInput => ({ takerOrderItemId: f.taker.orderItemId, donorOrderItemId: f.donor.orderItemId, quantity: 2, reason: 'fixture swap', requestKey: randomUUID() });
    async function classified(code: string, call: () => Promise<unknown>): Promise<void> {
      const failure: unknown = await call().then(() => null, (error: unknown) => error);
      const [, status, message] = ALLOCATION_SWAP_ERRORS[code];
      expect(failure).toBeInstanceOf(AllocationSwapError);
      expect(failure).toMatchObject({ code, status, message });
      expect(failure).not.toHaveProperty('cause');
    }
    test('FREQ-523-AC-04: 実storeの候補→入替→同じ要求の再送は同じoperationで1回分', async () => {
      const f = await pair(); const input = swapInput(f);
      const candidates = await listAllocationSwapCandidates(service, manager(), f.taker.orderId, f.taker.orderItemId);
      expect(candidates).toEqual([expect.objectContaining({ donorOrderId: f.donor.orderId, donorOrderItemId: f.donor.orderItemId, swappableQuantity: 3, takerQuantity: 2 })]);
      const saved = await swapOrderAllocations(service, manager(), f.taker.orderId, input);
      expect(saved).toMatchObject({ id: f.taker.orderId, takerOrderId: f.taker.orderId, donorOrderId: f.donor.orderId, quantity: 2, reason: input.reason, replayed: false });
      expect(await swapOrderAllocations(service, manager(), f.taker.orderId, input)).toEqual({ ...saved, replayed: true });
      expect(await listAllocationSwapCandidates(service, manager(), f.taker.orderId, f.taker.orderItemId)).toEqual([]);
      const count = await db().query('select count(*)::int n from public.order_item_allocation_events where operation_id=$1', [saved.operationId]);
      expect(count.rows[0].n).toBe(2);
      await classified('GROUP_G_REQUEST_KEY_CONFLICT', () => swapOrderAllocations(service, manager(), f.taker.orderId, { ...input, reason: 'different fixture reason' }));
    });
    test.each([
      [{ differentVariant: true }, 'GROUP_G_SWAP_VARIANT_MISMATCH'],
      [{ takerStatus: 'pending' }, 'GROUP_G_SWAP_ORDER_NOT_PAID'],
      [{ takerReview: true }, 'GROUP_G_SWAP_TAKER_ON_HOLD'],
      [{ takerFeeWaiting: true }, 'GROUP_G_SWAP_TAKER_ON_HOLD'],
      [{ donorCancelRequested: 1 }, 'GROUP_G_SWAP_DONOR_PENDING_REQUEST'],
      [{ donorRefundProcessing: 1 }, 'GROUP_G_SWAP_DONOR_PENDING_REQUEST'],
      [{ donorReview: true }, 'GROUP_G_SWAP_DONOR_ON_HOLD'],
      [{ takerQuantity: 1 }, 'GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER'],
      [{ donorQuantity: 1 }, 'GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR'],
    ] as const)('FREQ-523-AC-02: 実PostgRESTの状態%jを%sへ分類', async (options, code) => {
      const f = await pair(options);
      await classified(code, () => swapOrderAllocations(service, manager(), f.taker.orderId, swapInput(f)));
    });
    test.each(['GROUP_G_FORBIDDEN', 'GROUP_G_ARGUMENT_INVALID', 'GROUP_G_SWAP_REASON_REQUIRED', 'GROUP_G_SWAP_ITEM_NOT_FOUND'])('FREQ-540-AC-13: 実PostgRESTの%sを固定本文へ分類', async (code) => {
      const f = await pair(); const input = swapInput(f);
      if (code === 'GROUP_G_ARGUMENT_INVALID') input.quantity = 0;
      if (code === 'GROUP_G_SWAP_REASON_REQUIRED') input.reason = '  ';
      if (code === 'GROUP_G_SWAP_ITEM_NOT_FOUND') input.donorOrderItemId = randomUUID();
      await classified(code, () => swapOrderAllocations(service, code === 'GROUP_G_FORBIDDEN' ? ids()[0] : manager(), f.taker.orderId, input));
    });
    test('FREQ-523-AC-02: 実PostgRESTの同じ注文の別明細はSAME_ORDER', async () => {
      const f = await pair();
      const donorItemId = await withGroupG1FixtureTransaction(db(), async () => (await db().query(`insert into public.order_items(order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type)
        select order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type from public.order_items where id=$1 returning id`, [f.taker.orderItemId])).rows[0].id as string);
      await classified('GROUP_G_SWAP_SAME_ORDER', () => swapOrderAllocations(service, manager(), f.taker.orderId, { ...swapInput(f), donorOrderItemId: donorItemId }));
    });
    test('FREQ-523-AC-05: 候補読取の未払い・所属違い・権限不足も固定分類', async () => {
      const f = await pair({ takerStatus: 'pending' });
      await classified('GROUP_G_SWAP_ORDER_NOT_PAID', () => listAllocationSwapCandidates(service, manager(), f.taker.orderId, f.taker.orderItemId));
      await classified('GROUP_G_SWAP_ITEM_NOT_FOUND', () => listAllocationSwapCandidates(service, manager(), f.donor.orderId, f.taker.orderItemId));
      await classified('GROUP_G_FORBIDDEN', () => listAllocationSwapCandidates(service, ids()[0], f.taker.orderId, f.taker.orderItemId));
    });
  });
}
