/** @jest-environment node */
export {};

// API-AUTH-029 メールのコードの始めの窓口。窓口・回数の制限の本体（enforceRateLimit）・zod の形・保留の Cookie は本物を通し、
// 外へ出る物（回数の表 incrementCounter・監査・Turnstile・GoTrue・戻り先の控え）だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/turnstile', () => ({ verifyTurnstile: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  issueReturnIntent: jest.fn().mockResolvedValue({ action: { kind: 'clear' } }),
  applyReturnIntentCookie: jest.fn(),
}));

import { POST } from '@/app/api/auth/email-code/start/route';
import { incrementCounter } from '@/features/auth/ratelimit';
import { verifyTurnstile } from '@/lib/turnstile';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';

const counter = incrementCounter as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
let createUser: jest.Mock;
let signInWithOtp: jest.Mock;

function req(email = 'new@example.com') {
  return new Request('http://localhost/api/auth/email-code/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.40' },
    body: JSON.stringify({ email, turnstileToken: 't' }),
  });
}
const shape = async (res: Response) => ({
  status: res.status,
  body: await res.json(),
  cookie: (res.headers.get('set-cookie') ?? '')
    .replace(/=[^;]*/, '=<v>')
    .replace(/Expires=[^;]*;?\s*/i, '')
    .replace(/Max-Age=\d+/i, 'Max-Age=<n>'),
});

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '', CLIENT_IP_HEADER: 'x-real-ip' };
  counter.mockReset().mockResolvedValue(1);
  (verifyTurnstile as jest.Mock).mockReset().mockResolvedValue({ ok: true });
  createUser = jest.fn().mockResolvedValue({ data: {}, error: null });
  signInWithOtp = jest.fn().mockResolvedValue({ error: null });
  (createServiceRoleClient as jest.Mock).mockReset().mockResolvedValue({ auth: { admin: { createUser } } });
  (createServiceRoleAuthClient as jest.Mock).mockReset().mockResolvedValue({ auth: { signInWithOtp } });
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('API-AUTH-029 POST /api/auth/email-code/start', () => {
  test('API-AUTH-029 未登録・登録済み・登録済みで未確認・店員で、202・本文・Set-Cookie の名前と属性が同じ', async () => {
    const fresh = await shape(await POST(req()));
    createUser.mockResolvedValue({ data: null, error: { code: 'email_exists', status: 422, message: 'exists' } });
    const existing = await shape(await POST(req('old@example.com')));
    // 旧の登録で未確認のアドレスも createUser は email_exists、signInWithOtp は成功（確認メールが届く）。応答は同じ。
    const unconfirmed = await shape(await POST(req('unconfirmed@example.com')));
    const staff = await shape(await POST(req('staff@example.com')));
    expect(fresh.status).toBe(202);
    expect(existing).toEqual(fresh);
    expect(unconfirmed).toEqual(fresh);
    expect(staff).toEqual(fresh);
    expect(fresh.cookie).toMatch(/^sb-email-code-session=<v>/);
    expect(fresh.cookie).toMatch(/HttpOnly/i);
    expect(fresh.cookie).toMatch(/SameSite=strict/i);
  });

  test('API-AUTH-029 始めと再送が同じ枠 auth:email-code:send。IP の枠・メール単位の枠の順で数える', async () => {
    await POST(req());
    expect(counter.mock.calls.map((c) => [c[0].endpoint, c[0].subject])).toEqual([
      ['auth:email-code:send', null],
      ['auth:email-code:send', 'new@example.com'],
    ]);
  });

  test('API-AUTH-029 メール単位の枠の6回目は 429 で、作成も送信もしない', async () => {
    counter.mockResolvedValueOnce(1).mockResolvedValueOnce(6);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(createUser).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-029 Turnstile の失敗は 403 で、メール単位の枠も数えない', async () => {
    (verifyTurnstile as jest.Mock).mockResolvedValueOnce({ ok: false, error: 'x' });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(counter).toHaveBeenCalledTimes(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  test('API-AUTH-029 email_address_invalid は 400、それ以外の作成の失敗は 500', async () => {
    createUser.mockResolvedValueOnce({ data: null, error: { code: 'email_address_invalid', status: 400, message: 'x' } });
    expect((await POST(req())).status).toBe(400);
    createUser.mockResolvedValueOnce({ data: null, error: { code: 'unexpected', status: 500, message: 'x' } });
    expect((await POST(req())).status).toBe(500);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });
});
