/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  claimDelivery, claimDeliveryFor, createDeliveryActor, deliveryClock, deliveryEvents, deliveryRecord,
  deliveryRegistration, deliveryRegistrations, deliveryShipment, enableDeliveryTracking, expectDeliveryRejected,
  expireDelivery, insertDeliveryAttention, leaseDeliveryRegistration, markDeliveryDelivered, patchDeliveryRegistration,
  recordReadResult, recordRegistrationResult, recordStopResult, setDeliveryTracking, signalDelivery, trackedShipment,
  updateDeliveryTracking, withDeliveryConnectionPool, withDeliveryConnections,
  type DeliveryClaim, type ManualDelivery, type TrackingEdit,
} from './helpers/delivery-tracking-fixtures';

/** 移行 C の追跡の関数（借りる・結果を書く・合図・期限・枠）の契約。DB の実行と RED/GREEN の確認は controller が行う。 */
jest.setTimeout(30000);

const HOUR = 3600 * 1000;
const iso = (value: Date | string) => new Date(value).toISOString();
const shifted = (value: Date | string, ms: number) => new Date(new Date(value).getTime() + ms).toISOString();
const pairOf = (claim: Pick<DeliveryClaim, 'carrier' | 'tracking_number'>) => `${claim.carrier}:${claim.tracking_number.toUpperCase()}`;
/** 他の試験が commit した行と同じ組にならない伝票番号（同じ組に別の追跡中の行があると借り出しの結果が変わる）。 */
const uniqueNumber = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;

type Parent = { orderId: string; fulfillmentId: string; actorId: string };
const editOf = (target: Parent, extra: Partial<TrackingEdit> = {}): TrackingEdit => ({
  ...target, requestKey: randomUUID(), carrier: 'sagawa', trackingNumber: uniqueNumber('EDIT'), notifyCustomer: false, ...extra,
});
const manualOf = (target: Parent & { clock: { yesterday: string } }, extra: Partial<ManualDelivery> = {}): ManualDelivery => ({
  ...target, requestKey: randomUUID(), deliveredOn: target.clock.yesterday, notifyCustomer: false, ...extra,
});

/** DeliveryReadResult の snake_case。既定は「読んだ時刻に輸送中の出来事があった」。 */
type ReadInput = Record<string, unknown>;
const readOf = (at: string, extra: ReadInput = {}): ReadInput => ({
  outcome: 'ok', status: 'in_transit', provider_status: 'InTransit', provider_sub_status: 'InTransit_001',
  happened_at: at, delivered_at: null, read_at: at, error_code: null, ...extra,
});
const NOT_FOUND: ReadInput = {
  outcome: 'not_found', status: null, provider_status: null, provider_sub_status: null, happened_at: null, delivered_at: null, error_code: null,
};

/** DB の now()（取引の間は動かない）に間隔を足した時刻。予定の時刻を ms まで照らす。 */
async function dbTime(client: PgClient, interval = '0 seconds') {
  return iso((await client.query('select now() + $1::interval as at', [interval])).rows[0].at);
}

async function emails(client: PgClient, fulfillmentId: string) {
  return (await client.query('select * from private.order_email_outbox where fulfillment_id=$1 order by kind,tracking_version,seq', [fulfillmentId])).rows;
}

async function attention(client: PgClient, fulfillmentId: string) {
  return (await client.query('select * from public.order_fulfillment_attention where fulfillment_id=$1 order by opened_at,id', [fulfillmentId])).rows;
}

async function attentionTotal(client: PgClient) {
  return (await client.query('select count(*)::integer as n from public.order_fulfillment_attention')).rows[0].n as number;
}

async function openKindsOf(client: PgClient, fulfillmentId: string) {
  return (await attention(client, fulfillmentId)).filter((row) => row.resolved_at === null).map((row) => row.kind as string).sort();
}

async function trackingEvents(client: PgClient, fulfillmentId: string) {
  return (await deliveryEvents(client, fulfillmentId)).filter((row) => row.source === 'tracking');
}

/** 発送の記録・出来事・登録・要対応・メールを同時に見る（表の1行ごとに、増えない物は前後の一致で固定する）。 */
async function observe(client: PgClient, fulfillmentId: string) {
  return {
    record: await deliveryRecord(client, fulfillmentId),
    events: await deliveryEvents(client, fulfillmentId),
    registrations: await deliveryRegistrations(client, fulfillmentId),
    attention: await attention(client, fulfillmentId),
    emails: await emails(client, fulfillmentId),
  };
}
type Observed = Awaited<ReturnType<typeof observe>>;
function expectSame(after: Observed, before: Observed, keys: Array<keyof Observed>) {
  for (const key of keys) expect(after[key]).toEqual(before[key]);
}

/** 借りの印を置いて、結果を書く関数に読み直しの結果を渡す。出来事の時刻は hoursAgo 時間前。 */
async function readStatus(client: PgClient, fulfillmentId: string, status: string, hoursAgo: number, extra: ReadInput = {}, version = 1) {
  const lease = await leaseDeliveryRegistration(client, fulfillmentId, version);
  return recordReadResult(client, lease, readOf(await dbTime(client), {
    status, happened_at: await dbTime(client, `-${hoursAgo} hours`), ...extra,
  }));
}

async function cancelFulfillment(client: PgClient, target: Parent) {
  await client.query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId]);
}

type Scenario = (client: PgClient) => Promise<void>;

/**
 * 計画の Task 3 の表。1行ごとに applied/changed・発送の記録・出来事・登録・要対応・メールを同時に見る。
 * 取引の中で動く行だけをここに置く（4接続の枠は下の別の試験）。
 */
