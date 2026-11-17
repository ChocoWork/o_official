/** @jest-environment node */
/**
 * DD-AUTH-052 パスキーのログインの始め (a) の窓口（src/app/api/auth/passkey/login/start/route.ts）の単体テスト。
 * 回数の制限・監査は差し替え、GoTrue へ送る要求は `fetch` を差し替えて確かめる。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/passkey/login/start/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';

const rateLimitMock = enforceRateLimit as jest.Mock;
const auditMock = logAudit as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const SECRET = 'sb_secret_topsecretvalue';
const IP = '203.0.113.7';

type Sent = { url: string; init: RequestInit & { headers: Record<string, string> } };
let sent: Sent[];
let fetchMock: jest.Mock;

const goodBody = {
  challenge_id: 'chal-1',
  options: { challenge: 'abc', rpId: 'localhost', userVerification: 'preferred' },
  expires_at: 1900000000,
};

function gotrue(status: number, body: unknown) {
  fetchMock.mockImplementation(async (url: string, init: Sent['init']) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  });
}

function req(headers: Record<string, string> = { 'x-real-ip': IP }) {
  return new Request('http://localhost/api/auth/passkey/login/start', { method: 'POST', headers });
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    CLIENT_IP_HEADER: 'x-real-ip',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: SECRET,
  };
  delete process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
  delete process.env.PASSKEY_START_DEV_IP;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  sent = [];
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  gotrue(200, goodBody);
  rateLimitMock.mockReset().mockResolvedValue(undefined);
  auditMock.mockClear();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
  global.fetch = ORIGINAL_FETCH;
});

describe('DD-AUTH-052 パスキーのログインの始め (a) の断りの順番', () => {
  test('DD-AUTH-052 設定が browser なら 409。GoTrue も回数の表も呼ばない', async () => {
    process.env.NEXT_PUBLIC_PASSKEY_START_MODE = 'browser';
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'passkey_start_mode_browser' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-052 IP が取れなければ 503。GoTrue も回数の枠も使わず、監査に client_ip_unavailable', async () => {
    const res = await POST(req({ 'x-real-ip': '' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'client_ip_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.passkey.login.start', detail: 'client_ip_unavailable' }),
    );
  });

  test('DD-AUTH-052 x-forwarded-for だけを偽っても IP は取れず 503（GoTrue 0回）', async () => {
    const res = await POST(req({ 'x-forwarded-for': '198.51.100.9' }));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-052 鍵が sb_secret_ の形でなければ 503（GoTrue 0回）。監査に secret_key_bad_shape', async () => {
    process.env.SUPABASE_SECRET_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln';
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'passkey_start_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ detail: 'secret_key_bad_shape' }));
  });

  test('DD-AUTH-052 鍵が無ければ 503。監査に secret_key_missing', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ detail: 'secret_key_missing' }));
  });

  test('DD-AUTH-052 回数の上限なら、その 429 をそのまま返し GoTrue を呼ばない。枠は IP ごとに5分20回', async () => {
    const limited = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    rateLimitMock.mockResolvedValue(limited);
    const res = await POST(req());
    expect(res).toBe(limited);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:passkey:login:start', limit: 20, windowSeconds: 300 }),
    );
  });
});

describe('DD-AUTH-052 パスキーのログインの始め (a) の成功と GoTrue の失敗', () => {
  test('DD-AUTH-052 成功: GoTrue へ apikey=鍵・Sb-Forwarded-For=取れた IP・Authorization 無しで1回。userVerification は required', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      challenge_id: 'chal-1',
      options: { challenge: 'abc', rpId: 'localhost', userVerification: 'required' },
      expires_at: 1900000000,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('http://127.0.0.1:54321/auth/v1/passkeys/authentication/options');
    expect(sent[0].init.headers.apikey).toBe(SECRET);
    expect(sent[0].init.headers['Sb-Forwarded-For']).toBe(IP);
    expect(Object.keys(sent[0].init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test('DD-AUTH-052 x-forwarded-for に偽の IP を付けても、Sb-Forwarded-For にも回数の枠にも使われない', async () => {
    await POST(req({ 'x-real-ip': IP, 'x-forwarded-for': '198.51.100.9' }));
    expect(sent[0].init.headers['Sb-Forwarded-For']).toBe(IP);
    const limitedRequest = rateLimitMock.mock.calls[0][0].request as Request;
    expect(limitedRequest.headers.get('x-real-ip')).toBe(IP);
    expect(JSON.stringify(sent[0].init.headers)).not.toContain('198.51.100.9');
  });

  test('DD-AUTH-052 開発の IP は、見出しの IP が無い時だけ使われる', async () => {
    process.env.PASSKEY_START_DEV_IP = '192.0.2.55';
    const res = await POST(req({ 'x-real-ip': '' }));
    expect(res.status).toBe(200);
    expect(sent[0].init.headers['Sb-Forwarded-For']).toBe('192.0.2.55');
  });

  test('DD-AUTH-052 VERCEL=1 では PASSKEY_START_DEV_IP があっても使わず、IP が無ければ 503（GoTrue 0回）', async () => {
    process.env.VERCEL = '1';
    process.env.PASSKEY_START_DEV_IP = '192.0.2.55';
    const res = await POST(req({ 'x-forwarded-for': '198.51.100.9' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'client_ip_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-052 見出しの IP があれば開発の IP より勝つ', async () => {
    process.env.PASSKEY_START_DEV_IP = '192.0.2.55';
    await POST(req());
    expect(sent[0].init.headers['Sb-Forwarded-For']).toBe(IP);
  });

  test('DD-AUTH-052 GoTrue の 429 は、今のログインの回数の制限と同じ本文・Retry-After 300', async () => {
    gotrue(429, { msg: 'over_request_rate_limit' });
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(res.headers.get('retry-after')).toBe('300');
  });

  test('DD-AUTH-052 GoTrue の 500 は 502。GoTrue の文を返さない', async () => {
    gotrue(500, { msg: 'internal secret detail' });
    const res = await POST(req());
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).toBe('{"error":"passkey_start_failed"}');
    expect(text).not.toContain('internal');
  });

  test('DD-AUTH-052 ネットワークの誤りも 502', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'passkey_start_failed' });
  });

  test.each([
    ['challenge_id が無い', { options: goodBody.options, expires_at: 1 }],
    ['options.challenge が無い', { challenge_id: 'x', options: { rpId: 'a' }, expires_at: 1 }],
    ['expires_at が数でない', { challenge_id: 'x', options: goodBody.options, expires_at: 'soon' }],
    ['options が配列', { challenge_id: 'x', options: [], expires_at: 1 }],
    ['challenge_id が空', { challenge_id: '', options: goodBody.options, expires_at: 1 }],
    ['options が無い', { challenge_id: 'x', expires_at: 1 }],
    ['本文が null', null],
    ['本文が文字列', 'oops'],
  ])('DD-AUTH-052 GoTrue の 200 の形が違う（%s）なら 502 で閉じる', async (_name, body) => {
    gotrue(200, body);
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'passkey_start_failed' });
  });

  test('DD-AUTH-052 想定外の例外（回数の表の例外など）は 502 で閉じ、GoTrue を呼ばない', async () => {
    rateLimitMock.mockRejectedValue(new Error('boom'));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'passkey_start_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ detail: 'unexpected_error' }));
  });

  test('DD-AUTH-052 監査に鍵・IP を残さない', async () => {
    gotrue(500, {});
    await POST(req());
    const logged = JSON.stringify(auditMock.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(IP);
  });
});
