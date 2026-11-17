/** @jest-environment node */
export {};

// API-AUTH-031 メールのコードの再送の窓口。回数の制限の本体と保留の Cookie は本物。外へ出る物だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));

import { POST } from '@/app/api/auth/email-code/resend/route';
import { incrementCounter } from '@/features/auth/ratelimit';
import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';
import { createEmailCodeSessionToken, verifyEmailCodeSessionToken } from '@/features/auth/services/email-code-session';

const counter = incrementCounter as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
let signInWithOtp: jest.Mock;
const iat = Math.floor(Date.now() / 1000) - 90;

function req(withCookie = true) {
  const token = createEmailCodeSessionToken({ email: 'new@example.com', issuedAt: iat, jti: 'jti-keep' });
  return new Request('http://localhost/api/auth/email-code/resend', {
    method: 'POST',
    headers: { 'x-real-ip': '203.0.113.42', ...(withCookie ? { cookie: `sb-email-code-session=${encodeURIComponent(token)}` } : {}) },
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '', CLIENT_IP_HEADER: 'x-real-ip' };
  counter.mockReset().mockResolvedValue(1);
  signInWithOtp = jest.fn().mockResolvedValue({ error: null });
  (createServiceRoleAuthClient as jest.Mock).mockReset().mockResolvedValue({ auth: { signInWithOtp } });
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('API-AUTH-031 POST /api/auth/email-code/resend', () => {
  test('API-AUTH-031 Cookie が無ければ 401', async () => {
    expect((await POST(req(false))).status).toBe(401);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-031 成功は 200 で、Cookie を元の iat・jti のまま付け直す。枠は始めと同じ名前', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const value = decodeURIComponent((res.headers.get('set-cookie') ?? '').split(';')[0].split('=')[1]);
    expect(verifyEmailCodeSessionToken(value)).toMatchObject({ jti: 'jti-keep', iat });
    expect(counter.mock.calls.map((c) => c[0].endpoint)).toEqual(['auth:email-code:send', 'auth:email-code:send']);
  });

  test('API-AUTH-031 メール単位の枠の6回目は 429（始め＋再送で5通まで）', async () => {
    counter.mockResolvedValueOnce(1).mockResolvedValueOnce(6);
    expect((await POST(req())).status).toBe(429);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });
});