const TABLE_ROWS: Array<[string, Scenario]> = [
  ['ON=false: claim空・合図0件・結果applied=false・attention増加0', async (client) => {
    const actor = await createDeliveryActor(client);
    await setDeliveryTracking(client, false, actor.id);
    const target = await trackedShipment(client, { state: 'registered', notifyCustomer: true });
    const pending = await trackedShipment(client, { state: 'pending', notifyCustomer: true });
    const ids = [target.fulfillmentId, pending.fulfillmentId];
    const attentionBefore = await attentionTotal(client);
    const dueBefore = [await observe(client, ids[0]), await observe(client, ids[1])];
    expect(await claimDeliveryFor(client, ids)).toEqual([]);
    expect(await signalDelivery(client, [{ carrier: 100062, number: target.trackingNumber.toLowerCase(), event: 'TRACKING_UPDATED' }])).toBe(0);
    expect([await observe(client, ids[0]), await observe(client, ids[1])]).toEqual(dueBefore);
    // 借りの印が合っていても、オフの間は結果を書かない
    const readLease = await leaseDeliveryRegistration(client, ids[0]);
    const registerLease = await leaseDeliveryRegistration(client, ids[1]);
    const leasedBefore = [await observe(client, ids[0]), await observe(client, ids[1])];
    const now = await dbTime(client);
    expect(await recordReadResult(client, readLease, readOf(now, { status: 'delivered', delivered_at: now })))
      .toEqual({ applied: false, changed: false, stopped: false });
    expect(await recordRegistrationResult(client, registerLease, 'registered')).toMatchObject({ applied: false });
    expect([await observe(client, ids[0]), await observe(client, ids[1])]).toEqual(leasedBefore);
    expect(await attentionTotal(client)).toBe(attentionBefore);
  }],

  ['同じtokenでも旧版・取消・手で配達済みの後は結果を書かない（applied=false、状態・イベント・メール変更0）', async (client) => {
    await enableDeliveryTracking(client);
    for (const cause of ['旧版', '取消', '手で配達済み'] as const) {
      for (const kind of ['read', 'register'] as const) {
        const target = await trackedShipment(client, { state: kind === 'read' ? 'registered' : 'pending', notifyCustomer: true });
        const [claim] = await claimDeliveryFor(client, [target.fulfillmentId]);
        expect(claim).toMatchObject({ action: kind, tracking_version: 1 });
        if (cause === '旧版') await updateDeliveryTracking(client, editOf(target, { notifyCustomer: true }));
        else if (cause === '取消') await cancelFulfillment(client, target);
        else await markDeliveryDelivered(client, manualOf(target, { notifyCustomer: true }));
        const before = await observe(client, target.fulfillmentId);
        if (kind === 'read') {
          expect(await recordReadResult(client, claim, readOf(await dbTime(client), { status: 'out_for_delivery' })))
            .toEqual({ applied: false, changed: false, stopped: false });
        } else {
          expect(await recordRegistrationResult(client, claim, 'registered')).toMatchObject({ applied: false });
        }
        expect(await observe(client, target.fulfillmentId)).toEqual(before);
      }
    }
  }],

  ['同じ版の最後のtracking時刻より1秒前はchanged=false。shipmentの時刻は比較に使わない', async (client) => {
    await enableDeliveryTracking(client);
    const target = await trackedShipment(client, { state: 'registered' });
    const last = await dbTime(client, '-2 hours');
    expect(await recordReadResult(client, await leaseDeliveryRegistration(client, target.fulfillmentId), readOf(last)))
      .toMatchObject({ applied: true, changed: true });
    const lease = await leaseDeliveryRegistration(client, target.fulfillmentId);
    const before = await observe(client, target.fulfillmentId);
    const result = await recordReadResult(client, lease, readOf(await dbTime(client), { status: 'out_for_delivery', happened_at: shifted(last, -1000) }));
    expect(result).toMatchObject({ applied: true, changed: false });
    const after = await observe(client, target.fulfillmentId);
    expectSame(after, before, ['record', 'events', 'attention', 'emails']);
    expect(after.registrations[0]).toMatchObject({ state: 'registered' });
    // 発送した時刻の出来事（shipment）より前の結果でも、同じ版の tracking の出来事が無ければ古いとは判定しない
    const fresh = await trackedShipment(client, { state: 'registered' });
    const beforeShipment = shifted((await deliveryRecord(client, fresh.fulfillmentId)).shipped_at, -1000);
    expect(await recordReadResult(client, await leaseDeliveryRegistration(client, fresh.fulfillmentId), readOf(await dbTime(client), { happened_at: beforeShipment })))
      .toMatchObject({ applied: true, changed: true });
    expect(await deliveryRecord(client, fresh.fulfillmentId)).toMatchObject({ delivery_status: 'in_transit' });
  }],

  ['同時刻で異なる状況はlease取得順の結果を受け、同じstatus/timeの二重はUNIQUEで増えない', async (client) => {
    await enableDeliveryTracking(client);
    const target = await trackedShipment(client, { state: 'registered' });
    const at = await dbTime(client, '-2 hours');
    const apply = async (status: string) => recordReadResult(
      client, await leaseDeliveryRegistration(client, target.fulfillmentId), readOf(await dbTime(client), { status, happened_at: at }),
    );
    expect(await apply('in_transit')).toMatchObject({ applied: true, changed: true });
    expect(await apply('out_for_delivery')).toMatchObject({ applied: true, changed: true });
    const record = await deliveryRecord(client, target.fulfillmentId);
    expect(record.delivery_status).toBe('out_for_delivery');
    expect(iso(record.delivery_status_at)).toBe(at);
    // 先に出た状況へ戻す結果も、後に借りた方として受ける。同じ（版・状況・時刻）の出来事は増えない
    expect(await apply('in_transit')).toMatchObject({ applied: true, changed: true });
    expect((await deliveryRecord(client, target.fulfillmentId)).delivery_status).toBe('in_transit');
    expect(await trackingEvents(client, target.fulfillmentId)).toHaveLength(2);
    expect(await apply('in_transit')).toMatchObject({ applied: true, changed: false });
    expect(await trackingEvents(client, target.fulfillmentId)).toHaveLength(2);
  }],

  ['配達済みの後に配達中はchanged=false・out_for_deliveryメール0（登録は配達済みで止める）', async (client) => {
    await enableDeliveryTracking(client);
    const clock = await deliveryClock(client);
    const target = await trackedShipment(client, {
      state: 'registered', notifyCustomer: true, deliveredAt: `${clock.yesterday}T12:00:00+09:00`,
    });
    const lease = await leaseDeliveryRegistration(client, target.fulfillmentId);
    const before = await observe(client, target.fulfillmentId);
    const result = await recordReadResult(client, lease, readOf(await dbTime(client), { status: 'out_for_delivery' }));
    expect(result.changed).toBe(false);
    const after = await observe(client, target.fulfillmentId);
    expectSame(after, before, ['record', 'events', 'attention', 'emails']);
    expect(after.emails.filter((row) => row.kind === 'out_for_delivery')).toEqual([]);
    expect(after.registrations[0]).toMatchObject({ state: 'stopped', stop_reason: 'delivered' });
  }],

  ['providerの届いた時刻<shipped_atならdelivered_at=shipped_at、trackingイベントのhappened_atはprovider時刻', async (client) => {
    await enableDeliveryTracking(client);
    for (const withDeliveredAt of [true, false]) {
      const target = await trackedShipment(client, { state: 'registered', notifyCustomer: false });
      const shippedAt = iso((await deliveryRecord(client, target.fulfillmentId)).shipped_at);
      const early = shifted(shippedAt, -HOUR);
      const result = await recordReadResult(client, await leaseDeliveryRegistration(client, target.fulfillmentId), readOf(await dbTime(client), {
        status: 'delivered', provider_status: 'Delivered', provider_sub_status: 'Delivered_001',
        happened_at: early, delivered_at: withDeliveredAt ? early : null,
      }));
      expect(result).toMatchObject({ applied: true, changed: true, stopped: true });
      const record = await deliveryRecord(client, target.fulfillmentId);
      expect(record.delivery_status).toBe('delivered');
      expect(iso(record.delivered_at)).toBe(shippedAt);
      const delivered = (await trackingEvents(client, target.fulfillmentId)).filter((row) => row.status === 'delivered');
      expect(delivered).toHaveLength(1);
      expect(iso(delivered[0].happened_at)).toBe(early);
      expect((await deliveryRegistrations(client, target.fulfillmentId))[0]).toMatchObject({ state: 'stopped', stop_reason: 'delivered' });
    }
  }],

  ['providerに時刻が無ければhappened_at=read_at', async (client) => {
    await enableDeliveryTracking(client);
    const readAt = await dbTime(client, '-10 minutes');
    const noTime = { happened_at: null, delivered_at: null };
    const moving = await trackedShipment(client, { state: 'registered' });
    expect(await recordReadResult(client, await leaseDeliveryRegistration(client, moving.fulfillmentId), readOf(readAt, noTime)))
      .toMatchObject({ applied: true, changed: true });
    const events = await trackingEvents(client, moving.fulfillmentId);
    expect(events).toHaveLength(1);
    expect(iso(events[0].happened_at)).toBe(readAt);
    expect(iso((await deliveryRecord(client, moving.fulfillmentId)).delivery_status_at)).toBe(readAt);
    // 届いた時刻も無い配達済みは、読んだ時刻（発送した時刻より後）を届いた時刻にする
    const arrived = await trackedShipment(client, { state: 'registered' });
    expect(await recordReadResult(client, await leaseDeliveryRegistration(client, arrived.fulfillmentId), readOf(readAt, { ...noTime, status: 'delivered' })))
      .toMatchObject({ applied: true, changed: true, stopped: true });
    expect(iso((await deliveryRecord(client, arrived.fulfillmentId)).delivered_at)).toBe(readAt);
    expect(iso((await trackingEvents(client, arrived.fulfillmentId))[0].happened_at)).toBe(readAt);
  }],

  ['NotFoundは登録後71:59:59ならattention0、72:00:00ならtracking_not_found1（登録前の作成時刻から数えない）', async (client) => {
    await enableDeliveryTracking(client);
    for (const [elapsed, count] of [['71:59:59', 0], ['72:00:00', 1]] as const) {
      const target = await trackedShipment(client, { state: 'registered', shippedAt: await dbTime(client, '-10 days') });
      await patchDeliveryRegistration(client, target.fulfillmentId, 'registered_at=now()-$3::interval', 1, [elapsed]);
      const read = async () => recordReadResult(
        client, await leaseDeliveryRegistration(client, target.fulfillmentId), readOf(await dbTime(client), NOT_FOUND),
      );
      expect(await read()).toMatchObject({ applied: true, changed: false });
      expect(await openKindsOf(client, target.fulfillmentId)).toEqual(count === 0 ? [] : ['tracking_not_found']);
      expect(await deliveryRecord(client, target.fulfillmentId)).toMatchObject({ delivery_status: 'confirmed' });
      const registration = await deliveryRegistration(client, target.fulfillmentId);
      expect(registration).toMatchObject({ state: 'registered' });
      expect(iso(registration.next_run_at)).toBe(await dbTime(client, '6 hours'));
      // 開いている間にもう一度読んでも、同じ種類の行は増えない
      expect(await read()).toMatchObject({ applied: true, changed: false });
      expect(await attention(client, target.fulfillmentId)).toHaveLength(count);
    }
  }],

  ['invalid_numberは直ちにtracking_not_found、登録成功後は自動で閉じる', async (client) => {
    await enableDeliveryTracking(client);
    const registering = await trackedShipment(client, { state: 'pending' });
    const [claim] = await claimDeliveryFor(client, [registering.fulfillmentId]);
    expect(await recordRegistrationResult(client, claim, 'invalid_number', 'invalid_number')).toEqual({ applied: true, state: 'failed' });
    expect(await openKindsOf(client, registering.fulfillmentId)).toEqual(['tracking_not_found']);
    // 同じ版を試せる状態に戻して（オフ→オンの戻し方）登録できたら、開いていた要対応を自動で閉じる
    await patchDeliveryRegistration(client, registering.fulfillmentId, "state='pending',failure_kind=null,retry_allowed=true,next_run_at=now()");
    const [again] = await claimDeliveryFor(client, [registering.fulfillmentId]);
    expect(await recordRegistrationResult(client, again, 'registered')).toEqual({ applied: true, state: 'registered' });
    expect(await openKindsOf(client, registering.fulfillmentId)).toEqual([]);
    expect(await attention(client, registering.fulfillmentId)).toEqual([
      expect.objectContaining({ kind: 'tracking_not_found', resolution: 'auto', resolved_by: null }),
    ]);
    // 読み直しの「番号が正しくない」も同じ分類（状況は動かさない）
    const reading = await trackedShipment(client, { state: 'registered' });
    const recordBefore = await deliveryRecord(client, reading.fulfillmentId);
    const invalid = readOf(await dbTime(client), {
      outcome: 'invalid_number', status: null, provider_status: null, provider_sub_status: null, happened_at: null, error_code: 'invalid_number',
    });
    expect(await recordReadResult(client, await leaseDeliveryRegistration(client, reading.fulfillmentId), invalid))
      .toMatchObject({ applied: true, changed: false });
    expect(await deliveryRegistration(client, reading.fulfillmentId))
      .toMatchObject({ state: 'failed', failure_kind: 'invalid_number', retry_allowed: false });
    expect(await openKindsOf(client, reading.fulfillmentId)).toEqual(['tracking_not_found']);
    expect(await deliveryRecord(client, reading.fulfillmentId)).toEqual(recordBefore);
  }],

  ['failure→手の解決→同じfailureの読み直しは新行0、in_transit→failureなら新しいattention1', async (client) => {
    const actor = await enableDeliveryTracking(client);
    const target = await trackedShipment(client, { state: 'registered' });
    const failures = async () => (await attention(client, target.fulfillmentId)).filter((row) => row.kind === 'delivery_failure');
    await readStatus(client, target.fulfillmentId, 'failure', 6);
    const [opened] = await failures();
    expect(await openKindsOf(client, target.fulfillmentId)).toEqual(['delivery_failure']);
    await client.query('select * from public.admin_resolve_delivery_attention($1,$2)', [opened.id, actor.id]);
    expect(await readStatus(client, target.fulfillmentId, 'failure', 5)).toMatchObject({ applied: true, changed: false });
    expect(await failures()).toHaveLength(1);
    expect(await openKindsOf(client, target.fulfillmentId)).toEqual([]);
    expect(await readStatus(client, target.fulfillmentId, 'in_transit', 4)).toMatchObject({ applied: true, changed: true });
    expect(await failures()).toHaveLength(1);
    expect(await readStatus(client, target.fulfillmentId, 'failure', 3)).toMatchObject({ applied: true, changed: true });
    expect(await failures()).toHaveLength(2);
    expect(await openKindsOf(client, target.fulfillmentId)).toEqual(['delivery_failure']);
    expect((await failures()).find((row) => row.id === opened.id)).toMatchObject({ resolution: 'manual', resolved_by: actor.id });
  }],

  ['attempted_delivery→in_transit、NotFound→情報ありは、対応するattentionをautoで閉じる', async (client) => {
    await enableDeliveryTracking(client);
    const attempted = await trackedShipment(client, { state: 'registered' });
    await readStatus(client, attempted.fulfillmentId, 'attempted_delivery', 5);
    expect(await openKindsOf(client, attempted.fulfillmentId)).toEqual(['attempted_delivery']);
    await readStatus(client, attempted.fulfillmentId, 'in_transit', 4);
    expect(await openKindsOf(client, attempted.fulfillmentId)).toEqual([]);
    expect(await attention(client, attempted.fulfillmentId)).toEqual([
      expect.objectContaining({ kind: 'attempted_delivery', resolution: 'auto', resolved_by: null }),
    ]);

    const missing = await trackedShipment(client, { state: 'registered' });
    await patchDeliveryRegistration(client, missing.fulfillmentId, "registered_at=now()-interval '73 hours'");
    await recordReadResult(client, await leaseDeliveryRegistration(client, missing.fulfillmentId), readOf(await dbTime(client), NOT_FOUND));
    expect(await openKindsOf(client, missing.fulfillmentId)).toEqual(['tracking_not_found']);
    await readStatus(client, missing.fulfillmentId, 'in_transit', 1);
    expect(await openKindsOf(client, missing.fulfillmentId)).toEqual([]);
    expect(await attention(client, missing.fulfillmentId)).toEqual([
      expect.objectContaining({ kind: 'tracking_not_found', resolution: 'auto', resolved_by: null }),
    ]);
  }],

  ['delivered・直し・取消・OFFは開いた全種類をautoで閉じる', async (client) => {
    const actor = await enableDeliveryTracking(client);
    const kinds = ['delivery_failure', 'attempted_delivery', 'tracking_not_found', 'tracking_registration_failed', 'tracking_stalled'];
    // OFF はほかの行の前提（ON）を外すので最後に置く
    for (const cause of ['delivered', '直し', '取消', 'OFF'] as const) {
      const target = await trackedShipment(client, { state: 'registered', notifyCustomer: false });
      for (const kind of kinds) await insertDeliveryAttention(client, target.fulfillmentId, kind);
      if (cause === 'delivered') {
        const at = await dbTime(client, '-1 hours');
        await recordReadResult(client, await leaseDeliveryRegistration(client, target.fulfillmentId),
          readOf(await dbTime(client), { status: 'delivered', happened_at: at, delivered_at: at }));
      } else if (cause === '直し') await updateDeliveryTracking(client, editOf(target));
      else if (cause === '取消') await cancelFulfillment(client, target);
      else await setDeliveryTracking(client, false, actor.id);
      const rows = await attention(client, target.fulfillmentId);
      expect(rows).toHaveLength(kinds.length);
      for (const row of rows) {
        expect(row).toMatchObject({ resolution: 'auto', resolved_by: null });
        expect(row.resolved_at).not.toBeNull();
      }
    }
  }],

  ['expires_at=nowの行はever_registered=false/trueとも期限切れで止まり、trueだけtracking_stalledを開く', async (client) => {
    await enableDeliveryTracking(client);
    const never = await trackedShipment(client, { state: 'pending' });
    const once = await trackedShipment(client, { state: 'registered' });
    const dailyRetry = await trackedShipment(client, { state: 'failed', everRegistered: false });
    const later = await trackedShipment(client, { state: 'registered' });
    for (const target of [never, once, dailyRetry]) await patchDeliveryRegistration(client, target.fulfillmentId, 'expires_at=now()');
    await patchDeliveryRegistration(client, later.fulfillmentId, "expires_at=now()+interval '1 second'");
    const recordsBefore = [] as Array<Record<string, unknown>>;
    for (const target of [never, once, dailyRetry, later]) recordsBefore.push(await deliveryRecord(client, target.fulfillmentId));
    expect(await expireDelivery(client, 1000)).toBeGreaterThanOrEqual(3);
    for (const target of [never, once, dailyRetry]) {
      expect(await deliveryRegistration(client, target.fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'expired', lease_token: null });
    }
    expect(await deliveryRegistration(client, later.fulfillmentId)).toMatchObject({ state: 'registered', stop_reason: null });
    expect(await openKindsOf(client, never.fulfillmentId)).toEqual([]);
    expect(await openKindsOf(client, once.fulfillmentId)).toEqual(['tracking_stalled']);
    expect(await openKindsOf(client, dailyRetry.fulfillmentId)).toEqual([]);
    expect(await openKindsOf(client, later.fulfillmentId)).toEqual([]);
    // 期限切れは発送の記録（配送業者・番号・版・状況）に触れない
    const recordsAfter = [] as Array<Record<string, unknown>>;
    for (const target of [never, once, dailyRetry, later]) recordsAfter.push(await deliveryRecord(client, target.fulfillmentId));
    expect(recordsAfter).toEqual(recordsBefore);
  }],

  ['STOPPEDの合図→読み直しがdeliveredならstopped/delivered、未配達ならstopped/provider_stoppedとtracking_stalled', async (client) => {
    await enableDeliveryTracking(client);
    for (const outcome of ['delivered', 'in_transit'] as const) {
      const target = await trackedShipment(client, { state: 'registered' });
      const before = await deliveryRegistration(client, target.fulfillmentId);
      expect(await signalDelivery(client, [{ carrier: 100062, number: target.trackingNumber.toLowerCase(), event: 'TRACKING_STOPPED' }])).toBe(1);
      const signaled = await deliveryRegistration(client, target.fulfillmentId);
      expect(signaled).toMatchObject({ state: 'registered', stop_signaled: true });
      expect(Number(signaled.signal_revision)).toBe(Number(before.signal_revision) + 1);
      expect(iso(signaled.next_run_at)).toBe(await dbTime(client));
      const [claim] = await claimDeliveryFor(client, [target.fulfillmentId]);
      expect(claim).toMatchObject({ action: 'read' });
      expect(Number(claim.signal_revision)).toBe(Number(signaled.signal_revision));
      const at = await dbTime(client, '-1 hours');
      const result = await recordReadResult(client, claim, readOf(await dbTime(client), outcome === 'delivered'
        ? { status: 'delivered', happened_at: at, delivered_at: at } : { happened_at: at }));
      expect(result).toMatchObject({ applied: true, changed: true, stopped: true });
      const registration = await deliveryRegistration(client, target.fulfillmentId);
      if (outcome === 'delivered') {
        expect(registration).toMatchObject({ state: 'stopped', stop_reason: 'delivered', provider_stop_pending: false });
        expect(await openKindsOf(client, target.fulfillmentId)).toEqual([]);
        expect(await deliveryRecord(client, target.fulfillmentId)).toMatchObject({ delivery_status: 'delivered' });
      } else {
        expect(registration).toMatchObject({ state: 'stopped', stop_reason: 'provider_stopped', provider_stop_pending: false });
        expect(await openKindsOf(client, target.fulfillmentId)).toEqual(['tracking_stalled']);
        expect(await deliveryRecord(client, target.fulfillmentId)).toMatchObject({ delivery_status: 'in_transit' });
      }
    }
  }],

  ['知らない組・止めた行・registeredでない行への知らせは更新0。yamatoの同じ番号とsagawaの番号を混同しない', async (client) => {
    await enableDeliveryTracking(client);
    const number = uniqueNumber('SAME');
    const yamato = await trackedShipment(client, { trackingNumber: number, state: 'registered' });
    const sagawa = await trackedShipment(client, { trackingNumber: number.toLowerCase(), carrier: 'sagawa', state: 'registered' });
    const gone = await trackedShipment(client, { trackingNumber: uniqueNumber('GONE'), state: 'stopped', stopReason: 'expired', everRegistered: true });
    const waiting = await trackedShipment(client, { trackingNumber: uniqueNumber('WAIT'), state: 'pending' });
    const all = [yamato, sagawa, gone, waiting];
    for (const target of all) await patchDeliveryRegistration(client, target.fulfillmentId, "next_run_at=now()+interval '1 day'");
    const snapshot = async () => Promise.all(all.map((target) => deliveryRegistration(client, target.fulfillmentId)));
    const before = await snapshot();
    const signal = (carrier: number, value: string, event: 'TRACKING_UPDATED' | 'TRACKING_STOPPED' = 'TRACKING_UPDATED') =>
      signalDelivery(client, [{ carrier, number: value, event }]);
    // 知らない組、止めた行、まだ登録していない行は何も変えない
    expect(await signal(10021, number)).toBe(0);
    expect(await signal(100062, gone.trackingNumber.toLowerCase())).toBe(0);
    expect(await signal(100062, waiting.trackingNumber)).toBe(0);
    expect(await snapshot()).toEqual(before);
    // yamato の番号はyamato の行だけ、sagawa の番号はsagawa の行だけを今にする（大文字小文字は問わない）
    expect(await signal(100062, number.toLowerCase())).toBe(1);
    const afterYamato = await snapshot();
    expect(Number(afterYamato[0].signal_revision)).toBe(Number(before[0].signal_revision) + 1);
    expect(iso(afterYamato[0].next_run_at)).toBe(await dbTime(client));
    expect(afterYamato[1]).toEqual(before[1]);
    expect(await signal(100040, number)).toBe(1);
    const afterSagawa = await snapshot();
    expect(Number(afterSagawa[1].signal_revision)).toBe(Number(before[1].signal_revision) + 1);
    expect(iso(afterSagawa[1].next_run_at)).toBe(await dbTime(client));
    expect(afterSagawa[0]).toEqual(afterYamato[0]);
    expect(afterSagawa[2]).toEqual(before[2]);
    expect(afterSagawa[3]).toEqual(before[3]);
  }],

  ['同じcarrierでab-1/AB-1の2発送は合図が2件、1発送の取消の外の停止は0回', async (client) => {
    await enableDeliveryTracking(client);
    const base = uniqueNumber('AB');
    const lower = await trackedShipment(client, { trackingNumber: base.toLowerCase(), state: 'registered', everRegistered: true });
    const upper = await trackedShipment(client, { trackingNumber: base.toUpperCase(), state: 'registered', everRegistered: true });
    const before = [await deliveryRegistration(client, lower.fulfillmentId), await deliveryRegistration(client, upper.fulfillmentId)];
    expect(await signalDelivery(client, [{ carrier: 100062, number: `${base.slice(0, 3).toUpperCase()}${base.slice(3).toLowerCase()}`, event: 'TRACKING_UPDATED' }])).toBe(2);
    const after = [await deliveryRegistration(client, lower.fulfillmentId), await deliveryRegistration(client, upper.fulfillmentId)];
    for (const [index, row] of after.entries()) expect(Number(row.signal_revision)).toBe(Number(before[index].signal_revision) + 1);

    await cancelFulfillment(client, lower);
    expect(await deliveryRegistration(client, lower.fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'cancelled', provider_stop_pending: false });
    const claims = await claimDeliveryFor(client, [lower.fulfillmentId, upper.fulfillmentId]);
    expect(claims.filter((claim) => claim.action === 'stop')).toEqual([]);
    expect(claims).toEqual([expect.objectContaining({ fulfillment_id: upper.fulfillmentId, action: 'read' })]);

    // 最後の1発送を取り消した時だけ、外への停止を1回借りられる
    await cancelFulfillment(client, upper);
    const last = await claimDeliveryFor(client, [lower.fulfillmentId, upper.fulfillmentId]);
    expect(last).toEqual([expect.objectContaining({ fulfillment_id: upper.fulfillmentId, action: 'stop' })]);
  }],

  ['配達中・配達済みのメールは通知OFFで0通、ONで各1通、別の版はまた各1通', async (client) => {
    await enableDeliveryTracking(client);
    for (const notify of [false, true]) {
      const target = await trackedShipment(client, { state: 'registered', notifyCustomer: notify });
      const mailsOf = async (kind: string) => (await emails(client, target.fulfillmentId))
        .filter((row) => row.kind === kind).map((row) => row.tracking_version as number);
      // 同じ版の中で配達中が2回出ても、配達済みが出ても、種類ごとに1通
      const run = async (version: number, base: number) => {
        for (const [index, status] of ['out_for_delivery', 'in_transit', 'out_for_delivery', 'delivered'].entries()) {
          const at = await dbTime(client, `-${base - index} hours`);
          const result = await recordReadResult(client, await leaseDeliveryRegistration(client, target.fulfillmentId, version),
            readOf(await dbTime(client), { status, happened_at: at, delivered_at: status === 'delivered' ? at : null }));
          expect(result).toMatchObject({ applied: true, changed: true });
        }
      };
      await run(1, 9);
      expect(await mailsOf('out_for_delivery')).toEqual(notify ? [1] : []);
      expect(await mailsOf('delivered')).toEqual(notify ? [1] : []);
      await updateDeliveryTracking(client, editOf(target, { notifyCustomer: notify }));
      await patchDeliveryRegistration(client, target.fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 2);
      await run(2, 5);
      expect(await mailsOf('out_for_delivery')).toEqual(notify ? [1, 2] : []);
      expect(await mailsOf('delivered')).toEqual(notify ? [1, 2] : []);
    }
  }],
];

