/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connectLocalDb, describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { withGroupG1FixtureTransaction, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { seedGroupG3ReadyOrder, seedGroupG3Slip } from './helpers/group-g3-fixtures';
import {
  enableDeliveryTracking, leaseDeliveryRegistration, patchDeliveryRegistration, recordReadResult, restoreCommittedDeliveryState,
} from './helpers/delivery-tracking-fixtures';
import { loadOrderStatusPublicMaterial } from '@/lib/orders/status/status-store';
import { getOrderDeliveryDetail } from '@/lib/orders/tracking/delivery-store';
import { buildCustomerOrderPublicView } from '@/lib/orders/customer-order-view';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  cancelShipmentSlip,
  confirmShipmentSlip,
  discardShipmentSlipDraft,
  getAdminShipmentSlip,
  listAdminOrderShipmentSlips,
  listAdminPacking,
  listAdminShipmentSlips,
  markShipmentSlipDelivered,
  saveShipmentSlipDraft,
  ShipmentSlipError,
  updateShipmentSlipTracking,
} from '@/lib/orders/shipment-slips/shipment-slip-store';

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
  /** 本物の store の読取関数を、service_role の supabase-js → PostgREST → SQL の道で1回ずつ通す（戻りは store の検査を通った camelCase） */
  test('FREQ-531-AC-01: 実 store の読取4本が PostgREST を通り、型検査を通った camelCase の行・詳細・結び付きを返す', async () => {
    let packing = await listAdminPacking(service, actor, { slipId: slipId, limit: 100, page: 1 });
    let row = packing.rows.find((r) => r.orderItemId === itemId);
    for (let page = 2; !row && (page - 1) * 100 < packing.total; page += 1) {
      packing = await listAdminPacking(service, actor, { slipId: slipId, limit: 100, page });
      row = packing.rows.find((r) => r.orderItemId === itemId);
    }
    expect(row).toMatchObject({
      orderId, orderItemId: itemId, readyQuantity: 4, shippableQuantity: 4, selectedQuantity: 2, bundleOk: true, blockedReasons: [], otherSlipNumbers: [],
    });
    expect(packing.total).toBeGreaterThanOrEqual(1);

    let slips = await listAdminShipmentSlips(service, actor, { stage: 'draft', limit: 100, page: 1 });
    let listed = slips.rows.find((r) => r.id === slipId);
    for (let page = 2; !listed && (page - 1) * 100 < slips.total; page += 1) {
      slips = await listAdminShipmentSlips(service, actor, { stage: 'draft', limit: 100, page });
      listed = slips.rows.find((r) => r.id === slipId);
    }
    expect(listed).toMatchObject({ id: slipId, stage: 'draft', expired: true, orderCount: 1, itemQuantity: 2, shipmentDate: null, shippingCarrier: null, trackingNumber: null });

    const detail = await getAdminShipmentSlip(service, actor, slipId);
    expect(detail).toMatchObject({ id: slipId, stage: 'draft', expired: true, notifyCustomer: null, confirmedAt: null });
    expect(detail.lines).toEqual([expect.objectContaining({ orderId, orderItemId: itemId, quantity: 2, readyQuantity: 4, isExchange: false })]);
    expect(detail.issues).toContainEqual({ code: 'expired', orderItemId: null });

    // 下書きは発送を持たないので、注文に結び付く票は無い
    expect((await listAdminOrderShipmentSlips(service, actor, orderId)).size).toBe(0);
  });

  test('FREQ-531-AC-04: 実 store は PostgREST 越しの権限なし・不在の票を、固定の 403・404 の ShipmentSlipError にする（生の誤りは持たない）', async () => {
    const stranger = randomUUID();
    const failures: Array<[string, () => Promise<unknown>, number, string]> = [
      ['packing', () => listAdminPacking(service, stranger, { slipId: null, limit: 50, page: 1 }), 403, 'GROUP_G_FORBIDDEN'],
      ['slips', () => listAdminShipmentSlips(service, stranger, { stage: null, limit: 20, page: 1 }), 403, 'GROUP_G_FORBIDDEN'],
      ['detail', () => getAdminShipmentSlip(service, stranger, slipId), 403, 'GROUP_G_FORBIDDEN'],
      ['order slips', () => listAdminOrderShipmentSlips(service, stranger, orderId), 403, 'GROUP_G_FORBIDDEN'],
      ['missing slip', () => getAdminShipmentSlip(service, actor, randomUUID()), 404, 'GROUP_G_SLIP_NOT_FOUND'],
      ['missing packing slip', () => listAdminPacking(service, actor, { slipId: randomUUID(), limit: 50, page: 1 }), 404, 'GROUP_G_SLIP_NOT_FOUND'],
    ];
    for (const [name, call, status, code] of failures) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect({ name, isStoreError: error instanceof ShipmentSlipError }).toEqual({ name, isStoreError: true });
      expect({ name, status: (error as ShipmentSlipError).status, code: (error as ShipmentSlipError).code }).toEqual({ name, status, code });
    }
  });

  /** 本物の store の書込み関数を、service_role の supabase-js → PostgREST → SQL の道で通す（G-3 Task 4）。作った下書きは最後に破棄する */
  test('FREQ-531-AC-03: 実 store の下書きの作成・入替・破棄が PostgREST を通り、再送は replayed: true、版違い・権限なしは固定の 409・403 の ShipmentSlipError', async () => {
    const key = randomUUID();
    const created = await saveShipmentSlipDraft(service, actor, { slipId: null, expectedVersion: null, lines: [{ orderItemId: itemId, quantity: 1 }], requestKey: key });
    expect(created).toMatchObject({ version: 1, replayed: false });
    expect(created.number).toMatch(/^SL-[0-9]{8}-[0-9]{4}$/);
    expect(await saveShipmentSlipDraft(service, actor, { slipId: null, expectedVersion: null, lines: [{ orderItemId: itemId, quantity: 1 }], requestKey: key }))
      .toEqual({ ...created, replayed: true });

    const replaced = await saveShipmentSlipDraft(service, actor, { slipId: created.id, expectedVersion: 1, lines: [{ orderItemId: itemId, quantity: 3 }], requestKey: randomUUID() });
    expect(replaced).toEqual({ id: created.id, number: created.number, version: 2, replayed: false });
    const detail = await getAdminShipmentSlip(service, actor, created.id);
    expect(detail).toMatchObject({ id: created.id, stage: 'draft', version: 2 });
    expect(detail.lines).toEqual([expect.objectContaining({ orderItemId: itemId, quantity: 3 })]);

    const failures: Array<[string, () => Promise<unknown>, number, string]> = [
      ['stale version', () => saveShipmentSlipDraft(service, actor, { slipId: created.id, expectedVersion: 1, lines: [{ orderItemId: itemId, quantity: 1 }], requestKey: randomUUID() }), 409, 'GROUP_G_SLIP_VERSION_CONFLICT'],
      ['too many', () => saveShipmentSlipDraft(service, actor, { slipId: created.id, expectedVersion: 2, lines: [{ orderItemId: itemId, quantity: 5 }], requestKey: randomUUID() }), 409, 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY'],
      ['empty', () => saveShipmentSlipDraft(service, actor, { slipId: created.id, expectedVersion: 2, lines: [], requestKey: randomUUID() }), 400, 'GROUP_G_SLIP_EMPTY'],
      ['stranger save', () => saveShipmentSlipDraft(service, randomUUID(), { slipId: null, expectedVersion: null, lines: [{ orderItemId: itemId, quantity: 1 }], requestKey: randomUUID() }), 403, 'GROUP_G_FORBIDDEN'],
      ['stranger discard', () => discardShipmentSlipDraft(service, randomUUID(), { slipId: created.id, expectedVersion: 2, requestKey: randomUUID() }), 403, 'GROUP_G_FORBIDDEN'],
      ['missing slip', () => discardShipmentSlipDraft(service, actor, { slipId: randomUUID(), expectedVersion: 1, requestKey: randomUUID() }), 404, 'GROUP_G_SLIP_NOT_FOUND'],
    ];
    for (const [name, call, status, code] of failures) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect({ name, isStoreError: error instanceof ShipmentSlipError }).toEqual({ name, isStoreError: true });
      expect({ name, status: (error as ShipmentSlipError).status, code: (error as ShipmentSlipError).code }).toEqual({ name, status, code });
    }

    const discardKey = randomUUID();
    const discarded = await discardShipmentSlipDraft(service, actor, { slipId: created.id, expectedVersion: 2, requestKey: discardKey });
    expect(discarded).toEqual({ id: created.id, number: created.number, version: 3, replayed: false });
    expect(await discardShipmentSlipDraft(service, actor, { slipId: created.id, expectedVersion: 2, requestKey: discardKey })).toEqual({ ...discarded, replayed: true });
    const again = await discardShipmentSlipDraft(service, actor, { slipId: created.id, expectedVersion: 3, requestKey: randomUUID() }).then(() => null, (e: unknown) => e);
    expect({ status: (again as ShipmentSlipError).status, code: (again as ShipmentSlipError).code }).toEqual({ status: 409, code: 'GROUP_G_SLIP_NOT_DRAFT' });
    expect(await getAdminShipmentSlip(service, actor, created.id)).toMatchObject({ stage: 'discarded', version: 3 });
  });

  test('FREQ-533-AC-02: 実storeの確定はPostgRESTを通り、再送で発送を増やさず、版違いと権限なしを分類する', async () => {
    const created = await saveShipmentSlipDraft(service, actor, { slipId: null, expectedVersion: null, lines: [{ orderItemId: itemId, quantity: 1 }], requestKey: randomUUID() });
    const input = { slipId: created.id, expectedVersion: 1, carrier: null, trackingNumber: null, shipmentDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()), notifyCustomer: true, requestKey: randomUUID() };
    await expect(confirmShipmentSlip(service, actor, { ...input, expectedVersion: 99 })).rejects.toMatchObject({ status: 409, code: 'GROUP_G_SLIP_VERSION_CONFLICT' });
    await expect(confirmShipmentSlip(service, randomUUID(), input)).rejects.toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    const confirmed = await confirmShipmentSlip(service, actor, input);
    expect(confirmed).toMatchObject({ id: created.id, version: 2, shipmentDate: input.shipmentDate, replayed: false });
    expect(confirmed.fulfillments).toEqual([{ orderId, fulfillmentId: expect.any(String), number: 1, completesOrder: false }]);
    expect(await confirmShipmentSlip(service, actor, input)).toEqual({ ...confirmed, replayed: true });
  });

  test('FREQ-533-AC-04: 実storeの取消はPostgRESTを通り、再送で戻しを増やさず、版違い・権限なし・取消済みを分類する', async () => {
    const created = await saveShipmentSlipDraft(service, actor, { slipId: null, expectedVersion: null, lines: [{ orderItemId: itemId, quantity: 1 }], requestKey: randomUUID() });
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const confirmed = await confirmShipmentSlip(service, actor, { slipId: created.id, expectedVersion: 1, carrier: null, trackingNumber: null, shipmentDate: today, notifyCustomer: false, requestKey: randomUUID() });
    const input = { slipId: created.id, expectedVersion: confirmed.version, requestKey: randomUUID() };
    await expect(cancelShipmentSlip(service, actor, { ...input, expectedVersion: 99 })).rejects.toMatchObject({ status: 409, code: 'GROUP_G_SLIP_VERSION_CONFLICT' });
    await expect(cancelShipmentSlip(service, randomUUID(), input)).rejects.toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    const cancelled = await cancelShipmentSlip(service, actor, input);
    expect(cancelled).toEqual({ id: created.id, version: confirmed.version + 1, restoredQuantity: 1, replayed: false });
    expect(await cancelShipmentSlip(service, actor, input)).toEqual({ ...cancelled, replayed: true });
    await expect(cancelShipmentSlip(service, actor, { ...input, requestKey: randomUUID() })).rejects.toMatchObject({ status: 409, code: 'GROUP_G_SLIP_CANCELLED' });
    expect(await getAdminShipmentSlip(service, actor, created.id)).toMatchObject({ stage: 'cancelled', version: cancelled.version });
  });

  test('FREQ-534-AC-01: 実storeの伝票番号の後入力はPostgRESTを通り、再送で増えず、同じ値・版違い・権限なしを分類する。続けて手動の配達済みも通り、再送で増えず、配達済みの票への別キーはALREADY_DELIVERED', async () => {
    const created = await saveShipmentSlipDraft(service, actor, { slipId: null, expectedVersion: null, lines: [{ orderItemId: itemId, quantity: 1 }], requestKey: randomUUID() });
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const confirmed = await confirmShipmentSlip(service, actor, { slipId: created.id, expectedVersion: 1, carrier: null, trackingNumber: null, shipmentDate: today, notifyCustomer: false, requestKey: randomUUID() });
    const number = `PG-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const input = { slipId: created.id, expectedVersion: confirmed.version, carrier: 'yamato' as const, trackingNumber: number, notifyCustomer: false, requestKey: randomUUID() };
    await expect(updateShipmentSlipTracking(service, actor, { ...input, expectedVersion: 99 })).rejects.toMatchObject({ status: 409, code: 'GROUP_G_SLIP_VERSION_CONFLICT' });
    await expect(updateShipmentSlipTracking(service, randomUUID(), input)).rejects.toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    const updated = await updateShipmentSlipTracking(service, actor, input);
    expect(updated).toEqual({ id: created.id, version: confirmed.version + 1, trackingVersion: 2, replayed: false });
    expect(await updateShipmentSlipTracking(service, actor, input)).toEqual({ ...updated, replayed: true });
    await expect(updateShipmentSlipTracking(service, actor, { ...input, expectedVersion: updated.version, trackingNumber: number.toLowerCase(), requestKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_G_SLIP_TRACKING_UNCHANGED' });
    expect(await getAdminShipmentSlip(service, actor, created.id)).toMatchObject({ stage: 'confirmed', version: updated.version, carrier: 'yamato', trackingNumber: number, trackingVersion: 2 });

    const delivery = { slipId: created.id, expectedVersion: updated.version, deliveredOn: today, notifyCustomer: false, requestKey: randomUUID() };
    await expect(markShipmentSlipDelivered(service, randomUUID(), delivery)).rejects.toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    await expect(markShipmentSlipDelivered(service, actor, { ...delivery, expectedVersion: 99 })).rejects.toMatchObject({ status: 409, code: 'GROUP_G_SLIP_VERSION_CONFLICT' });
    await expect(markShipmentSlipDelivered(service, actor, { ...delivery, deliveredOn: '2000-01-01', requestKey: randomUUID() })).rejects.toMatchObject({ status: 400, code: 'GROUP_G_SLIP_DELIVERY_DATE_INVALID' });
    const delivered = await markShipmentSlipDelivered(service, actor, delivery);
    expect(delivered).toEqual({ id: created.id, version: updated.version + 1, deliveredAt: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/), replayed: false });
    expect(await markShipmentSlipDelivered(service, actor, delivery)).toEqual({ ...delivered, replayed: true });
    await expect(markShipmentSlipDelivered(service, actor, { ...delivery, expectedVersion: delivered.version, requestKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_G_SLIP_ALREADY_DELIVERED' });
    const detail = await getAdminShipmentSlip(service, actor, created.id);
    expect(detail.orders).toEqual([expect.objectContaining({ orderId, deliveryStatus: 'delivered', deliveredAt: expect.any(String) })]);
  });

  /**
   * 追跡の親（G-3 Task 8）。追跡オンの2注文の票を確定し、代表の登録を登録済みにして in_transit の読み直しを書いたものを commit し、
   * お客様向けの公開材料（loadOrderStatusPublicMaterial → buildCustomerOrderPublicView）と管理の配送詳細（getOrderDeliveryDetail）を
   * 実 supabase-js → PostgREST → SQL の道で読む。参加の注文にも代表の登録の状態と配送の状況が出て、別の注文の情報は入らない。
   */
  test('FREQ-541-AC-03: 実 store の顧客向けの経路が PostgREST を通り、同梱票の参加の注文にも代表の登録の状態と配送の状況が出て、どの注文の出力にも別の注文の注文ID・品物・発送は入らない', async () => {
    const cleanup = await connectLocalDb();
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    let slip: string | undefined;
    try {
      const made = await withGroupG1FixtureTransaction(db(), async () => {
        await enableDeliveryTracking(db());
        const orders = [await seedGroupG3ReadyOrder(db()), await seedGroupG3ReadyOrder(db())];
        const drafted = (await db().query('select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r',
          [JSON.stringify(orders.map((o) => ({ orderItemId: o.orderItemId, quantity: 2 }))), actor, randomUUID()])).rows[0].r as { id: string };
        const confirmed = (await db().query('select public.admin_confirm_shipment_slip($1,1,$2,$3,$4::date,true,$5,$6) as r',
          [drafted.id, 'yamato', `PG-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`, today, actor, randomUUID()]))
          .rows[0].r as { fulfillments: Array<{ orderId: string; fulfillmentId: string }> };
        const rows = [...confirmed.fulfillments].sort((x, y) => (x.orderId < y.orderId ? -1 : x.orderId > y.orderId ? 1 : 0));
        await patchDeliveryRegistration(db(), rows[0].fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 1);
        const lease = await leaseDeliveryRegistration(db(), rows[0].fulfillmentId, 1);
        const when = new Date((await db().query('select now() as at')).rows[0].at).toISOString();
        const result = await recordReadResult(db(), lease, { outcome: 'ok', status: 'in_transit', provider_status: 'InTransit',
          provider_sub_status: null, happened_at: when, delivered_at: null, read_at: when, error_code: null });
        return { slipId: drafted.id, rows, orders, result };
      }); // commit: PostgREST reads from separate connections
      slip = made.slipId;
      expect(made.result).toEqual({ applied: true, changed: true, stopped: false });
      for (const row of made.rows) {
        const other = made.rows.find((candidate) => candidate.orderId !== row.orderId)!;
        const otherItem = made.orders.find((order) => order.orderId === other.orderId)!.orderItemId;
        const material = await loadOrderStatusPublicMaterial(service, row.orderId);
        expect(material?.deliveryDetail.fulfillments).toEqual([expect.objectContaining({
          fulfillmentId: row.fulfillmentId, deliveryStatus: 'in_transit', registration: { state: 'registered', everRegistered: true } })]);
        const view = await buildCustomerOrderPublicView({ ...material!, returnSection: null, trackingKeyConfigured: true, signImage: async () => null });
        expect(view.shipments).toHaveLength(1);
        expect(view.shipments[0]).toMatchObject({ id: row.fulfillmentId, delivery: { status: 'in_transit' } });
        const detail = await getOrderDeliveryDetail(service, row.orderId);
        expect(detail.fulfillments).toEqual([expect.objectContaining({
          fulfillmentId: row.fulfillmentId, deliveryStatus: 'in_transit', registration: expect.objectContaining({ state: 'registered', everRegistered: true }) })]);
        const text = JSON.stringify([material, view, detail]);
        for (const forbidden of [other.orderId, toOrderNumber(other.orderId), other.fulfillmentId, otherItem]) expect({ row: row.orderId, leaks: text.includes(forbidden) }).toEqual({ row: row.orderId, leaks: false });
      }
    } finally {
      try {
        if (slip) await cancelShipmentSlip(service, actor, { slipId: slip, expectedVersion: 2, requestKey: randomUUID() }).catch(() => undefined);
      } finally {
        try { await restoreCommittedDeliveryState(cleanup); } finally { await cleanup.end(); }
      }
    }
  });

  test('FREQ-540-AC-10: 下書きの保存・破棄・確定・取消・伝票番号・配達済みの公開入口も、anon・実authenticated JWTはactor権限があってもEXECUTEを拒み（42501）、何も書かない', async () => {
    const writes = (): Array<[string, Record<string, unknown>]> => [
      ['admin_save_shipment_slip_draft', { _slip_id: null, _expected_version: null, _lines: [{ orderItemId: itemId, quantity: 1 }], _actor_id: actor, _request_key: randomUUID() }],
      ['admin_discard_shipment_slip_draft', { _slip_id: slipId, _expected_version: 1, _actor_id: actor, _request_key: randomUUID() }],
      ['admin_confirm_shipment_slip', { _slip_id: slipId, _expected_version: 1, _carrier: null, _tracking_number: null, _shipment_date: '2026-10-25', _notify_customer: false, _actor_id: actor, _request_key: randomUUID() }],
      ['admin_cancel_shipment_slip', { _slip_id: slipId, _expected_version: 1, _actor_id: actor, _request_key: randomUUID() }],
      ['admin_update_shipment_slip_tracking', { _slip_id: slipId, _expected_version: 2, _carrier: 'yamato', _tracking_number: 'DENIED-1', _notify_customer: false, _actor_id: actor, _request_key: randomUUID() }],
      ['admin_mark_shipment_slip_delivered', { _slip_id: slipId, _expected_version: 2, _delivered_on: '2026-10-25', _notify_customer: false, _actor_id: actor, _request_key: randomUUID() }],
    ];
    const countBefore = (await service.rpc('list_admin_shipment_slips', { _stage: 'discarded', _limit: 1, _offset: 0, _actor_id: actor })).data?.[0]?.total_count;
    for (const client of [anon, authenticated]) for (const [name, args] of writes()) {
      const r = await client.rpc(name, args);
      expect({ name, code: r.error?.code, denied: [401, 403].includes(r.status) }).toEqual({ name, code: '42501', denied: true });
    }
    expect((await service.rpc('list_admin_shipment_slips', { _stage: 'discarded', _limit: 1, _offset: 0, _actor_id: actor })).data?.[0]?.total_count).toBe(countBefore);
    expect(await getAdminShipmentSlip(service, actor, slipId)).toMatchObject({ stage: 'draft', version: 1 });
  });
  test('FREQ-540-AC-10: anon・実authenticated JWTはactor権限があっても5本すべてのEXECUTEを拒む', async () => {
    for (const client of [anon, authenticated]) for (const [name, args] of calls()) {
      const r = await client.rpc(name, args);
      expect({ name, code: r.error?.code, denied: [401, 403].includes(r.status) })
        .toEqual({ name, code: '42501', denied: true });
    }
  });
});
