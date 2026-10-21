/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/orders/tracking/delivery-store', () => ({
  ...jest.requireActual('@/lib/orders/tracking/delivery-store'),
  getDeliveryTrackingSettings: jest.fn(), claimDeliveryTracking: jest.fn(), expireDeliveryTracking: jest.fn(),
  takeDeliveryProviderSlot: jest.fn(), recordDeliveryRegistrationResult: jest.fn(),
  recordDeliveryReadResult: jest.fn(), recordDeliveryStopResult: jest.fn(),
}));
jest.mock('@/lib/orders/tracking/delivery-config', () => ({ readDeliveryTrackingConfig: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/ops/ops-store', () => ({ recordHeartbeat: jest.fn() }));
jest.mock('@/lib/orders/tracking/delivery-ops', () => ({ reportDeliveryTrackingIssue: jest.fn() }));
jest.mock('@/lib/orders/tracking/seventeen-track-client', () => ({ createSeventeenTrackClient: jest.fn() }));

import { processDeliveryTracking, runDeliveryTrackingWorker, DELIVERY_TRACKING_POLL_SECONDS } from '@/lib/orders/tracking/delivery-worker';
import * as db from '@/lib/orders/tracking/delivery-store';
import { readDeliveryTrackingConfig } from '@/lib/orders/tracking/delivery-config';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { recordHeartbeat } from '@/lib/ops/ops-store';
import { createSeventeenTrackClient, type ProviderPair, type ProviderItemResult } from '@/lib/orders/tracking/seventeen-track-client';
import type { DeliveryReadResult, TrackingClaim, TrackingAction } from '@/lib/orders/tracking/delivery-types';

const settings = jest.mocked(db.getDeliveryTrackingSettings);
const claimRows = jest.mocked(db.claimDeliveryTracking);
const expire = jest.mocked(db.expireDeliveryTracking);
const slot = jest.mocked(db.takeDeliveryProviderSlot);
const registration = jest.mocked(db.recordDeliveryRegistrationResult);
const readResult = jest.mocked(db.recordDeliveryReadResult);
const stopResult = jest.mocked(db.recordDeliveryStopResult);
const config = jest.mocked(readDeliveryTrackingConfig);
const store = {} as db.DeliveryStore;
const ON = { enabled: true, updatedAt: null, updatedByEmail: null, backfillCount: 0 };
const CONFIG = { apiKey: 'unit-key', baseUrl: 'http://127.0.0.1:4017' };
const at = '2026-10-21T00:00:00.000Z';
const read: DeliveryReadResult = { outcome: 'ok', status: 'in_transit', providerStatus: 'InTransit',
  providerSubStatus: null, happenedAt: at, deliveredAt: null, readAt: at, errorCode: null };
function claim(action: TrackingAction = 'register', n = 1): TrackingClaim {
  return { fulfillmentId: `shipment-${n}`, trackingVersion: 2, carrier: 'yamato', trackingNumber: `unit-${n}`,
    action, leaseToken: `lease-${n}`, signalRevision: 2, attempts: 0, readAttempts: 0, expiresAt: '2026-11-01T00:00:00Z' };
}
function harness() {
  let time = Date.parse(at);
  const starts: number[] = [];
  const answer = (action: TrackingAction) => jest.fn(async (pairs: ProviderPair[]): Promise<ProviderItemResult[]> => {
    starts.push(time);
    return pairs.map((pair) => ({ pair, outcome: action === 'stop' ? 'stopped' : 'registered', errorCode: null, read: action === 'read' ? read : null }));
  });
  const provider = { register: answer('register'), retrack: answer('retrack'), getTrackInfo: answer('read'), stopTrack: answer('stop') };
  const wait = jest.fn(async (ms: number) => { time += ms; });
  const deps = { store, provider, now: () => time, wait, report: jest.fn().mockResolvedValue(undefined) };
  return { deps, provider, starts, advance: (ms: number) => { time += ms; }, run: (budgetMs = 8000) => processDeliveryTracking(deps, { budgetMs }) };
}
beforeEach(() => {
  jest.resetAllMocks();
  settings.mockResolvedValue(ON); config.mockReturnValue(CONFIG);
  claimRows.mockResolvedValue([]); expire.mockResolvedValue(0); slot.mockResolvedValue(0);
  registration.mockResolvedValue({ applied: true, state: 'registered' });
  readResult.mockResolvedValue({ applied: true, changed: true, stopped: false }); stopResult.mockResolvedValue(true);
  jest.mocked(createServiceRoleClient).mockResolvedValue(store as Awaited<ReturnType<typeof createServiceRoleClient>>);
});
afterEach(() => jest.restoreAllMocks());

test('追跡OFFは鍵があってもHTTPを呼ばず鍵なしの知らせも無い', async () => {
  settings.mockResolvedValue({ ...ON, enabled: false });
  const h = harness();
  expect((await h.run()).stoppedBy).toBe('disabled');
  expect(h.starts).toEqual([]); expect(h.deps.report).not.toHaveBeenCalled();
  expect(expire).not.toHaveBeenCalled(); expect(claimRows).not.toHaveBeenCalled();
});
test('ON中の鍵なしは登録と読み直しをせず予定を残す', async () => {
  config.mockReturnValue({ ...CONFIG, apiKey: null });
  const h = harness();
  expect((await h.run()).stoppedBy).toBe('key_missing');
  expect(claimRows).not.toHaveBeenCalled(); expect(expire).not.toHaveBeenCalled();
  expect(h.deps.report).toHaveBeenCalledWith('key_missing');
});
test('claimの後にOFFになったら新しいHTTPを始めない', async () => {
  claimRows.mockResolvedValueOnce([claim()]);
  settings.mockResolvedValueOnce(ON).mockResolvedValue({ ...ON, enabled: false });
  const h = harness();
  expect((await h.run()).stoppedBy).toBe('disabled'); expect(h.starts).toEqual([]);
});
test('枠を待つ間にOFFまたは鍵なしになってもHTTPを始めない', async () => {
  claimRows.mockResolvedValueOnce([claim()]); slot.mockResolvedValue(334);
  const h = harness();
  h.deps.wait.mockImplementation(async (ms) => { h.advance(ms); config.mockReturnValue({ ...CONFIG, apiKey: null }); });
  expect((await h.run()).stoppedBy).toBe('key_missing'); expect(h.starts).toEqual([]);
});
test('同じ組を別発送が使う間はstopTrackを呼ばない', async () => {
  // DBが共有組のstopを渡さず、残った発送のreadだけを渡す契約。
  claimRows.mockResolvedValueOnce([claim('read')]);
  const h = harness(); await h.run();
  expect(h.provider.stopTrack).not.toHaveBeenCalled(); expect(h.provider.getTrackInfo).toHaveBeenCalledTimes(1);
});
test('expire→60秒claim、stop→register→retrack→read、全体で334ms以上の枠を守る', async () => {
  claimRows.mockResolvedValueOnce([claim('read', 4), claim('register', 2), claim('retrack', 3), claim('stop', 1)]);
  expire.mockResolvedValue(3);
  const h = harness();
  expect(await h.run()).toEqual({ registered: 2, read: 1, stopped: 1, expired: 3, stoppedBy: 'empty' });
  expect(expire.mock.invocationCallOrder[0]).toBeLessThan(claimRows.mock.invocationCallOrder[0]);
  expect(claimRows).toHaveBeenCalledWith(store, { limit: 40, leaseSeconds: 60 });
  const methods = [h.provider.stopTrack, h.provider.register, h.provider.retrack, h.provider.getTrackInfo];
  for (let i = 0; i < methods.length - 1; i++) expect(methods[i].mock.invocationCallOrder[0]).toBeLessThan(methods[i + 1].mock.invocationCallOrder[0]);
  expect(h.starts.map((time) => time - h.starts[0])).toEqual([0, 334, 668, 1002]);
  expect(slot).toHaveBeenCalledTimes(4);
  expect(h.provider.register).toHaveBeenCalledWith([{ number: 'UNIT-2', carrier: 100062 }], { timeoutMs: 2500 });
});
test('40件以下の配列で呼び続け、外へ渡すのはnumberとcarrierだけ', async () => {
  claimRows.mockResolvedValueOnce(Array.from({ length: 40 }, (_, i) => claim('register', i)))
    .mockResolvedValueOnce(Array.from({ length: 3 }, (_, i) => claim('register', 40 + i)));
  const h = harness(); expect((await h.run()).registered).toBe(43);
  expect(h.provider.register.mock.calls.map(([pairs]) => pairs.length)).toEqual([40, 3]);
  expect(Object.keys(h.provider.register.mock.calls[0][0][0]).sort()).toEqual(['carrier', 'number']);
});
test.each([
  ['stop', 'stoptrack'], ['register', 'register'], ['retrack', 'retrack'], ['read', 'gettrackinfo'],
] as const)('%sは注入fetchで/%sだけを呼び、実通信しない', async (action, path) => {
  claimRows.mockResolvedValueOnce([claim(action)]);
  const h = harness();
  const fakeFetch = jest.fn(async () => new Response(JSON.stringify({ code: 0, data: {
    accepted: [{ number: 'UNIT-1', carrier: 100062, track_info: { latest_status: { status: 'InTransit' } } }], rejected: [],
  } }), { status: 200 }));
  const actual = jest.requireActual<typeof import('@/lib/orders/tracking/seventeen-track-client')>('@/lib/orders/tracking/seventeen-track-client');
  const provider = actual.createSeventeenTrackClient({ apiKey: 'unit-key', baseUrl: 'http://127.0.0.1:4017',
    fetch: fakeFetch as typeof fetch, timeoutMs: 2500, now: () => new Date(h.deps.now()) });
  await processDeliveryTracking({ ...h.deps, provider }, { budgetMs: 8000 });
  expect(fakeFetch).toHaveBeenCalledTimes(1);
  expect(fakeFetch).toHaveBeenCalledWith(`http://127.0.0.1:4017/${path}`, expect.objectContaining({
    method: 'POST', body: JSON.stringify([{ number: 'UNIT-1', carrier: 100062 }]),
  }));
});
test.each(['register', 'read', 'stop'] as const)('leaseが失効した%sの結果は件数にも知らせにも入れない', async (action) => {
  claimRows.mockResolvedValueOnce([claim(action)]);
  registration.mockResolvedValue({ applied: false, state: null });
  readResult.mockResolvedValue({ applied: false, changed: false, stopped: false }); stopResult.mockResolvedValue(false);
  const h = harness(); const result = await h.run();
  expect([result.registered, result.read, result.stopped]).toEqual([0, 0, 0]);
  expect(h.deps.report).not.toHaveBeenCalled();
});
test('待ちが残りを超える時はHTTPも次の枠予約も始めず終了する', async () => {
  claimRows.mockResolvedValueOnce([claim()]); slot.mockResolvedValue(8001);
  const h = harness(); expect((await h.run()).stoppedBy).toBe('budget');
  expect(h.starts).toEqual([]); expect(h.deps.wait).not.toHaveBeenCalled(); expect(slot).toHaveBeenCalledTimes(1);
});
test('最初の処理からの実時間を予算で数えtimeoutは残り以下、残り500msでは始めない', async () => {
  const h = harness();
  settings.mockImplementation(async () => { h.advance(1000); return ON; });
  claimRows.mockResolvedValueOnce([claim('register'), claim('read', 2)]);
  h.provider.register.mockImplementation(async (pairs) => { h.advance(1500); return pairs.map((pair) => ({ pair, outcome: 'registered', errorCode: null, read: null })); });
  expect((await h.run(3500)).stoppedBy).toBe('budget');
  expect(h.provider.register).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 500 + 1000 });
  expect(h.provider.getTrackInfo).not.toHaveBeenCalled();
});
test.each([499, 500])('残り%smsではexpireも新しいHTTPも始めない', async (budget) => {
  const h = harness(); expect((await h.run(budget)).stoppedBy).toBe('budget');
  expect(expire).not.toHaveBeenCalled(); expect(h.starts).toEqual([]);
});
test('待ち後の残りでtimeoutを決める', async () => {
  claimRows.mockResolvedValueOnce([claim()]); slot.mockResolvedValue(1000);
  const h = harness(); await h.run(3000);
  expect(h.provider.register).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 2000 });
});
test('waitの実時間が予定を超え残り500msになったらHTTPを始めない', async () => {
  claimRows.mockResolvedValueOnce([claim()]); slot.mockResolvedValue(1000);
  const h = harness(); h.deps.wait.mockImplementation(async () => { h.advance(7500); });
  expect((await h.run()).stoppedBy).toBe('budget'); expect(h.starts).toEqual([]);
  expect(slot).toHaveBeenCalledTimes(1);
});
test('2回目のHTTP直前にOFFなら最初のHTTPだけで終了する', async () => {
  claimRows.mockResolvedValueOnce([claim('register'), claim('read', 2)]);
  settings.mockResolvedValueOnce(ON).mockResolvedValueOnce(ON).mockResolvedValue({ ...ON, enabled: false });
  const h = harness(); expect((await h.run()).stoppedBy).toBe('disabled');
  expect(h.provider.register).toHaveBeenCalledTimes(1); expect(h.provider.getTrackInfo).not.toHaveBeenCalled();
});
test('HTTP中のOFFや版変更でDBが不適用なら未知状態も通知しない', async () => {
  const c = { ...claim('read'), readAttempts: 4 }; claimRows.mockResolvedValueOnce([c]);
  readResult.mockResolvedValue({ applied: false, changed: false, stopped: false });
  const h = harness(); h.provider.getTrackInfo.mockResolvedValue([{ pair: { number: 'UNIT-1', carrier: 100062 },
    outcome: 'registered', errorCode: null, read: { ...read, status: null, providerStatus: 'FutureStatus' } }]);
  expect((await h.run()).read).toBe(0); expect(h.deps.report).not.toHaveBeenCalled();
});
test('DBのread結果をprovider_status含めそのまま渡し、未知状態を知らせる', async () => {
  const c = claim('read'); claimRows.mockResolvedValueOnce([c]); const h = harness();
  const unknown = { ...read, status: null, providerStatus: 'FutureStatus' };
  h.provider.getTrackInfo.mockResolvedValue([{ pair: { number: 'UNIT-1', carrier: 100062 }, outcome: 'registered', errorCode: null, read: unknown }]);
  await h.run(); expect(readResult).toHaveBeenCalledWith(store, c, unknown); expect(h.deps.report).toHaveBeenCalledWith('unknown_status');
});
test('not_foundのprovider_statusをworkerで改変しない', async () => {
  const c = claim('read'); claimRows.mockResolvedValueOnce([c]); const h = harness();
  const notFound = { ...read, outcome: 'not_found' as const, status: null, providerStatus: 'NotFound' };
  h.provider.getTrackInfo.mockResolvedValue([{ pair: { number: 'UNIT-1', carrier: 100062 }, outcome: 'not_found', errorCode: null, read: notFound }]);
  await h.run(); expect(readResult).toHaveBeenCalledWith(store, c, notFound);
});
test.each([0, 1, 2, 3, 4, 5])('登録の再試行%d回はDBの予定をworkerで書き換えず渡す', async (attempts) => {
  const c = { ...claim(), attempts }; claimRows.mockResolvedValueOnce([c]); const h = harness();
  h.provider.register.mockResolvedValue([{ pair: { number: 'UNIT-1', carrier: 100062 }, outcome: 'transient', errorCode: '503', read: null }]);
  await h.run(); expect(registration).toHaveBeenCalledWith(store, c, 'transient', '503'); expect(claimRows).toHaveBeenCalledTimes(2);
});
test.each([0, 1, 2, 3, 4])('読取の再試行%d回はDBに任せ連続5回で知らせる', async (readAttempts) => {
  const c = { ...claim('read'), readAttempts }; claimRows.mockResolvedValueOnce([c]); const h = harness();
  const failure = { ...read, outcome: 'transient' as const, status: null, providerStatus: null, errorCode: 'timeout' };
  h.provider.getTrackInfo.mockResolvedValue([{ pair: { number: 'UNIT-1', carrier: 100062 }, outcome: 'transient', errorCode: 'timeout', read: failure }]);
  await h.run(); expect(readResult).toHaveBeenCalledWith(store, c, failure);
  expect(h.deps.report.mock.calls).toEqual(readAttempts === 4 ? [['read_failed']] : []);
  expect(DELIVERY_TRACKING_POLL_SECONDS).toBe(21600);
});
test('retrack exhaustedを通常の日次回復と分けてそのまま記録する', async () => {
  const c = claim('retrack'); claimRows.mockResolvedValueOnce([c]); const h = harness();
  h.provider.retrack.mockResolvedValue([{ pair: { number: 'UNIT-1', carrier: 100062 }, outcome: 'retrack_exhausted', errorCode: '-18019905', read: null }]);
  await h.run(); expect(registration).toHaveBeenCalledWith(store, c, 'retrack_exhausted', '-18019905');
});
test('口座の失敗はDBへaccountを渡し運用へ知らせる', async () => {
  const c = claim(); claimRows.mockResolvedValueOnce([c]); const h = harness();
  h.provider.register.mockResolvedValue([{ pair: { number: 'UNIT-1', carrier: 100062 }, outcome: 'account', errorCode: '401', read: null }]);
  expect((await h.run()).stoppedBy).toBe('error');
  expect(registration).toHaveBeenCalledWith(store, c, 'account', '401'); expect(h.deps.report).toHaveBeenCalledWith('account_error');
});
test.each(['missing', 'duplicate', 'wrong_carrier'] as const)('欠落・矛盾した答え%sは成功と推測しない', async (mode) => {
  const c = claim(); claimRows.mockResolvedValueOnce([c]); const h = harness();
  const item: ProviderItemResult = { pair: { number: 'UNIT-1', carrier: 100062 }, outcome: 'registered', errorCode: null, read: null };
  h.provider.register.mockResolvedValue(mode === 'missing' ? [] : mode === 'duplicate' ? [item, { ...item, outcome: 'transient' }] : [{ ...item, pair: { ...item.pair, carrier: 100040 } }]);
  await h.run(); expect(registration).toHaveBeenCalledWith(store, c, 'transient', 'invalid_response');
});
test('stopのHTTP失敗もtoken付きで記録してregisterへ進む', async () => {
  const c = claim('stop'); claimRows.mockResolvedValueOnce([c, claim('register', 2)]); const h = harness();
  h.provider.stopTrack.mockRejectedValue(new Error('raw本文 unit-key signature UNIT-1'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  await h.run(); expect(stopResult).toHaveBeenCalledWith(store, c, false, 'provider_error');
  expect(h.provider.register).toHaveBeenCalledTimes(1); expect(JSON.stringify(log.mock.calls)).not.toMatch(/raw本文|unit-key|signature|UNIT-1/);
});
test.each(['expire', 'claim', 'slot', 'record', 'settings'] as const)('DBの%sの断りも失敗に数えread_failedへ出す', async (where) => {
  claimRows.mockResolvedValueOnce([claim()]);
  const failure = new db.DeliveryOperationError('DELIVERY_ARGUMENT_INVALID');
  if (where === 'expire') expire.mockRejectedValueOnce(failure);
  if (where === 'claim') claimRows.mockReset().mockRejectedValueOnce(failure);
  if (where === 'slot') slot.mockRejectedValueOnce(failure);
  if (where === 'record') registration.mockRejectedValueOnce(failure);
  if (where === 'settings') settings.mockRejectedValueOnce(failure);
  const h = harness(); const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect((await h.run()).stoppedBy).toBe('error'); expect(h.deps.report).toHaveBeenCalledWith('read_failed');
  expect(JSON.stringify(log.mock.calls)).not.toContain('unit-key');
});
test.each(['disabled', 'key_missing', 'error', 'empty'] as const)('runは%sに合う心拍を残す', async (mode) => {
  const h = harness(); jest.mocked(createSeventeenTrackClient).mockReturnValue(h.provider);
  if (mode === 'disabled') settings.mockResolvedValue({ ...ON, enabled: false });
  if (mode === 'key_missing') config.mockReturnValue({ ...CONFIG, apiKey: null });
  if (mode === 'error') expire.mockRejectedValueOnce(new db.DeliveryStoreError('expire_delivery_tracking', null));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const result = await runDeliveryTrackingWorker(); expect(result.stoppedBy).toBe(mode);
  expect(recordHeartbeat).toHaveBeenCalledWith(store, 'delivery_tracking', mode === 'disabled' || mode === 'empty', mode === 'key_missing' ? 'key_missing' : mode === 'error' ? 'delivery_tracking_error' : null);
});
test('runのDB接続に使った時間も8秒に含める', async () => {
  const h = harness(); jest.spyOn(Date, 'now').mockImplementation(h.deps.now);
  jest.mocked(createServiceRoleClient).mockImplementation(async () => {
    h.advance(7000); return store as Awaited<ReturnType<typeof createServiceRoleClient>>;
  });
  jest.mocked(createSeventeenTrackClient).mockReturnValue(h.provider); claimRows.mockResolvedValueOnce([claim()]);
  await runDeliveryTrackingWorker();
  expect(h.provider.register).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 1000 });
});
