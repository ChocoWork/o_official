/** @jest-environment node */
import { createHash } from 'node:crypto';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
      ...init, headers: { 'content-type': 'application/json' },
    }),
  },
}));

const mockStore = { rpc: jest.fn() };
const mockCreateClient = jest.fn();
const mockSettings = jest.fn();
const mockSignal = jest.fn();
const mockSchedule = jest.fn();
const mockReport = jest.fn();
const mockAuthenticate = jest.fn();
const mockCsrf = jest.fn();
const mockRateLimit = jest.fn();
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: () => mockCreateClient() }));
jest.mock('@/lib/orders/tracking/delivery-store', () => ({
  getDeliveryTrackingSettings: (...args: unknown[]) => mockSettings(...args),
  signalDeliveryTracking: (...args: unknown[]) => mockSignal(...args),
}));
jest.mock('@/lib/orders/tracking/delivery-schedule', () => ({ scheduleDeliveryTracking: () => mockSchedule() }));
jest.mock('@/lib/orders/tracking/delivery-ops', () => ({
  reportDeliveryTrackingIssue: (...args: unknown[]) => mockReport(...args),
}));
jest.mock('@/lib/auth/authenticate', () => ({ authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockCsrf(...args) }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock('@/lib/orders/tracking/seventeen-track-signature', () => {
  const actual = jest.requireActual<typeof import('@/lib/orders/tracking/seventeen-track-signature')>(
    '@/lib/orders/tracking/seventeen-track-signature',
  );
  return {
    verifySeventeenTrackSignature: jest.fn(actual.verifySeventeenTrackSignature),
    parseTrackingSignals: jest.fn(actual.parseTrackingSignals),
  };
});

import { POST, runtime } from '@/app/api/webhook/17track/route';
import { parseTrackingSignals, verifySeventeenTrackSignature } from '@/lib/orders/tracking/seventeen-track-signature';

const KEY = 'unit-test-key';
const MAX_BYTES = 1048576;
const UPDATED = { event: 'TRACKING_UPDATED', data: { carrier: 100062, number: 'AB-1' } };
const RAW = Buffer.from(JSON.stringify(UPDATED));
const verify = jest.mocked(verifySeventeenTrackSignature);
const parse = jest.mocked(parseTrackingSignals);

function signature(raw: Uint8Array): string {
  return createHash('sha256').update(raw).update('/').update(KEY).digest('hex');
}

function streamRequest(raw = RAW, options: {
  sign?: string | null; length?: string; chunks?: Uint8Array[]; failAt?: number; cancelFails?: boolean;
} = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.sign !== null) headers.set('sign', options.sign ?? signature(raw));
  if (options.length !== undefined) headers.set('content-length', options.length);
  const chunks = options.chunks ?? [raw];
  let index = 0;
  const readBody = jest.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index === options.failAt) throw new Error('unit-stream-error');
    if (index === chunks.length) controller.close();
    else controller.enqueue(chunks[index++]);
  });
  const cancelBody = jest.fn(() => {
    if (options.cancelFails) throw new Error('unit-cancel-error');
  });
  const body = new ReadableStream<Uint8Array>({ pull: readBody, cancel: cancelBody }, { highWaterMark: 0 });
  // 共通polyfillのnode-fetchはNode streamなので、受信側のWeb streamを明示する。
  const request = new Request('http://localhost/api/webhook/17track', { method: 'POST', headers });
  Object.defineProperty(request, 'body', { value: body });
  return { request, readBody, cancelBody, body };
}

async function expectReceived(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ received: true });
}

