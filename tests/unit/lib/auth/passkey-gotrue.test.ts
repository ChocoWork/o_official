/** @jest-environment node */
/**
 * DD-AUTH-051 GoTrue のパスキーの REST を呼ぶ薄い層（src/lib/auth/passkey-gotrue.ts）の単体テスト。
 * グローバルの fetch を差し替え、送ったヘッダー・本文・路を確かめる。
 */
import {
  deletePasskey,
  listPasskeys,
  registrationOptions,
  registrationVerify,
  requestAuthenticationOptionsAsServer,
  updatePasskey,
} from '@/lib/auth/passkey-gotrue';

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };
const SECRET = 'sb_secret_topsecretvalue';
const TOKEN = 'access.token.value';

type Sent = { url: string; init: RequestInit & { headers: Record<string, string> } };
let sent: Sent[];
let fetchMock: jest.Mock;

function respond(status: number, body: unknown, raw = false) {
  fetchMock.mockImplementation(async (url: string, init: Sent['init']) => {
    sent.push({ url, init });
    return new Response(raw ? (body as string) : JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  sent = [];
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
  jest.useRealTimers();
});

describe('DD-AUTH-051 requestAuthenticationOptionsAsServer', () => {
  test('DD-AUTH-051 apikey と Sb-Forwarded-For だけで呼び、Authorization は付けず、本文は {}', async () => {
    const data = { challenge_id: 'c', options: { challenge: 'x' }, expires_at: 1 };
    respond(200, data);

    const result = await requestAuthenticationOptionsAsServer({ clientIp: '203.0.113.7', secretKey: SECRET });

    expect(result).toEqual({ ok: true, data });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('http://127.0.0.1:54321/auth/v1/passkeys/authentication/options');
    expect(sent[0].init.method).toBe('POST');
    expect(sent[0].init.headers).toEqual({
      'X-Supabase-Api-Version': '2024-01-01',
      'Content-Type': 'application/json',
      apikey: SECRET,
      'Sb-Forwarded-For': '203.0.113.7',
    });
    expect(Object.keys(sent[0].init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(sent[0].init.body).toBe('{}');
  });

  test('DD-AUTH-051 GoTrue の誤りは status と message を返し、message に鍵を入れない', async () => {
    respond(429, { msg: `rate limited for ${SECRET}`, error_code: 'over_request_rate_limit' });

    const result = await requestAuthenticationOptionsAsServer({ clientIp: '203.0.113.7', secretKey: SECRET });

    expect(result).toEqual({ ok: false, status: 429, message: 'rate limited for ' });
  });
});

describe('DD-AUTH-051 利用者のトークンで呼ぶ関数', () => {
  const calls: Array<[string, string, string, () => Promise<unknown>, string | undefined]> = [
    ['registrationOptions', 'POST', '/passkeys/registration/options', () => registrationOptions(TOKEN), '{}'],
    [
      'registrationVerify',
      'POST',
      '/passkeys/registration/verify',
      () => registrationVerify(TOKEN, { challengeId: 'cid', credential: { id: 'a' } as never }),
      JSON.stringify({ challenge_id: 'cid', credential: { id: 'a' } }),
    ],
    ['listPasskeys', 'GET', '/passkeys', () => listPasskeys(TOKEN), undefined],
    [
      'updatePasskey',
      'PATCH',
      '/passkeys/pk-1',
      () => updatePasskey(TOKEN, { passkeyId: 'pk-1', friendlyName: 'Mac' }),
      JSON.stringify({ friendly_name: 'Mac' }),
    ],
    ['deletePasskey', 'DELETE', '/passkeys/pk-1', () => deletePasskey(TOKEN, 'pk-1'), undefined],
  ];

  test.each(calls)('DD-AUTH-051 %s は路・メソッド・ヘッダー・本文が合い、X-Supabase-Api-Version がある', async (_name, method, path, run, body) => {
    respond(200, [{ id: 'x' }]);

    await run();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`http://127.0.0.1:54321/auth/v1${path}`);
    expect(sent[0].init.method).toBe(method);
    expect(sent[0].init.headers['X-Supabase-Api-Version']).toBe('2024-01-01');
    expect(sent[0].init.headers.apikey).toBe('anon-key-value');
    expect(sent[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0].init.body).toBe(body);
  });

  test('DD-AUTH-051 deletePasskey は本文の無い成功を data: null で返す', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    expect(await deletePasskey(TOKEN, 'pk-1')).toEqual({ ok: true, data: null });
  });

  test('DD-AUTH-051 SUPABASE_URL が無ければ NEXT_PUBLIC_SUPABASE_URL を使い、末尾の / は除く。どちらも無ければ空の origin', async () => {
    respond(200, []);
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321/';
    await listPasskeys(TOKEN);
    expect(sent[0].url).toBe('http://localhost:54321/auth/v1/passkeys');
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await listPasskeys(TOKEN);
    expect(sent[1].url).toBe('/auth/v1/passkeys');
  });

  test('DD-AUTH-051 passkeyId の路は符号化する', async () => {
    respond(200, {});
    await updatePasskey(TOKEN, { passkeyId: '../x?y', friendlyName: 'n' });
    expect(sent[0].url).toBe('http://127.0.0.1:54321/auth/v1/passkeys/..%2Fx%3Fy');
  });

  test('DD-AUTH-051 誤りの文は msg を先に、無ければ message を読む', async () => {
    respond(403, { msg: '[staff-passkey-required] x', message: 'other' });
    expect(await listPasskeys(TOKEN)).toEqual({ ok: false, status: 403, message: '[staff-passkey-required] x' });
    respond(400, { message: 'only message' });
    expect(await listPasskeys(TOKEN)).toEqual({ ok: false, status: 400, message: 'only message' });
  });

  test('DD-AUTH-051 本文が null・文字列の msg も message も無い誤りは message なし', async () => {
    respond(500, null);
    expect(await listPasskeys(TOKEN)).toEqual({ ok: false, status: 500, message: undefined });
    respond(500, { error_code: 'unexpected_failure' });
    expect(await listPasskeys(TOKEN)).toEqual({ ok: false, status: 500, message: undefined });
  });

  test('DD-AUTH-051 anon キーが未設定でも例外にせず、空の apikey で呼ぶ', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    respond(401, { msg: 'no key' });
    expect(await listPasskeys(TOKEN)).toEqual({ ok: false, status: 401, message: 'no key' });
    expect(sent[0].init.headers.apikey).toBe('');
  });

  test('DD-AUTH-051 鍵が空の文字列でも、誤りの文を壊さない', async () => {
    respond(400, { msg: 'plain' });
    expect(await requestAuthenticationOptionsAsServer({ clientIp: '203.0.113.7', secretKey: '' })).toEqual({
      ok: false,
      status: 400,
      message: 'plain',
    });
  });

  test('DD-AUTH-051 message にトークンが入っていたら取り除く', async () => {
    respond(401, { msg: `bad ${TOKEN} here` });
    const result = await listPasskeys(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('DD-AUTH-051 失敗の扱い', () => {
  test('DD-AUTH-051 ネットワークの誤りは例外にせず { ok: false } で、鍵・トークンを載せない', async () => {
    fetchMock.mockRejectedValue(new Error(`connect failed ${SECRET} ${TOKEN}`));
    const a = await requestAuthenticationOptionsAsServer({ clientIp: '203.0.113.7', secretKey: SECRET });
    const b = await listPasskeys(TOKEN);
    expect(a).toEqual({ ok: false, status: 0 });
    expect(b).toEqual({ ok: false, status: 0 });
    expect(JSON.stringify([a, b])).not.toContain(SECRET);
  });

  test('DD-AUTH-051 JSON でない成功の応答は { ok: false }', async () => {
    respond(200, '<html>', true);
    expect(await registrationOptions(TOKEN)).toEqual({ ok: false, status: 200 });
  });

  test('DD-AUTH-051 JSON でない誤りの応答は status だけを返す', async () => {
    respond(502, 'Bad Gateway', true);
    expect(await registrationOptions(TOKEN)).toEqual({ ok: false, status: 502, message: undefined });
  });

  test('DD-AUTH-051 10秒で打ち切り、{ ok: false } を返す', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const pending = listPasskeys(TOKEN);
    await jest.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);

    expect(await pending).toEqual({ ok: false, status: 0 });
  });
});
