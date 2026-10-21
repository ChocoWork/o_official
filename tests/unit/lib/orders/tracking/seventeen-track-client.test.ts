/** @jest-environment node */
import {
  createSeventeenTrackClient,
  type ProviderPair,
} from '@/lib/orders/tracking/seventeen-track-client';
import fixture from '../../../../fixtures/17track/v2.4.json';

jest.mock('server-only', () => ({}), { virtual: true });

const fakeKey = 'fake-client-key';
const PAIR: ProviderPair = { number: 'AB-1', carrier: 100062 };
const OTHER: ProviderPair = { number: 'AB-1', carrier: 100040 };
const READ_AT = '2026-10-21T04:00:00.000Z';
const METHODS = ['register', 'retrack', 'getTrackInfo', 'stopTrack'] as const;

function envelope(accepted: unknown[] = [], rejected: unknown[] = []) {
  return { code: 0, data: { accepted, rejected } };
}

function rejected(code: number, pair: ProviderPair = PAIR) {
  return { ...pair, error: { code, message: '捨てる本文・鍵・場所' } };
}

function rig(body: unknown = fixture.responses.registered, status = 200, timeoutMs = 1000) {
  const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const client = createSeventeenTrackClient({
    apiKey: fakeKey, baseUrl: 'https://api.17track.net/track/v2.4',
    fetch: fetchMock, timeoutMs, now: () => new Date(READ_AT),
  });
  return { client, fetchMock };
}

function trackingPayload(trackInfo: unknown) {
  return envelope([{ ...PAIR, track_info: trackInfo }]);
}

function trackInfo(status = 'Delivered', subStatus: string | null = null) {
  return {
    latest_status: { status, sub_status: subStatus, sub_status_descr: '捨てる細かい説明' },
    latest_event: { time_iso: '2026-10-21T12:00:00+09:00', description: '捨てる文', location: '捨てる場所' },
    milestone: [] as unknown[],
  };
}

beforeAll(() => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('本物のfetchは禁止');
  });
});
afterAll(() => jest.restoreAllMocks());