describe('POST /api/webhook/17track', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', TRACKING_17TRACK_API_KEY: KEY });
    mockCreateClient.mockResolvedValue(mockStore);
    mockSettings.mockResolvedValue({ enabled: true, updatedAt: null, updatedByEmail: null, backfillCount: 0 });
    mockSignal.mockResolvedValue(1);
    mockReport.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test('Node cryptoを使えるruntimeに固定する', () => { expect(runtime).toBe('nodejs'); });

  test('鍵なしは本文を読む前に503', async () => {
    delete process.env.TRACKING_17TRACK_API_KEY;
    const { request, readBody } = streamRequest(RAW, { length: String(MAX_BYTES + 1) });
    expect((await POST(request)).status).toBe(503);
    expect(readBody).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test.each(['   ', ''])('空白または空の鍵は503（%j）', async (key) => {
    process.env.TRACKING_17TRACK_API_KEY = key;
    const { request, readBody } = streamRequest();
    expect((await POST(request)).status).toBe(503);
    expect(readBody).not.toHaveBeenCalled();
  });

  test.each(['http://provider.invalid', 'not-a-url'])('不正な設定URLは鍵なしと同じ503（%s）', async (url) => {
    process.env.TRACKING_17TRACK_BASE_URL = url;
    const { request, readBody } = streamRequest();
    expect((await POST(request)).status).toBe(503);
    expect(readBody).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test('1048576 bytesは受け、1048577 bytesは署名前に413', async () => {
    const atLimit = Buffer.concat([RAW, Buffer.alloc(MAX_BYTES - RAW.byteLength, ' ')]);
    await expectReceived(await POST(streamRequest(atLimit).request));
    verify.mockClear();
    parse.mockClear();
    mockCreateClient.mockClear();
    const overLimit = await POST(streamRequest(Buffer.concat([atLimit, Buffer.from(' ')]), { sign: 'invalid' }).request);
    expect(overLimit.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test.each([undefined, '1'])('Content-Lengthなし/偽の小さい値でも実bytesで413（%s）', async (length) => {
    const { request, cancelBody } = streamRequest(Buffer.alloc(MAX_BYTES + 1), { length });
    expect((await POST(request)).status).toBe(413);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  test('Content-Lengthが大きければ本文を読む前に413', async () => {
    const { request, readBody } = streamRequest(RAW, { length: String(MAX_BYTES + 1) });
    expect((await POST(request)).status).toBe(413);
    expect(readBody).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  test('分割streamは累計上限を越えた所でcancelし、残りを読まない', async () => {
    const { request, readBody, cancelBody, body } = streamRequest(RAW, {
      chunks: [Buffer.alloc(MAX_BYTES / 2), Buffer.alloc(MAX_BYTES / 2), Buffer.from('x'), Buffer.from('unread')],
    });
    expect((await POST(request)).status).toBe(413);
    expect(readBody).toHaveBeenCalledTimes(3);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  test('上限でcancelが失敗しても413を保つ', async () => {
    expect((await POST(streamRequest(Buffer.alloc(MAX_BYTES + 1), { cancelFails: true }).request)).status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  test('途中のstream失敗は400で署名とDBへ進まない', async () => {
    const { request, body } = streamRequest(RAW, { chunks: [RAW], failAt: 1 });
    expect((await POST(request)).status).toBe(400);
    expect(body.locked).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test('不正JSONでも署名が違えば先に401', async () => {
    const response = await POST(streamRequest(Buffer.from('{broken'), { sign: '0'.repeat(64) }).request);
    expect(response.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
    expect(mockSettings).not.toHaveBeenCalled();
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledWith(mockStore, 'signature_invalid');
  });

  test.each([null, 'short', 'g'.repeat(64), '0'.repeat(64)])('署名なし/形式不正/不一致は401として1回数える（%s）', async (sign) => {
    expect((await POST(streamRequest(RAW, { sign }).request)).status).toBe(401);
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(mockStore, 'signature_invalid');
    expect(mockSettings).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test.each(['client', 'report'])('署名401の計数が失敗しても401（%s）', async (failure) => {
    const error = new Error('unit-report-error');
    if (failure === 'client') mockCreateClient.mockRejectedValueOnce(error);
    else mockReport.mockRejectedValueOnce(error);
    expect((await POST(streamRequest(RAW, { sign: null }).request)).status).toBe(401);
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test('署名が合っていてJSONが読めないなら400', async () => {
    expect((await POST(streamRequest(Buffer.from('{broken')).request)).status).toBe(400);
    expect(verify).toHaveReturnedWith(true);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });

  test('署名の後にUTF-8を検査し、不正なbytesは400', async () => {
    const raw = Buffer.concat([Buffer.from('{"event":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect((await POST(streamRequest(raw).request)).status).toBe(400);
    expect(verify).toHaveReturnedWith(true);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test.each([null, 1, {}, { event: 1 }, { event: 'TRACKING_UPDATED' },
    { event: 'TRACKING_UPDATED', data: { carrier: '100062', number: 'AB-1' } },
    { event: 'TRACKING_UPDATED', data: { carrier: 100062 } },
    { event: 'TRACKING_UPDATED', data: { carrier: 100062, number: ' ' } },
    [UPDATED, null],
  ])('壊れた必須構造は400で部分的にも書かない（%j）', async (payload) => {
    expect((await POST(streamRequest(Buffer.from(JSON.stringify(payload))).request)).status).toBe(400);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockSignal).not.toHaveBeenCalled();
  });

  test('OFFでも署名は確かめ、合う知らせだけ200で無視', async () => {
    mockSettings.mockResolvedValue({ enabled: false });
    await expectReceived(await POST(streamRequest().request));
    expect((await POST(streamRequest(RAW, { sign: null }).request)).status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(mockSettings).toHaveBeenCalledTimes(1);
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test('OFFでも署名後にJSONと必須構造を検査する', async () => {
    mockSettings.mockResolvedValue({ enabled: false });
    expect((await POST(streamRequest(Buffer.from('not-json')).request)).status).toBe(400);
    expect((await POST(streamRequest(Buffer.from('{}')).request)).status).toBe(400);
    expect(mockSettings).not.toHaveBeenCalled();
  });

  test('payloadのDeliveredを記録せず合図の組だけ渡す', async () => {
    const raw = Buffer.from(JSON.stringify({ ...UPDATED, data: {
      ...UPDATED.data, track_info: { latest_status: { status: 'Delivered' }, location: 'unit-location' },
      param: 'unit-param', tag: 'unit-tag',
    } }));
    await expectReceived(await POST(streamRequest(raw).request));
    expect(mockSignal).toHaveBeenCalledTimes(1);
    expect(mockSignal).toHaveBeenCalledWith(mockStore, [{ carrier: 100062, number: 'AB-1', event: 'TRACKING_UPDATED' }]);
    expect(mockStore.rpc).not.toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockReport).not.toHaveBeenCalled();
  });

  test('1件の配列とTRACKING_STOPPEDを含む配列も合図だけにする', async () => {
    await expectReceived(await POST(streamRequest(Buffer.from(JSON.stringify([UPDATED]))).request));
    expect(mockSignal).toHaveBeenLastCalledWith(mockStore, [{ carrier: 100062, number: 'AB-1', event: 'TRACKING_UPDATED' }]);
    const stopped = { event: 'TRACKING_STOPPED', data: { carrier: 100040, number: 'cd-2' } };
    await expectReceived(await POST(streamRequest(Buffer.from(JSON.stringify([UPDATED, stopped]))).request));
    expect(mockSignal).toHaveBeenLastCalledWith(mockStore, [
      { carrier: 100062, number: 'AB-1', event: 'TRACKING_UPDATED' },
      { carrier: 100040, number: 'cd-2', event: 'TRACKING_STOPPED' },
    ]);
  });

  test.each([[], { event: 'UNKNOWN_EVENT' }, { event: 'TRACKING_UPDATED', data: { carrier: 999999 } }])(
    '空配列/未知イベント/未知業者も同じ200で無視（%j）', async (payload) => {
      await expectReceived(await POST(streamRequest(Buffer.from(JSON.stringify(payload))).request));
      expect(mockSignal).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
    },
  );

  test.each(['未知番号', '止めた番号'])('%sは合図の更新0件でも同じ200', async () => {
    mockSignal.mockResolvedValueOnce(0);
    await expectReceived(await POST(streamRequest().request));
    expect(mockSignal).toHaveBeenCalledTimes(1);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test('DBが失敗したら500、成功後だけafter', async () => {
    mockSignal.mockRejectedValueOnce(new Error('unit-db-error'));
    expect((await POST(streamRequest().request)).status).toBe(500);
    expect(mockSchedule).not.toHaveBeenCalled();
    await expectReceived(await POST(streamRequest().request));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSignal.mock.invocationCallOrder[1]).toBeLessThan(mockSchedule.mock.invocationCallOrder[0]);
  });

  test.each(['client', 'settings'])('設定を読むDBの失敗も500（%s）', async (failure) => {
    if (failure === 'client') mockCreateClient.mockRejectedValueOnce(new Error('unit-db-error'));
    else mockSettings.mockRejectedValueOnce(new Error('unit-db-error'));
    expect((await POST(streamRequest().request)).status).toBe(500);
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test('本文のbytesを変えず署名→JSON→設定→合図→急ぎ処理の順で呼ぶ', async () => {
    const raw = Buffer.from(`\n ${JSON.stringify(UPDATED)} \n`);
    const chunks = [raw.subarray(0, 3), raw.subarray(3, 20), raw.subarray(20)];
    await expectReceived(await POST(streamRequest(raw, { chunks }).request));
    expect(verify).toHaveBeenCalledWith(expect.any(Uint8Array), signature(raw), KEY);
    expect(Buffer.from(verify.mock.calls[0][0])).toEqual(raw);
    const order = [verify, parse, mockCreateClient, mockSettings, mockSignal, mockSchedule]
      .map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('UTF-8の文字がchunk境界をまたいでも署名bytesを保つ', async () => {
    const raw = Buffer.from(JSON.stringify({ ...UPDATED, note: '配送' }));
    const offset = raw.indexOf(Buffer.from('配送')) + 1;
    await expectReceived(await POST(streamRequest(raw, { chunks: [raw.subarray(0, offset), raw.subarray(offset)] }).request));
    expect(Buffer.from(verify.mock.calls[0][0])).toEqual(raw);
  });

  test('ログにraw本文/鍵/署名/例外の内容を出さない', async () => {
    const raw = Buffer.from(JSON.stringify({ ...UPDATED, private: 'unit-private-body' }));
    const sign = signature(raw);
    const error = new Error(`${raw.toString()} ${KEY} ${sign}`);
    error.name = error.message;
    mockSignal.mockRejectedValueOnce(error);
    const failed = await POST(streamRequest(raw).request);
    expect(failed.status).toBe(500);
    mockReport.mockRejectedValueOnce(error);
    expect((await POST(streamRequest(raw, { sign: '0'.repeat(64) }).request)).status).toBe(401);
    const logs = JSON.stringify([console.error, console.warn, console.info, console.log]
      .map((fn) => jest.mocked(fn).mock.calls));
    const responseBody = await failed.text();
    for (const secret of [raw.toString(), 'unit-private-body', KEY, sign, '0'.repeat(64)]) {
      expect(logs).not.toContain(secret);
      expect(responseBody).not.toContain(secret);
    }
  });

  test('ログインとCSRFとアプリの送信元制限を呼ばない', async () => {
    await expectReceived(await POST(streamRequest().request));
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });
});
