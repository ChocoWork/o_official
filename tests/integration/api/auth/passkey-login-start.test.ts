/** @jest-environment node */
export {};

// パスキーのログインの始めの窓口（API-AUTH-022）。窓口・回数の制限の本体（enforceRateLimit）・IP の取り出し・鍵の確かめ・
// GoTrue の呼び出しの部品は本物を通し、外へ出る物（回数の表 incrementCounter・監査・GoTrue への fetch）だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/passkey/login/start/route';
import { incrementCounter } from '@/features/auth/ratelimit';

const counter = incrementCounter as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const SECRET = 'sb_secret_integration_value';
const IP = '203.0.113.20';

let calls: Array<{ url: string; headers: Record<string, string> }>;
let fetchMock: jest.Mock;

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
  calls = [];
  counter.mockReset().mockResolvedValue(1);
  fetchMock = jest.fn(async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return new Response(
      JSON.stringify({ challenge_id: 'c1', options: { challenge: 'abc', userVerification: 'preferred' }, expires_at: 1900000000 }),
      { status: 200 },
    );
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
  global.fetch = ORIGINAL_FETCH;
});

describe('API-AUTH-022 POST /api/auth/passkey/login/start', () => {
  test('API-AUTH-022 本物の回数の制限と IP の取り出しを通り、GoTrue へ鍵と IP を添えて呼び、userVerification を required にして返す', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).options.userVerification).toBe('required');
    expect(counter).toHaveBeenCalledWith(expect.objectContaining({ ip: IP, endpoint: 'auth:passkey:login:start' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.apikey).toBe(SECRET);
    expect(calls[0].headers['Sb-Forwarded-For']).toBe(IP);
  });

  test('API-AUTH-022 回数の表が上限を超えた（21回目）なら 429 で、GoTrue を呼ばない', async () => {
    counter.mockResolvedValue(21);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('API-AUTH-022 回数の表が使えない時は 503 で閉じ、GoTrue を呼ばない', async () => {
    counter.mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('API-AUTH-022 信じる IP の見出しが無ければ 503 で、回数の表にも GoTrue にも触れない', async () => {
    const res = await POST(req({ 'x-forwarded-for': '198.51.100.9' }));
    expect(res.status).toBe(503);
    expect(counter).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