describeLocalDb('integration: 配送の追跡の関数（移行 C）', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  test.each(TABLE_ROWS)('%s', async (_name, scenario) => { await scenario(db()); });

  // ---------------- 借りる ----------------

  test('失効したleaseを借り直し、前のtokenは書けない', async () => {
    await enableDeliveryTracking(db());
    const reclaim = async (fulfillmentId: string, action: string) => {
      const [first] = await claimDeliveryFor(db(), [fulfillmentId]);
      expect(first).toMatchObject({ action });
      // 借りている間は、ほかの借り出しに渡さない
      expect(await claimDeliveryFor(db(), [fulfillmentId])).toEqual([]);
      await patchDeliveryRegistration(db(), fulfillmentId, "lease_expires_at=now()-interval '1 second'");
      const [second] = await claimDeliveryFor(db(), [fulfillmentId]);
      expect(second).toMatchObject({ action, fulfillment_id: fulfillmentId });
      expect(second.lease_token).not.toBe(first.lease_token);
      return { first, second };
    };

    const registering = await trackedShipment(db(), { state: 'pending' });
    const register = await reclaim(registering.fulfillmentId, 'register');
    const oldTokenResult = await recordRegistrationResult(db(), register.first, 'registered');
    expect(oldTokenResult.applied).toBe(false);
    expect(await deliveryRegistration(db(), registering.fulfillmentId)).toMatchObject({ state: 'pending', lease_token: register.second.lease_token });
    expect((await recordRegistrationResult(db(), register.second, 'registered')).applied).toBe(true);

    const reading = await trackedShipment(db(), { state: 'registered' });
    const read = await reclaim(reading.fulfillmentId, 'read');
    const oldRead = await recordReadResult(db(), read.first, readOf(await dbTime(db()), { status: 'out_for_delivery' }));
    expect(oldRead.applied).toBe(false);
    expect(await deliveryRecord(db(), reading.fulfillmentId)).toMatchObject({ delivery_status: 'confirmed' });
    expect((await recordReadResult(db(), read.second, readOf(await dbTime(db())))).applied).toBe(true);

    const stopping = await trackedShipment(db(), { state: 'stopped', stopReason: 'cancelled', everRegistered: true });
    await patchDeliveryRegistration(db(), stopping.fulfillmentId, 'provider_stop_pending=true');
    const stop = await reclaim(stopping.fulfillmentId, 'stop');
    expect(await recordStopResult(db(), stop.first, true)).toBe(false);
    expect(await deliveryRegistration(db(), stopping.fulfillmentId)).toMatchObject({ provider_stop_pending: true });
    expect(await recordStopResult(db(), stop.second, true)).toBe(true);
  });

  test('借りている間の合図を次の読み直しへ残す', async () => {
    await enableDeliveryTracking(db());
    const signaled = await trackedShipment(db(), { state: 'registered' });
    const quiet = await trackedShipment(db(), { state: 'registered' });
    const claims = await claimDeliveryFor(db(), [signaled.fulfillmentId, quiet.fulfillmentId]);
    expect(claims.map((claim) => claim.action)).toEqual(['read', 'read']);
    const signaledClaim = claims.find((claim) => claim.fulfillment_id === signaled.fulfillmentId) as DeliveryClaim;
    const quietClaim = claims.find((claim) => claim.fulfillment_id === quiet.fulfillmentId) as DeliveryClaim;
    expect(await signalDelivery(db(), [{ carrier: 100062, number: signaled.trackingNumber, event: 'TRACKING_UPDATED' }])).toBe(1);
    const during = await deliveryRegistration(db(), signaled.fulfillmentId);
    expect(Number(during.signal_revision)).toBe(Number(signaledClaim.signal_revision) + 1);
    // 合図は借りを奪わない（読み直しの結果はそのまま書ける）
    expect(during.lease_token).toBe(signaledClaim.lease_token);
    const now = await dbTime(db());
    expect(await recordReadResult(db(), signaledClaim, readOf(now))).toMatchObject({ applied: true });
    expect(await recordReadResult(db(), quietClaim, readOf(now))).toMatchObject({ applied: true });
    const next_run_at = iso((await deliveryRegistration(db(), signaled.fulfillmentId)).next_run_at);
    expect(next_run_at).toBe(now);
    expect(await deliveryRegistration(db(), signaled.fulfillmentId)).toMatchObject({ state: 'registered', read_attempts: 0, lease_token: null });
    // 合図が無かった行は、通常の6時間後
    const quietRow = await deliveryRegistration(db(), quiet.fulfillmentId);
    expect(iso(quietRow.next_run_at)).toBe(await dbTime(db(), '6 hours'));
    expect(quietRow.read_attempts).toBe(0);
  });

  test('借りている間に来たSTOPPEDの合図は、次の読み直しまで消費しない', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'registered' });
    const [claim] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(await signalDelivery(db(), [{ carrier: 100062, number: target.trackingNumber, event: 'TRACKING_STOPPED' }])).toBe(1);
    const first = await recordReadResult(db(), claim, readOf(await dbTime(db()), { happened_at: await dbTime(db(), '-3 hours') }));
    expect(first).toMatchObject({ applied: true, stopped: false });
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toMatchObject({ state: 'registered', stop_signaled: true });
    expect(iso((await deliveryRegistration(db(), target.fulfillmentId)).next_run_at)).toBe(await dbTime(db()));
    // 合図の後に借り直した読み直しで止める
    const [again] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(Number(again.signal_revision)).toBeGreaterThan(Number(claim.signal_revision));
    const second = await recordReadResult(db(), again, readOf(await dbTime(db()), { happened_at: await dbTime(db(), '-2 hours') }));
    expect(second).toMatchObject({ applied: true, stopped: true });
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'provider_stopped' });
    expect(await openKindsOf(db(), target.fulfillmentId)).toEqual(['tracking_stalled']);
  });

  test('共有する番号の停止と新しい登録を直列に扱う', async () => {
    await enableDeliveryTracking(db());
    // 同じ組のほかの追跡中の行があれば、外への停止は借りず、印を外す
    const shared = uniqueNumber('PAIR');
    const stopped = await trackedShipment(db(), { trackingNumber: shared, state: 'stopped', stopReason: 'cancelled', everRegistered: true });
    await patchDeliveryRegistration(db(), stopped.fulfillmentId, 'provider_stop_pending=true');
    const active = await trackedShipment(db(), { trackingNumber: shared.toLowerCase(), state: 'registered' });
    await patchDeliveryRegistration(db(), active.fulfillmentId, "next_run_at=now()+interval '1 day'");
    const stopClaimWhileOtherActive = await claimDeliveryFor(db(), [stopped.fulfillmentId, active.fulfillmentId]);
    expect(stopClaimWhileOtherActive).toEqual([]);
    expect(await deliveryRegistration(db(), stopped.fulfillmentId)).toMatchObject({ state: 'stopped', provider_stop_pending: false });

    // 外への停止を借りている間は、同じ組の新しい登録を借りない。結果を書いた後でretrackする
    const lone = uniqueNumber('LONE');
    const last = await trackedShipment(db(), { trackingNumber: lone, state: 'stopped', stopReason: 'cancelled', everRegistered: true });
    await patchDeliveryRegistration(db(), last.fulfillmentId, 'provider_stop_pending=true');
    const [stopLease] = await claimDeliveryFor(db(), [last.fulfillmentId]);
    expect(stopLease).toMatchObject({ action: 'stop', carrier: 'yamato', tracking_number: lone.toUpperCase() });
    const fresh = await trackedShipment(db(), { trackingNumber: lone.toLowerCase(), state: 'pending' });
    const registerClaimWhileStopLeased = await claimDeliveryFor(db(), [fresh.fulfillmentId]);
    expect(registerClaimWhileStopLeased).toEqual([]);
    expect(await recordStopResult(db(), stopLease, true)).toBe(true);
    const [retrack] = await claimDeliveryFor(db(), [fresh.fulfillmentId]);
    expect(retrack).toMatchObject({ action: 'retrack', carrier: 'yamato', tracking_number: lone.toUpperCase() });
  });

  test.each(['直し', '取消'] as const)('配達済みで止めた版を%sても、外への停止は借りない', async (operation) => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'registered' });
    await markDeliveryDelivered(db(), manualOf(target));
    if (operation === '直し') await updateDeliveryTracking(db(), editOf(target));
    else await cancelFulfillment(db(), target);
    const claims = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(claims.filter((claim) => claim.action === 'stop')).toEqual([]);
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toMatchObject({
      state: 'stopped', stop_reason: 'delivered', provider_stop_pending: false,
    });
  });

  test('番号の大文字・小文字だけを直した時（abc-1→ABC-1）は、新しい版を含めて止めていない行があるので外への停止を借りず、印を外す', async () => {
    await enableDeliveryTracking(db());
    const base = uniqueNumber('abc');
    const target = await trackedShipment(db(), { trackingNumber: base.toLowerCase(), state: 'registered', everRegistered: true });
    await updateDeliveryTracking(db(), editOf(target, { carrier: 'yamato', trackingNumber: base.toUpperCase() }));
    // 直す時は、新しい版の行がまだ無いので、直す前の版に外への停止の印が立つ（移行 B の決まり）
    expect(await deliveryRegistration(db(), target.fulfillmentId, 1)).toMatchObject({ state: 'stopped', stop_reason: 'replaced', provider_stop_pending: true });
    expect(await deliveryRegistration(db(), target.fulfillmentId, 2)).toMatchObject({ state: 'pending', tracking_number: base.toUpperCase() });
    const claims = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(claims.filter((claim) => claim.action === 'stop')).toEqual([]);
    expect(await deliveryRegistration(db(), target.fulfillmentId, 1)).toMatchObject({ state: 'stopped', stop_reason: 'replaced', provider_stop_pending: false });
  });

  test('別の発送が同じ組を追っている間は、直した発送の外への停止を借りず、残っていた印も外す', async () => {
    await enableDeliveryTracking(db());
    const base = uniqueNumber('MOVE');
    const target = await trackedShipment(db(), { trackingNumber: base, state: 'registered', everRegistered: true });
    const other = await trackedShipment(db(), { trackingNumber: base.toLowerCase(), state: 'registered', everRegistered: true });
    await patchDeliveryRegistration(db(), other.fulfillmentId, "next_run_at=now()+interval '1 day'");
    // 別の発送が同じ組を追っている間に、1発送だけ直す。外への停止の印は立たない（移行 B）
    await updateDeliveryTracking(db(), editOf(target));
    expect(await deliveryRegistration(db(), target.fulfillmentId, 1)).toMatchObject({ provider_stop_pending: false });
    // 別の発送の行の印が残っていても借り出しで外れる（行が増えた後の確かめ直し）
    await patchDeliveryRegistration(db(), target.fulfillmentId, 'provider_stop_pending=true');
    expect((await claimDeliveryFor(db(), [target.fulfillmentId, other.fulfillmentId])).filter((claim) => claim.action === 'stop')).toEqual([]);
    expect(await deliveryRegistration(db(), target.fulfillmentId, 1)).toMatchObject({ provider_stop_pending: false });
  });

  test.each(['delivered', 'expired', 'cancelled'])('止まった組（%s）を再び追う行はretrack', async (stopReason) => {
    await enableDeliveryTracking(db());
    const number = uniqueNumber('AGAIN');
    await trackedShipment(db(), { trackingNumber: number, state: 'stopped', stopReason, everRegistered: true });
    const next = await trackedShipment(db(), { trackingNumber: number.toLowerCase(), state: 'pending' });
    const [claim] = await claimDeliveryFor(db(), [next.fulfillmentId]);
    expect(claim).toMatchObject({ action: 'retrack', carrier: 'yamato', tracking_number: number.toUpperCase(), tracking_version: 1 });
  });

  test('別の追跡中の行があれば、止まった履歴のある組でもregister（既登録の成功で共有）', async () => {
    await enableDeliveryTracking(db());
    const number = uniqueNumber('JOIN');
    await trackedShipment(db(), { trackingNumber: number, state: 'stopped', stopReason: 'expired', everRegistered: true });
    const active = await trackedShipment(db(), { trackingNumber: number, state: 'registered' });
    await patchDeliveryRegistration(db(), active.fulfillmentId, "next_run_at=now()+interval '1 day'");
    const next = await trackedShipment(db(), { trackingNumber: number.toLowerCase(), state: 'pending' });
    const [claim] = await claimDeliveryFor(db(), [next.fulfillmentId]);
    expect(claim).toMatchObject({ action: 'register', tracking_number: number.toUpperCase() });
  });

  test('借りた行は借りの印と、その時の合図の番号・失敗の数を返す', async () => {
    await enableDeliveryTracking(db());
    const registering = await trackedShipment(db(), { state: 'pending' });
    await patchDeliveryRegistration(db(), registering.fulfillmentId, 'attempts=2');
    const reading = await trackedShipment(db(), { state: 'registered' });
    await patchDeliveryRegistration(db(), reading.fulfillmentId, 'read_attempts=3,signal_revision=7');
    const claims = await claimDeliveryFor(db(), [registering.fulfillmentId, reading.fulfillmentId]);
    expect(claims).toHaveLength(2);
    const register = claims.find((claim) => claim.fulfillment_id === registering.fulfillmentId) as DeliveryClaim;
    const read = claims.find((claim) => claim.fulfillment_id === reading.fulfillmentId) as DeliveryClaim;
    expect(Object.keys(register)).toEqual(['fulfillment_id', 'tracking_version', 'carrier', 'tracking_number', 'action', 'lease_token',
      'signal_revision', 'attempts', 'read_attempts', 'expires_at']);
    expect(register).toMatchObject({ action: 'register', attempts: 2, read_attempts: 0, tracking_number: registering.trackingNumber });
    expect(read).toMatchObject({ action: 'read', attempts: 0, read_attempts: 3 });
    expect(Number(read.signal_revision)).toBe(7);
    expect(iso(read.expires_at)).toBe(iso((await deliveryRegistration(db(), reading.fulfillmentId)).expires_at));
    const row = await deliveryRegistration(db(), reading.fulfillmentId);
    expect(row.lease_token).toBe(read.lease_token);
    expect(Number(row.claimed_signal_revision)).toBe(7);
    // 借りの長さは lease_seconds
    expect(iso(row.lease_expires_at)).toBe(await dbTime(db(), '60 seconds'));
  });

  test('借りる件数は上限までで、時刻が来ていない行・期限切れの失敗は借りない', async () => {
    await enableDeliveryTracking(db());
    const due = [] as Array<Awaited<ReturnType<typeof trackedShipment>>>;
    for (let index = 0; index < 3; index += 1) due.push(await trackedShipment(db(), { state: 'pending' }));
    const future = await trackedShipment(db(), { state: 'pending' });
    await patchDeliveryRegistration(db(), future.fulfillmentId, "next_run_at=now()+interval '1 hour'");
    const stale = await trackedShipment(db(), { state: 'failed', everRegistered: false });
    await patchDeliveryRegistration(db(), stale.fulfillmentId, "expires_at=now()-interval '1 second'");
    const ids = [...due, future, stale].map((target) => target.fulfillmentId);
    const claimed = await claimDeliveryFor(db(), ids, { limit: 40 });
    expect(claimed.map((claim) => claim.fulfillment_id).sort()).toEqual(due.map((target) => target.fulfillmentId).sort());
    // limit=1 は1行だけ
    await patchDeliveryRegistration(db(), future.fulfillmentId, 'next_run_at=now()');
    for (const target of due) await patchDeliveryRegistration(db(), target.fulfillmentId, 'lease_token=null,lease_expires_at=null');
    expect(await claimDelivery(db(), { limit: 1 })).toHaveLength(1);
  });

  test.each([
    ['limit=0', 0, 60], ['limit=41', 41, 60], ['limit=NULL', null, 60],
    ['lease=29', 1, 29], ['lease=301', 1, 301], ['lease=NULL', 1, null],
  ] as const)('claimは範囲の外の引数（%s）を断る', async (_name, limit, lease) => {
    await expectDeliveryRejected(db(), () => db().query('select * from public.claim_delivery_tracking($1,$2)', [limit, lease]), 'DELIVERY_ARGUMENT_INVALID', '22023');
  });

  test.each([0, 1001, null])('expireは範囲の外の引数（%s）を断る', async (limit) => {
    await expectDeliveryRejected(db(), () => db().query('select public.expire_delivery_tracking($1)', [limit]), 'DELIVERY_ARGUMENT_INVALID', '22023');
  });

  // ---------------- 登録の結果 ----------------

  test('番号だけの失敗はinvalid_numberで試し直さない', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'pending' });
    const [claim] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(claim).toMatchObject({ action: 'register', attempts: 0, tracking_number: target.trackingNumber.toUpperCase() });
    expect(await recordRegistrationResult(db(), claim, 'invalid_number', 'invalid_number')).toEqual({ applied: true, state: 'failed' });
    const row = await deliveryRegistration(db(), target.fulfillmentId);
    expect(row).toMatchObject({ state: 'failed', failure_kind: 'invalid_number', retry_allowed: false, lease_token: null });
    const openKinds = await openKindsOf(db(), target.fulfillmentId);
    expect(openKinds).toEqual(['tracking_not_found']);
    // 時刻が来ても、1日1回の試し直しにも入らない
    await patchDeliveryRegistration(db(), target.fulfillmentId, "next_run_at=now()-interval '2 days'");
    expect(await claimDeliveryFor(db(), [target.fulfillmentId])).toEqual([]);
  });

  test('口座の失敗はattemptsを使わずattentionも開かない', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'pending' });
    await patchDeliveryRegistration(db(), target.fulfillmentId, 'attempts=2');
    const beforeAttempts = 2;
    const attentionBefore = await attentionTotal(db());
    // 6回続けても、失敗の数は増えず、発送ごとの要対応は開かない
    for (let round = 0; round < 6; round += 1) {
      const [claim] = await claimDeliveryFor(db(), [target.fulfillmentId]);
      expect(claim).toMatchObject({ action: 'register', attempts: beforeAttempts });
      expect(await recordRegistrationResult(db(), claim, 'account', 'account_error')).toEqual({ applied: true, state: 'pending' });
      const row = await deliveryRegistration(db(), target.fulfillmentId);
      expect(row).toMatchObject({ state: 'pending', attempts: beforeAttempts, failure_kind: null, lease_token: null });
      expect(iso(row.next_run_at)).toBe(await dbTime(db(), '6 hours'));
      expect(await openKindsOf(db(), target.fulfillmentId)).toEqual([]);
      await patchDeliveryRegistration(db(), target.fulfillmentId, 'next_run_at=now()');
    }
    expect(await attentionTotal(db())).toBe(attentionBefore);
  });

  test('一時の失敗5回の後も1日1回回復できる', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'pending' });
    const due = () => patchDeliveryRegistration(db(), target.fulfillmentId, 'next_run_at=now()');
    // 失敗した時点から 5分・15分・1時間・6時間。5回目の前は pending のまま、要対応も開かない
    for (const [index, delay] of ['5 minutes', '15 minutes', '1 hour', '6 hours'].entries()) {
      const [claim] = await claimDeliveryFor(db(), [target.fulfillmentId]);
      expect(claim).toMatchObject({ action: 'register', attempts: index });
      expect(await recordRegistrationResult(db(), claim, 'transient', 'http_503')).toEqual({ applied: true, state: 'pending' });
      const row = await deliveryRegistration(db(), target.fulfillmentId);
      expect(row).toMatchObject({ state: 'pending', attempts: index + 1, lease_token: null });
      expect(iso(row.next_run_at)).toBe(await dbTime(db(), delay));
      expect(await openKindsOf(db(), target.fulfillmentId)).toEqual([]);
      await due();
    }
    const [fifth] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(fifth).toMatchObject({ action: 'register', attempts: 4 });
    expect(await recordRegistrationResult(db(), fifth, 'transient', 'http_503')).toEqual({ applied: true, state: 'failed' });
    const failed = await deliveryRegistration(db(), target.fulfillmentId);
    expect(failed).toMatchObject({ state: 'failed', failure_kind: 'repeated_error', retry_allowed: true, attempts: 5 });
    const retryAt = iso(failed.next_run_at);
    const fifthFailurePlus24Hours = await dbTime(db(), '24 hours');
    expect(retryAt).toBe(fifthFailurePlus24Hours);
    expect(await openKindsOf(db(), target.fulfillmentId)).toEqual(['tracking_registration_failed']);

    // 24時間たつまで借りず、たつと1日1回借りる。続けて失敗しても要対応は1行のまま、また24時間後
    expect(await claimDeliveryFor(db(), [target.fulfillmentId])).toEqual([]);
    await due();
    const [daily] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(daily).toMatchObject({ action: 'register', attempts: 5 });
    expect(await recordRegistrationResult(db(), daily, 'transient', 'http_503')).toEqual({ applied: true, state: 'failed' });
    expect(iso((await deliveryRegistration(db(), target.fulfillmentId)).next_run_at)).toBe(await dbTime(db(), '24 hours'));
    expect(await attention(db(), target.fulfillmentId)).toHaveLength(1);

    // 回復すると registered に戻り、登録失敗の要対応を自動で閉じる
    await due();
    const [recovery] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(await recordRegistrationResult(db(), recovery, 'registered')).toEqual({ applied: true, state: 'registered' });
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toMatchObject({
      state: 'registered', failure_kind: null, attempts: 0, ever_registered: true, retry_allowed: true,
    });
    expect(await attention(db(), target.fulfillmentId)).toEqual([
      expect.objectContaining({ kind: 'tracking_registration_failed', resolution: 'auto', resolved_by: null }),
    ]);
  });

  test('retrackの2回目は日次の試し直しもしない', async () => {
    await enableDeliveryTracking(db());
    const first = uniqueNumber('abc');
    const target = await trackedShipment(db(), { trackingNumber: first, state: 'registered', everRegistered: true });
    // 番号を直して、前の番号の外への停止を1回済ませてから、元の番号へ戻す
    await updateDeliveryTracking(db(), editOf(target, { carrier: 'yamato', trackingNumber: uniqueNumber('def') }));
    const stops = (await claimDeliveryFor(db(), [target.fulfillmentId])).filter((claim) => claim.action === 'stop');
    expect(stops).toHaveLength(1);
    expect(await recordStopResult(db(), stops[0], true)).toBe(true);
    await updateDeliveryTracking(db(), editOf(target, { carrier: 'yamato', trackingNumber: first }));
    const [retrack] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(retrack).toMatchObject({ action: 'retrack', tracking_version: 3, tracking_number: first.toUpperCase() });
    expect(await recordRegistrationResult(db(), retrack, 'retrack_exhausted', 'retrack_limit')).toEqual({ applied: true, state: 'failed' });
    const row = await deliveryRegistration(db(), target.fulfillmentId, 3);
    expect(row.retry_allowed).toBe(false);
    expect(row).toMatchObject({ state: 'failed', failure_kind: 'repeated_error' });
    expect(await openKindsOf(db(), target.fulfillmentId)).toEqual(['tracking_registration_failed']);
    await patchDeliveryRegistration(db(), target.fulfillmentId, "next_run_at=now()-interval '2 days'", 3);
    expect(await claimDeliveryFor(db(), [target.fulfillmentId])).toEqual([]);
  });

  test('登録の成功はregisteredにして今すぐ1回読み、初回のregistered_atを保つ', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'pending' });
    await patchDeliveryRegistration(db(), target.fulfillmentId, 'attempts=3');
    const [claim] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(await recordRegistrationResult(db(), claim, 'registered')).toEqual({ applied: true, state: 'registered' });
    const row = await deliveryRegistration(db(), target.fulfillmentId);
    expect(row).toMatchObject({ state: 'registered', failure_kind: null, attempts: 0, ever_registered: true, lease_token: null });
    expect(iso(row.registered_at)).toBe(await dbTime(db()));
    expect(iso(row.next_run_at)).toBe(await dbTime(db()));
    expect(await claimDeliveryFor(db(), [target.fulfillmentId])).toEqual([expect.objectContaining({ action: 'read' })]);
    // 2回目の成功（読み直しで登録待ちに戻った後など）は初回の registered_at を動かさない
    await patchDeliveryRegistration(db(), target.fulfillmentId,
      "state='pending',lease_token=null,lease_expires_at=null,registered_at=now()-interval '1 day',next_run_at=now()");
    const [again] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    await recordRegistrationResult(db(), again, 'registered');
    expect(iso((await deliveryRegistration(db(), target.fulfillmentId)).registered_at)).toBe(await dbTime(db(), '-1 day'));
  });

  test('オフ→オンでfailed/invalid_numberの行もpendingに戻った後、もう一度番号が正しくなければtracking_not_foundが開き直る', async () => {
    const actor = await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'pending' });
    const [claim] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    await recordRegistrationResult(db(), claim, 'invalid_number', 'invalid_number');
    expect(await openKindsOf(db(), target.fulfillmentId)).toEqual(['tracking_not_found']);
    await setDeliveryTracking(db(), false, actor.id);
    expect(await openKindsOf(db(), target.fulfillmentId)).toEqual([]);
    await setDeliveryTracking(db(), true, actor.id);
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toMatchObject({
      state: 'pending', failure_kind: null, retry_allowed: true, attempts: 0,
    });
    const [again] = await claimDeliveryFor(db(), [target.fulfillmentId]);
    expect(again).toMatchObject({ action: 'register', attempts: 0 });
    expect(await recordRegistrationResult(db(), again, 'invalid_number', 'invalid_number')).toEqual({ applied: true, state: 'failed' });
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toMatchObject({ state: 'failed', failure_kind: 'invalid_number', retry_allowed: false });
    const rows = (await attention(db(), target.fulfillmentId)).filter((row) => row.kind === 'tracking_not_found');
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.resolved_at === null)).toHaveLength(1);
    expect(rows.find((row) => row.resolved_at !== null)).toMatchObject({ resolution: 'auto' });
  });

  // ---------------- 読み直しの結果 ----------------

  test('古いtrackingだけを比べ、直す前の時刻を受け取れる', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'registered' });
    // 版1に、後で受け取る時刻より新しい tracking の出来事を残す（版をまたいで比べないことを確かめる）
    const newestOfVersion1 = await dbTime(db(), '-1 hours');
    expect(await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), readOf(newestOfVersion1)))
      .toMatchObject({ applied: true, changed: true });
    await updateDeliveryTracking(db(), editOf(target));
    const edited = await deliveryRecord(db(), target.fulfillmentId);
    expect(edited).toMatchObject({ tracking_version: 2, delivery_status: 'confirmed' });
    expect(iso(edited.delivery_status_at)).toBe(await dbTime(db()));
    // 版2を追跡中にして、直した時刻（tracking_edit の出来事）より前の時刻を受け取る
    await patchDeliveryRegistration(db(), target.fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 2);
    const providerTimeBeforeEdit = await dbTime(db(), '-3 hours');
    const result = await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId, 2),
      readOf(await dbTime(db()), { happened_at: providerTimeBeforeEdit }));
    expect(result).toMatchObject({ applied: true, changed: true });
    const afterEdit = await deliveryRecord(db(), target.fulfillmentId);
    expect(afterEdit.delivery_status).toBe('in_transit');
    expect(iso(afterEdit.delivery_status_at)).toBe(providerTimeBeforeEdit);
    const version2 = (await trackingEvents(db(), target.fulfillmentId)).filter((row) => row.tracking_version === 2);
    expect(version2.map((row) => iso(row.happened_at))).toEqual([providerTimeBeforeEdit]);
  });

  test('同じ状況と古い出来事はイベントもメールも増やさない', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'registered', notifyCustomer: true });
    expect(await readStatus(db(), target.fulfillmentId, 'out_for_delivery', 5, { provider_status: 'OutForDelivery', provider_sub_status: 'OutForDelivery_001' }))
      .toMatchObject({ applied: true, changed: true });
    const eventsBefore = (await deliveryEvents(db(), target.fulfillmentId)).length;
    const emailsBefore = (await emails(db(), target.fulfillmentId)).length;
    const recordBefore = await deliveryRecord(db(), target.fulfillmentId);
    // 同じ状況（時刻は新しい）: 状況もイベントもメールも変えず、読んだ記号と時刻だけ更新する
    expect(await readStatus(db(), target.fulfillmentId, 'out_for_delivery', 4, { provider_status: 'OutForDelivery', provider_sub_status: 'OutForDelivery_002' }))
      .toMatchObject({ applied: true, changed: false });
    const registration = await deliveryRegistration(db(), target.fulfillmentId);
    expect(registration).toMatchObject({ provider_status: 'OutForDelivery', provider_sub_status: 'OutForDelivery_002', state: 'registered' });
    expect(iso(registration.last_read_at)).toBe(await dbTime(db()));
    // 古い出来事（最後の tracking の出来事より前）: 配達済みでも何も動かさない
    expect(await readStatus(db(), target.fulfillmentId, 'delivered', 6, { delivered_at: await dbTime(db(), '-6 hours') }))
      .toMatchObject({ applied: true, changed: false });
    const eventDelta = (await deliveryEvents(db(), target.fulfillmentId)).length - eventsBefore;
    const emailDelta = (await emails(db(), target.fulfillmentId)).length - emailsBefore;
    expect(eventDelta).toBe(0);
    expect(emailDelta).toBe(0);
    expect(await deliveryRecord(db(), target.fulfillmentId)).toEqual(recordBefore);
    expect(await deliveryRegistration(db(), target.fulfillmentId)).toMatchObject({ state: 'registered', stop_reason: null });
  });

  test('未知の状態（status=NULL）はproviderの記号とlast_read_atだけ更新し、状況・イベント・メールは変えない', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'registered', notifyCustomer: true });
    const lease = await leaseDeliveryRegistration(db(), target.fulfillmentId);
    const before = await observe(db(), target.fulfillmentId);
    const now = await dbTime(db());
    const result = await recordReadResult(db(), lease, readOf(now, {
      status: null, provider_status: 'BrandNew', provider_sub_status: 'BrandNew_001', happened_at: null,
    }));
    expect(result).toMatchObject({ applied: true, changed: false });
    const after = await observe(db(), target.fulfillmentId);
    expectSame(after, before, ['record', 'events', 'attention', 'emails']);
    expect(after.registrations[0]).toMatchObject({ state: 'registered', provider_status: 'BrandNew', provider_sub_status: 'BrandNew_001', read_attempts: 0 });
    expect(iso(after.registrations[0].last_read_at)).toBe(now);
    expect(iso(after.registrations[0].next_run_at)).toBe(await dbTime(db(), '6 hours'));
  });

  test('not_registeredは登録待ちへ戻し、今すぐ登録し直す（ever_registered・registered_atは保つ）', async () => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'registered' });
    await patchDeliveryRegistration(db(), target.fulfillmentId, "registered_at=now()-interval '2 days'");
    const before = await deliveryRegistration(db(), target.fulfillmentId);
    const lease = await leaseDeliveryRegistration(db(), target.fulfillmentId);
    const now = await dbTime(db());
    const result = await recordReadResult(db(), lease, readOf(now, {
      outcome: 'not_registered', status: null, provider_status: null, provider_sub_status: null, happened_at: null,
    }));
    expect(result).toMatchObject({ applied: true, changed: false });
    const row = await deliveryRegistration(db(), target.fulfillmentId);
    expect(row).toMatchObject({ state: 'pending', ever_registered: true, lease_token: null });
    expect(row.registered_at).toEqual(before.registered_at);
    expect(iso(row.next_run_at)).toBe(now);
    expect(await deliveryRecord(db(), target.fulfillmentId)).toMatchObject({ delivery_status: 'confirmed' });
  });

  test.each([
    ['transient', 0, 1, '5 minutes'], ['transient', 1, 2, '15 minutes'], ['transient', 2, 3, '1 hour'],
    ['transient', 3, 4, '6 hours'], ['transient', 4, 5, '6 hours'], ['account', 2, 2, '6 hours'],
  ] as const)('読み直しの%sは前の状況を保ち、read_attemptsが%s→%s、次は%s後', async (outcome, beforeAttempts, afterAttempts, delay) => {
    await enableDeliveryTracking(db());
    const target = await trackedShipment(db(), { state: 'registered', notifyCustomer: true });
    await patchDeliveryRegistration(db(), target.fulfillmentId, 'read_attempts=$3', 1, [beforeAttempts]);
    const lease = await leaseDeliveryRegistration(db(), target.fulfillmentId);
    const before = await observe(db(), target.fulfillmentId);
    const result = await recordReadResult(db(), lease, readOf(await dbTime(db()), {
      outcome, status: null, provider_status: null, provider_sub_status: null, happened_at: null,
      error_code: outcome === 'account' ? 'account_error' : 'http_503',
    }));
    expect(result).toMatchObject({ applied: true, changed: false });
    const after = await observe(db(), target.fulfillmentId);
    expectSame(after, before, ['record', 'events', 'attention', 'emails']);
    expect(after.registrations[0]).toMatchObject({ state: 'registered', read_attempts: afterAttempts, lease_token: null });
    expect(iso(after.registrations[0].next_run_at)).toBe(await dbTime(db(), delay));
  });

  test.each([
    '読み直し（配達済み）', '読み直し（版2・輸送中）', '登録の結果', '期限切れ',
  ] as const)('%sは配送業者・番号・版・通知を変えない', async (operation) => {
    await enableDeliveryTracking(db());
    const mixed = `MixedCase-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const target = await trackedShipment(db(), {
      carrier: 'japanpost', trackingNumber: mixed, notifyCustomer: true, state: operation === '登録の結果' ? 'pending' : 'registered',
    });
    let version = 1;
    if (operation === '読み直し（版2・輸送中）') {
      await updateDeliveryTracking(db(), editOf(target, { carrier: 'sagawa', trackingNumber: `${mixed}-2`, notifyCustomer: true }));
      await patchDeliveryRegistration(db(), target.fulfillmentId, "state='registered',ever_registered=true,registered_at=now()", 2);
      version = 2;
    }
    const keep = async () => {
      const record = await deliveryRecord(db(), target.fulfillmentId);
      return {
        shipping_carrier: record.shipping_carrier, tracking_number: record.tracking_number,
        tracking_version: record.tracking_version, notify_customer: record.notify_customer,
      };
    };
    const before = await keep();
    expect(before).toMatchObject({ tracking_version: version });
    const now = await dbTime(db());
    if (operation === '読み直し（配達済み）') {
      await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId), readOf(now, { status: 'delivered', delivered_at: now }));
    } else if (operation === '読み直し（版2・輸送中）') {
      await recordReadResult(db(), await leaseDeliveryRegistration(db(), target.fulfillmentId, 2), readOf(now));
    } else if (operation === '登録の結果') {
      const [claim] = await claimDeliveryFor(db(), [target.fulfillmentId]);
      await recordRegistrationResult(db(), claim, 'registered');
    } else {
      await patchDeliveryRegistration(db(), target.fulfillmentId, 'expires_at=now()');
      expect(await expireDelivery(db(), 1000)).toBeGreaterThanOrEqual(1);
    }
    expect(await keep()).toEqual(before);
  });

  // 申し送り（Task 2 から）: 本文はそのまま
  test('追跡結果でも配送業者・番号・版は変わらない（申し送り・移行 C 依存）', async () => {
    const target = await deliveryShipment(db(), { trackingNumber: 'MixedCase-123', notifyCustomer: true });
    await setDeliveryTracking(db(), true, target.actorId);
    const token = randomUUID();
    await db().query(`update private.fulfillment_tracking_registrations set state='registered',ever_registered=true,
      registered_at=now(),lease_token=$2,lease_expires_at=now()+interval '5 minutes',claimed_signal_revision=signal_revision where fulfillment_id=$1`, [target.fulfillmentId, token]);
    const before = await deliveryRecord(db(), target.fulfillmentId);
    const result = { outcome: 'ok', status: 'delivered', provider_status: 'Delivered', provider_sub_status: 'Delivered_001',
      happened_at: iso(target.clock.now), delivered_at: iso(target.clock.now), read_at: iso(target.clock.now), error_code: null };
    const saved = (await db().query('select * from public.record_delivery_read_result($1,1,$2,$3::jsonb)', [target.fulfillmentId, token, JSON.stringify(result)])).rows[0];
    expect(saved).toMatchObject({ applied: true, changed: true, stopped: true });
    expect(await deliveryRecord(db(), target.fulfillmentId)).toMatchObject({ shipping_carrier: before.shipping_carrier,
      tracking_number: before.tracking_number, tracking_version: before.tracking_version, delivery_status: 'delivered' });
  });

  // ---------------- 外への停止の結果・要対応・枠・権限 ----------------

  test('外への停止の結果は1回でpendingを外し、前のtokenでは書けず、失敗でも再び借りない', async () => {
    await enableDeliveryTracking(db());
    const make = async () => {
      const target = await trackedShipment(db(), { state: 'stopped', stopReason: 'cancelled', everRegistered: true });
      await patchDeliveryRegistration(db(), target.fulfillmentId, 'provider_stop_pending=true');
      return target;
    };
    const succeeded = await make();
    const [claim] = await claimDeliveryFor(db(), [succeeded.fulfillmentId]);
    expect(claim).toMatchObject({ action: 'stop' });
    expect(await recordStopResult(db(), { ...claim, lease_token: randomUUID() }, true)).toBe(false);
    expect(await deliveryRegistration(db(), succeeded.fulfillmentId)).toMatchObject({ provider_stop_pending: true });
    expect(await recordStopResult(db(), claim, true)).toBe(true);
    const row = await deliveryRegistration(db(), succeeded.fulfillmentId);
    expect(row).toMatchObject({ state: 'stopped', stop_reason: 'cancelled', provider_stop_pending: false, lease_token: null, lease_expires_at: null });
    expect(row.provider_stop_attempted_at).not.toBeNull();
    expect(await claimDeliveryFor(db(), [succeeded.fulfillmentId])).toEqual([]);

    const failedOnce = await make();
    const [failedClaim] = await claimDeliveryFor(db(), [failedOnce.fulfillmentId]);
    expect(await recordStopResult(db(), failedClaim, false, 'http_500')).toBe(true);
    expect(await deliveryRegistration(db(), failedOnce.fulfillmentId)).toMatchObject({ state: 'stopped', provider_stop_pending: false, lease_token: null });
    await patchDeliveryRegistration(db(), failedOnce.fulfillmentId, 'next_run_at=now()');
    expect(await claimDeliveryFor(db(), [failedOnce.fulfillmentId])).toEqual([]);
  });

  test('private.set_delivery_attentionは重ねて開いても1行で、閉じた後は新しい行を開く', async () => {
    const target = await trackedShipment(db(), { state: 'registered' });
    const set = (open: boolean) => db().query('select private.set_delivery_attention($1,$2,$3)', [target.fulfillmentId, 'tracking_stalled', open]);
    await set(true);
    await set(true);
    expect(await attention(db(), target.fulfillmentId)).toHaveLength(1);
    await set(false);
    expect(await attention(db(), target.fulfillmentId)).toEqual([expect.objectContaining({ resolution: 'auto', resolved_by: null })]);
    await set(false);
    await set(true);
    const rows = await attention(db(), target.fulfillmentId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.resolved_at === null)).toHaveLength(1);
  });

  test('provider枠は334msずつずらして予約する（1つの取引の中）', async () => {
    await db().query('update private.delivery_tracking_provider_gate set next_call_at=now()');
    const waits = [] as number[];
    for (let index = 0; index < 3; index += 1) {
      waits.push((await db().query('select public.take_delivery_provider_slot() as wait_ms')).rows[0].wait_ms as number);
    }
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBeGreaterThanOrEqual(300);
    expect(waits[1]).toBeLessThanOrEqual(334);
    expect(waits[2]).toBeGreaterThanOrEqual(600);
    expect(waits[2]).toBeLessThanOrEqual(668);
  });

  test('追跡のpublic関数はservice_role専用で、private補助は誰にも公開しない', async () => {
    const signatures = [
      'public.claim_delivery_tracking(integer,integer)',
      'public.record_delivery_registration_result(uuid,integer,uuid,text,text)',
      'public.record_delivery_read_result(uuid,integer,uuid,jsonb)',
      'public.signal_delivery_tracking(jsonb)',
      'public.expire_delivery_tracking(integer)',
      'public.record_delivery_stop_result(uuid,integer,uuid,boolean,text)',
      'public.take_delivery_provider_slot()',
    ];
    for (const signature of signatures) {
      const definition = (await db().query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature])).rows[0];
      expect(definition.prosecdef).toBe(true);
      expect(definition.proconfig).toContain('search_path=""');
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db().query('select has_function_privilege($1::text,$2::text,\'EXECUTE\') as allowed', [role, signature])).rows[0].allowed).toBe(role === 'service_role');
      }
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db().query('select has_function_privilege($1::text,$2::text,\'EXECUTE\') as allowed', [role, 'private.set_delivery_attention(uuid,text,boolean)'])).rows[0].allowed).toBe(false);
    }
  });

  describe('2接続の借り出しと枠（commitした見本は次のresetで捨てる）', () => {
    test('2接続のclaimは同じ行も同じ組も借りない', async () => {
      await withDeliveryConnections(async (first, second) => {
        await first.query('begin');
        await enableDeliveryTracking(first);
        const shared = uniqueNumber('SHARED');
        const targets = [] as Array<Awaited<ReturnType<typeof trackedShipment>>>;
        for (const trackingNumber of [uniqueNumber('LONE'), uniqueNumber('LONE'), shared, shared.toLowerCase(), shared.slice(0, 7) + shared.slice(7).toLowerCase()]) {
          const target = await trackedShipment(first, { state: 'pending', trackingNumber });
          // 他の試験が commit した行より先に借りられるよう、古い時刻にしておく
          await patchDeliveryRegistration(first, target.fulfillmentId, "next_run_at=now()-interval '1 day'");
          targets.push(target);
        }
        await first.query('commit');
        const ids = targets.map((target) => target.fulfillmentId);

        // 開いた取引の間にもう1接続が借りても、同じ行も同じ組も渡らない
        await first.query('begin');
        await second.query('begin');
        const byFirst = await claimDeliveryFor(first, ids);
        const bySecond = await claimDeliveryFor(second, ids);
        await first.query('commit');
        await second.query('commit');
        const intersectionOfClaims = byFirst.filter((claim) => bySecond.some((other) => other.fulfillment_id === claim.fulfillment_id));
        expect(intersectionOfClaims).toEqual([]);
        expect(byFirst.map(pairOf).filter((pair) => bySecond.map(pairOf).includes(pair))).toEqual([]);
        // 先に借りた接続は、別の組は全部、同じ組は1行だけを借りる
        expect(byFirst).toHaveLength(3);
        expect(new Set(byFirst.map(pairOf)).size).toBe(3);
        expect(bySecond).toEqual([]);

        // 同時に借りても同じ（取り合いで落ちる行はあっても、行も組も重ならず、どの組も1回は借りられる）
        await first.query('update private.fulfillment_tracking_registrations set lease_token=null,lease_expires_at=null where fulfillment_id=any($1::uuid[])', [ids]);
        await first.query('begin');
        await second.query('begin');
        const [a, b] = await Promise.all([claimDeliveryFor(first, ids), claimDeliveryFor(second, ids)]);
        await first.query('commit');
        await second.query('commit');
        const claimed = [...a, ...b];
        expect(new Set(claimed.map((claim) => claim.fulfillment_id)).size).toBe(claimed.length);
        expect(claimed.map(pairOf).sort()).toEqual([...new Set(targets.map((target) => `${target.carrier}:${target.trackingNumber.toUpperCase()}`))].sort());
      });
    });

    test('2接続でも、外への停止を借りている間は同じ組の新しい登録を借りない', async () => {
      await withDeliveryConnections(async (first, second) => {
        await first.query('begin');
        await enableDeliveryTracking(first);
        const number = uniqueNumber('PAIR');
        const stopping = await trackedShipment(first, { trackingNumber: number, state: 'stopped', stopReason: 'cancelled', everRegistered: true });
        await patchDeliveryRegistration(first, stopping.fulfillmentId, "provider_stop_pending=true,next_run_at=now()-interval '1 day'");
        await first.query('commit');

        await first.query('begin');
        const [stopLease] = await claimDeliveryFor(first, [stopping.fulfillmentId]);
        expect(stopLease).toMatchObject({ action: 'stop' });
        // 停止を借りた後に、同じ組の新しい登録ができる（先にあると、止めていない行があるので停止は渡らない）。
        // first が組の鍵を持っている間は、新しい登録の時刻が来ても借りられない
        const fresh = await trackedShipment(second, { trackingNumber: number.toLowerCase(), state: 'pending' });
        await second.query('begin');
        expect(await claimDeliveryFor(second, [fresh.fulfillmentId])).toEqual([]);
        await second.query('commit');
        await first.query('commit');
        // commit の後も、停止の借りが有効な間は借りられない
        await second.query('begin');
        expect(await claimDeliveryFor(second, [fresh.fulfillmentId])).toEqual([]);
        await second.query('commit');
        expect(await recordStopResult(second, stopLease, true)).toBe(true);
        await second.query('begin');
        expect(await claimDeliveryFor(second, [fresh.fulfillmentId])).toEqual([expect.objectContaining({ action: 'retrack' })]);
        await second.query('commit');
      });
    });

    test('1秒のprovider枠を4接続が取ると、予約時刻の差は334ms以上で、1秒に最大3開始', async () => {
      await withDeliveryConnectionPool(4, async (clients) => {
        await clients[0].query('update private.delivery_tracking_provider_gate set next_call_at=now()');
        const taken = await Promise.all(clients.map(async (client) => {
          await client.query('begin');
          try {
            const waited = (await client.query('select public.take_delivery_provider_slot() as wait_ms')).rows[0].wait_ms as number;
            // 行の鍵を持ったまま、この接続が予約した後の枠の時刻を読む（次の接続は commit まで待つ）
            const gate = (await client.query(
              'select (extract(epoch from next_call_at) * 1000)::float8 as ms from private.delivery_tracking_provider_gate',
            )).rows[0].ms as number;
            await client.query('commit');
            return { waited, gate };
          } catch (error) {
            await client.query('rollback');
            throw error;
          }
        }));
        const gates = taken.map((entry) => entry.gate).sort((left, right) => left - right);
        for (let index = 0; index < gates.length - 1; index += 1) {
          // float8 のミリ秒で µs まで表せる。334ms ちょうどの差を許す
          expect(gates[index + 1] - gates[index]).toBeGreaterThanOrEqual(334 - 0.01);
        }
        // 4つの予約が1秒に収まらない（1秒に最大3開始）
        expect(gates[3] - gates[0]).toBeGreaterThanOrEqual(3 * 334 - 0.03);
        expect(taken.filter((entry) => entry.waited === 0).length).toBeLessThanOrEqual(1);
      });
    });
  });
});