describe('17TRACK v2.4の送信', () => {
  test('v2.4へPOSTし番号とcarrierだけを渡す', async () => {
    const { client, fetchMock } = rig();
    const pair = { ...PAIR, description: '送らない', location: '送らない', tag: '送らない' };
    expect(await client.register([pair])).toEqual([{ pair: PAIR, outcome: 'registered', errorCode: null, read: null }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.17track.net/track/v2.4/register');
    expect(JSON.parse(init?.body as string)).toEqual([{ number: 'AB-1', carrier: 100062 }]);
    expect(init?.headers).toMatchObject({ '17token': fakeKey, 'Content-Type': 'application/json' });
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ['register', '/register', fixture.responses.registered, 'registered'],
    ['retrack', '/retrack', fixture.responses.registered, 'registered'],
    ['getTrackInfo', '/gettrackinfo', fixture.responses.inTransit, 'registered'],
    ['stopTrack', '/stoptrack', fixture.responses.stopped, 'stopped'],
  ] as const)('%sは指定されたpathだけを使う', async (method, path, response, outcome) => {
    const { client, fetchMock } = rig(response);
    expect((await client[method]([PAIR]))[0].outcome).toBe(outcome);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.17track.net/track/v2.4${path}`);
  });

  test.each(METHODS)('%sの0件は通信しない', async (method) => {
    const { client, fetchMock } = rig();
    expect(await client[method]([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(METHODS)('%sの41件は通信前に拒否する', async (method) => {
    const { client, fetchMock } = rig();
    await expect(client[method](Array.from({ length: 41 }, (_, i) => ({ ...PAIR, number: `N-${i}` })))).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('40件は1回で送り入力順で返す', async () => {
    const pairs = Array.from({ length: 40 }, (_, i) => ({ ...PAIR, number: `N-${i}` }));
    const { client, fetchMock } = rig(envelope([...pairs].reverse()));
    expect((await client.register(pairs)).map((item) => item.pair)).toEqual(pairs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual(pairs);
  });
});

const CODE_CASES = [
  [-18019901, 'registered'], [-18019904, 'registered'],
  [-18010011, 'invalid_number'], [-18010012, 'invalid_number'], [-18010013, 'invalid_number'],
  [-18010015, 'invalid_number'], [-18019903, 'invalid_number'], [-18019910, 'invalid_number'], [-18019911, 'invalid_number'],
  [-18019905, 'retrack_exhausted'],
  [-18019907, 'account'], [-18019908, 'account'], [-18010001, 'account'], [-18010002, 'account'],
  [-18010004, 'account'], [-18010005, 'account'],
  [-18010003, 'transient'], [-18019815, 'transient'], [-18019816, 'transient'], [-18019817, 'transient'],
  [-99999999, 'transient'], [-18019909, 'not_found'],
] as const;

describe.each(['top', 'rejected'] as const)('%sのエラーコード', (source) => {
  test.each(CODE_CASES)('%s → %s', async (code, outcome) => {
    const body = source === 'top' ? { code, message: '捨てる本文' } : envelope([], [rejected(code)]);
    const { client } = rig(body);
    expect((await client.retrack([PAIR]))[0]).toEqual({ pair: PAIR, outcome, errorCode: String(code), read: null });
  });

  test.each(['getTrackInfo', 'stopTrack'] as const)('-18019902 / %s → not_registered', async (method) => {
    const body = source === 'top' ? { code: -18019902 } : fixture.responses.notRegistered;
    const { client } = rig(body);
    const [result] = await client[method]([PAIR]);
    expect(result).toMatchObject({ pair: PAIR, outcome: 'not_registered', errorCode: '-18019902' });
    expect(result.read).toEqual(method === 'getTrackInfo' ? {
      outcome: 'not_registered', status: null, providerStatus: null, providerSubStatus: null,
      happenedAt: null, deliveredAt: null, readAt: READ_AT, errorCode: '-18019902',
    } : null);
  });

  test('-18019906 / stop → stopped', async () => {
    const { client } = rig(source === 'top' ? { code: -18019906 } : envelope([], [rejected(-18019906)]));
    expect(await client.stopTrack([PAIR])).toEqual([{ pair: PAIR, outcome: 'stopped', errorCode: '-18019906', read: null }]);
  });

  test('-18019904は大文字・小文字だけを直したretrackでも成功', async () => {
    const pair: ProviderPair = { ...PAIR, number: 'ab-1' };
    const { client } = rig(source === 'top' ? { code: -18019904 } : envelope([], [rejected(-18019904, pair)]));
    expect((await client.retrack([pair]))[0]).toMatchObject({ pair, outcome: 'registered' });
  });
});

describe('HTTP・通信・応答の境界', () => {
  test.each([[401, 'account'], [429, 'transient'], [500, 'transient'], [503, 'transient']] as const)('HTTP %s → %s（本文のacceptedより優先）', async (status, outcome) => {
    const { client } = rig(fixture.responses.registered, status);
    expect((await client.register([PAIR]))[0]).toMatchObject({ outcome, errorCode: String(status) });
  });

  test.each([301, 302, 307, 308])('HTTP %sを成功扱いしない', async (status) => {
    const { client, fetchMock } = rig(fixture.responses.registered, status);
    expect((await client.register([PAIR]))[0].outcome).toBe('transient');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });

  test('network失敗はraw errorを含めずtransient', async () => {
    const { client, fetchMock } = rig();
    fetchMock.mockRejectedValueOnce(new Error('捨てる本文・鍵・場所'));
    expect(await client.register([PAIR])).toEqual([{ pair: PAIR, outcome: 'transient', errorCode: 'network', read: null }]);
  });

  test('本文がJSONでない時はtransient', async () => {
    const { client, fetchMock } = rig();
    fetchMock.mockResolvedValueOnce(new Response('<html>捨てる本文</html>'));
    expect((await client.register([PAIR]))[0]).toMatchObject({ outcome: 'transient', errorCode: 'invalid_response' });
  });

  test.each([null, [], {}, { code: '0' }, { code: 0 }, { code: 0, data: { accepted: {}, rejected: [] } }])('壊れたenvelopeはtransient: %j', async (body) => {
    expect((await rig(body).client.register([PAIR]))[0].outcome).toBe('transient');
  });

  test.each([undefined, 25, 200])('AbortControllerのHTTP timeout（call指定 %j がfactory 100msより優先）', async (override) => {
    jest.useFakeTimers();
    try {
      const { client, fetchMock } = rig(undefined, 200, 100);
      let signal: AbortSignal | null | undefined;
      fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        signal = init?.signal;
        signal?.addEventListener('abort', () => reject(new Error('捨てるtimeout本文')), { once: true });
      }));
      const pending = client.getTrackInfo([PAIR], override === undefined ? undefined : { timeoutMs: override });
      await jest.advanceTimersByTimeAsync((override ?? 100) - 1);
      expect(signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect((await pending)[0]).toMatchObject({ outcome: 'transient', errorCode: 'timeout', read: { outcome: 'transient', readAt: READ_AT } });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('本文の読み取り中もtimeoutを有効にする', async () => {
    jest.useFakeTimers();
    try {
      const { client, fetchMock } = rig(undefined, 200, 100);
      fetchMock.mockImplementationOnce(async (_url, init) => {
        const response = new Response('');
        jest.spyOn(response, 'json').mockImplementation(() => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
        }));
        return response;
      });
      const pending = client.register([PAIR]);
      await jest.advanceTimersByTimeAsync(100);
      expect((await pending)[0]).toMatchObject({ outcome: 'transient', errorCode: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('成功後のtimeoutタイマーを解除する', async () => {
    jest.useFakeTimers();
    try {
      expect((await rig().client.register([PAIR]))[0].outcome).toBe('registered');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('番号とcarrierの組の照合', () => {
  test('accepted/rejected混在と順番違いを入力の組へ照合する', async () => {
    const third: ProviderPair = { number: 'JP-3', carrier: 10021 };
    const { client } = rig(envelope([third, PAIR], [rejected(-18019910, OTHER)]));
    expect(await client.register([PAIR, OTHER, third])).toEqual([
      { pair: PAIR, outcome: 'registered', errorCode: null, read: null },
      { pair: OTHER, outcome: 'invalid_number', errorCode: '-18019910', read: null },
      { pair: third, outcome: 'registered', errorCode: null, read: null },
    ]);
  });

  test('トップレベル非0 codeは部分acceptedより優先する', async () => {
    const { client } = rig({ ...envelope([PAIR]), code: -18019908 });
    expect((await client.register([PAIR, OTHER])).map((item) => item.outcome)).toEqual(['account', 'account']);
  });

  test('欠けた組だけをtransientにする', async () => {
    const { client } = rig(envelope([OTHER]));
    expect((await client.register([PAIR, OTHER])).map((item) => item.outcome)).toEqual(['transient', 'registered']);
  });

  test('同じ組のaccepted/rejected矛盾だけをtransientにする', async () => {
    const { client } = rig(envelope([PAIR, OTHER], [rejected(-18019910)]));
    expect((await client.register([PAIR, OTHER])).map((item) => item.outcome)).toEqual(['transient', 'registered']);
  });

  test('同じ組の異なるacceptedの矛盾を成功にしない', async () => {
    const { client } = rig(envelope([
      { ...PAIR, track_info: trackInfo('InTransit') },
      { ...PAIR, track_info: trackInfo('Delivered') },
      { ...OTHER, track_info: trackInfo('Delivered') },
    ]));
    expect((await client.getTrackInfo([PAIR, OTHER])).map((item) => item.outcome)).toEqual(['transient', 'registered']);
  });

  test('1件の不正で別のacceptedを捨てず未要求の組も混ぜない', async () => {
    const { client } = rig(envelope([PAIR, null, { ...OTHER, carrier: '100040' }, { number: 'UNREQUESTED', carrier: 10021 }]));
    expect((await client.register([PAIR, OTHER])).map((item) => item.outcome)).toEqual(['registered', 'transient']);
  });

  test('rejectedのcodeが不正でも別のacceptedを捨てない', async () => {
    const { client } = rig(envelope([PAIR], [{ ...OTHER, error: { code: '捨てる本文' } }]));
    expect((await client.register([PAIR, OTHER])).map((item) => item.outcome)).toEqual(['registered', 'transient']);
  });

  test('番号の大文字・小文字を勝手に変えて照合しない', async () => {
    const { client } = rig(envelope([{ ...PAIR, number: 'ab-1' }]));
    expect((await client.register([PAIR]))[0].outcome).toBe('transient');
  });
});

describe('ためた配送状況の必要な値だけを読む', () => {
  test.each([
    ['inTransit', 'in_transit'], ['outForDelivery', 'out_for_delivery'], ['delivered', 'delivered'],
    ['unknownStatus', null],
  ] as const)('共有見本 %s → %s、getのacceptedはregistered/read.ok', async (name, status) => {
    const [result] = await rig(fixture.responses[name]).client.getTrackInfo([PAIR]);
    expect(result).toMatchObject({ outcome: 'registered', errorCode: null, read: { outcome: 'ok', status, readAt: READ_AT, errorCode: null } });
  });

  test('最新時刻とDelivered milestoneだけを読む', async () => {
    const [result] = await rig(fixture.responses.delivered).client.getTrackInfo([PAIR]);
    expect(result.read).toEqual({
      outcome: 'ok', status: 'delivered', providerStatus: 'Delivered', providerSubStatus: null,
      happenedAt: '2026-10-21T03:00:00.000Z', deliveredAt: '2026-10-21T01:00:00.000Z', readAt: READ_AT, errorCode: null,
    });
    expect(result.read).not.toHaveProperty('location');
    expect(result.read).not.toHaveProperty('description');
    expect(JSON.stringify(result)).not.toMatch(/捨てる|track_info|events|providers|sub_status_descr/);
  });

  test('time_isoをtime_utcより優先しevents全件を使わない', async () => {
    const [result] = await rig(fixture.responses.inTransit).client.getTrackInfo([PAIR]);
    expect(result.read?.happenedAt).toBe('2026-10-21T00:00:00.000Z');
    expect(result.read?.deliveredAt).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/説明書|場所|description|location|events/);
  });

  test.each([
    [{ time_utc: '2026-10-21 02:03:04' }, '2026-10-21T02:03:04.000Z'],
    [{ time_iso: '2026-10-21T03:04:05-05:00' }, '2026-10-21T08:04:05.000Z'],
    [{ time_iso: '2026-10-21T03:04:05Z' }, '2026-10-21T03:04:05.000Z'],
    [{ time_iso: '2026-10-21T03:04:05', time_utc: '2026-10-21 02:03:04' }, '2026-10-21T02:03:04.000Z'],
    [{ time_iso: 'invalid', time_utc: '2026-10-21 02:03:04' }, '2026-10-21T02:03:04.000Z'],
    [{ time_iso: 'invalid', time_utc: 'invalid' }, READ_AT],
    [{ time_iso: '2026-02-30T03:04:05Z', time_utc: '2026-02-30 03:04:05' }, READ_AT],
    [{}, READ_AT],
  ] as const)('時刻 %j → %s（地域に依存しない）', async (event, expected) => {
    const info = { ...trackInfo(), latest_event: event };
    const [result] = await rig(trackingPayload(info)).client.getTrackInfo([PAIR]);
    expect(result.read).toMatchObject({ happenedAt: expected, deliveredAt: expected });
  });

  test('Delivered milestoneのUTC時刻を使い他の段階は使わない', async () => {
    const info = trackInfo();
    info.milestone = [
      { key_stage: 'InTransit', time_iso: '2026-10-22T00:00:00Z' },
      { key_stage: 'Delivered', time_utc: '2026-10-21 01:02:03' },
    ];
    const [result] = await rig(trackingPayload(info)).client.getTrackInfo([PAIR]);
    expect(result.read?.deliveredAt).toBe('2026-10-21T01:02:03.000Z');
  });

  test('読めないDelivered milestoneは最新時刻へ戻す', async () => {
    const info = trackInfo();
    info.milestone = [{ key_stage: 'Delivered', time_iso: 'invalid' }];
    const [result] = await rig(trackingPayload(info)).client.getTrackInfo([PAIR]);
    expect(result.read?.deliveredAt).toBe('2026-10-21T03:00:00.000Z');
  });

  test.each([
    ['FutureStatus', 'FutureSub', null], ['Exception', 'FutureSub', null],
    ['DeliveryFailure', 'FutureSub', null], ['InTransit', 'FutureSub', 'in_transit'],
  ] as const)('Task 4の対応を再利用: %s/%s → %s', async (status, subStatus, expected) => {
    const [result] = await rig(trackingPayload(trackInfo(status, subStatus))).client.getTrackInfo([PAIR]);
    expect(result.read).toMatchObject({ status: expected, providerStatus: status, providerSubStatus: subStatus });
  });

  test.each([
    [fixture.responses.noInformation, 'not_found'],
    [trackingPayload(trackInfo('NotFound')), 'registered'],
    [{ code: -18019909 }, 'not_found'],
  ])('情報なしはnot_foundで出来事と配達時刻をnullにする（外側 %s/%s）', async (body, outcome) => {
    const [result] = await rig(body).client.getTrackInfo([PAIR]);
    expect(result.outcome).toBe(outcome);
    expect(result.read).toMatchObject({ outcome: 'not_found', status: null, happenedAt: null, deliveredAt: null, readAt: READ_AT });
  });

  test('getのaccepted NotFoundも外側のoutcomeはregistered', async () => {
    const [result] = await rig(trackingPayload(trackInfo('NotFound'))).client.getTrackInfo([PAIR]);
    expect(result).toMatchObject({ outcome: 'registered', read: { outcome: 'not_found' } });
  });

  test('getの不正な1件だけtransientとし別のreadを保つ', async () => {
    const { client } = rig(envelope([
      { ...PAIR, track_info: { latest_status: { status: 7 } } },
      { ...OTHER, track_info: trackInfo('OutForDelivery') },
    ]));
    const results = await client.getTrackInfo([PAIR, OTHER]);
    expect(results[0]).toMatchObject({ outcome: 'transient', read: { outcome: 'transient' } });
    expect(results[1]).toMatchObject({ outcome: 'registered', read: { status: 'out_for_delivery' } });
  });

  test('getのacceptedにtrack_infoが無ければ成功の配送結果を作らない', async () => {
    const [result] = await rig().client.getTrackInfo([PAIR]);
    expect(result).toMatchObject({ outcome: 'transient', read: { outcome: 'transient' } });
  });

  test.each([
    [-18019910, 'invalid_number'], [-18019908, 'account'], [-18010003, 'transient'],
  ] as const)('getの失敗 %s をDeliveryReadResult.%sへ変える', async (code, outcome) => {
    const [result] = await rig(envelope([], [rejected(code)])).client.getTrackInfo([PAIR]);
    expect(result.read).toEqual({
      outcome, status: null, providerStatus: null, providerSubStatus: null,
      happenedAt: null, deliveredAt: null, readAt: READ_AT, errorCode: String(code),
    });
    expect(JSON.stringify(result)).not.toContain('捨てる');
  });
});
