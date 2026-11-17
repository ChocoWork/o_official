/** @jest-environment node */
export {};

// API-AUTH-029・API-AUTH-031 始めと再送が、本物の回数の制限（enforceRateLimit と incrementCounter の鍵の作り）で、同じ宛先の5通の枠を共有する。
// 回数の表の RPC だけを、同じ鍵（IP・名前・時間枠）で数える入れ物に差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/turnstile', () => ({ verifyTurnstile: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  issueReturnIntent: jest.fn().mockResolvedValue({ action: { kind: 'clear' } }),
  applyReturnIntentCookie: jest.fn(),
}));

import { POST as start } from '@/app/api/auth/email-code/start/route';
import { POST as resend } from '@/app/api/auth/email-code/resend/route';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';

const ORIGINAL_ENV = { ...process.env };
const EMAIL = 'shared-limit@example.com';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '', CLIENT_IP_HEADER: 'x-real-ip' };
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

test('API-AUTH-031 始めと再送は、本物の鍵の作りで同じ宛先の枠を共有し、合計5通で止まる（別の IP でも同じ宛先は数える）', async () => {
  const counters = new Map<string, number>();
  const rpc = jest.fn(async (_name: string, args: { _ip: string | null; _endpoint: string; _bucket: string }) => {
    const key = `${args._ip}|${args._endpoint}|${args._bucket}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return { data: next, error: null };
  });
  const createUser = jest.fn().mockResolvedValue({ data: {}, error: null });
  const signInWithOtp = jest.fn().mockResolvedValue({ error: null });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc, auth: { admin: { createUser } } });
  (createServiceRoleAuthClient as jest.Mock).mockResolvedValue({ auth: { signInWithOtp } });

  const startReq = (ip: string) =>
    new Request('http://localhost/api/auth/email-code/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify({ email: EMAIL, turnstileToken: 't' }),
    });
  const first = await start(startReq('203.0.113.50'));
  expect(first.status).toBe(202);
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
  const resendReq = (ip: string) =>
    new Request('http://localhost/api/auth/email-code/resend', { method: 'POST', headers: { cookie, 'x-real-ip': ip } });

  // 始め1通＋再送2通＋始め2通（別の IP）で5通。
  expect((await resend(resendReq('203.0.113.51'))).status).toBe(200);
  expect((await resend(resendReq('203.0.113.52'))).status).toBe(200);
  expect((await start(startReq('203.0.113.53'))).status).toBe(202);
  expect((await start(startReq('203.0.113.54'))).status).toBe(202);
  expect(signInWithOtp).toHaveBeenCalledTimes(5);

  // 6通目は、始めでも再送でも 429 で、送らない。
  expect((await resend(resendReq('203.0.113.55'))).status).toBe(429);
  expect((await start(startReq('203.0.113.56'))).status).toBe(429);
  expect(signInWithOtp).toHaveBeenCalledTimes(5);
});
