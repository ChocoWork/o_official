/** @jest-environment node */
/**
 * DD-AUTH-059 メールのコードの再送の窓口（src/app/api/auth/email-code/resend/route.ts）の単体テスト。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/email-code/resend/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';
import { logAudit } from '@/lib/audit';
import { createEmailCodeSessionToken, verifyEmailCodeSessionToken } from '@/features/auth/services/email-code-session';

const rateLimit = enforceRateLimit as jest.Mock;
const audit = logAudit as jest.Mock;
const authClient = createServiceRoleAuthClient as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
const EMAIL = 'new@example.com';
let signInWithOtp: jest.Mock;

const now = () => Math.floor(Date.now() / 1000);
function req(cookie?: string, body?: unknown) {
  return new Request('http://localhost/api/auth/email-code/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const cookieFor = (iat: number, jti: string) =>
  `sb-email-code-session=${encodeURIComponent(createEmailCodeSessionToken({ email: EMAIL, issuedAt: iat, jti }))}`;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '' };
  rateLimit.mockReset().mockResolvedValue(undefined);
  signInWithOtp = jest.fn().mockResolvedValue({ error: null });
  authClient.mockReset().mockResolvedValue({ auth: { signInWithOtp } });
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('DD-AUTH-059 POST /api/auth/email-code/resend', () => {
  test('DD-AUTH-059 Cookie が無ければ 401 で、枠も送信も使わない', async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 成功は 200。宛先は Cookie 由来（本文の email は無視）、Cookie は元の iat・jti を引き継ぎ付け直す', async () => {
    const iat = now() - 120;
    const res = await POST(req(cookieFor(iat, 'jti-keep'), { email: 'victim@example.com' }));
    expect(res.status).toBe(200);
    expect(signInWithOtp).toHaveBeenCalledWith({ email: EMAIL, options: { shouldCreateUser: false } });
    const raw = res.headers.get('set-cookie') ?? '';
    const value = decodeURIComponent(raw.split(';')[0].split('=')[1]);
    expect(verifyEmailCodeSessionToken(value)).toMatchObject({ email: EMAIL, jti: 'jti-keep', iat });
  });

  test('DD-AUTH-059 枠は始めと同じ名前 auth:email-code:send（IP 50・メール 5）', async () => {
    await POST(req(cookieFor(now(), 'j')));
    expect(rateLimit.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ endpoint: 'auth:email-code:send', limit: 50 }),
      expect.objectContaining({ endpoint: 'auth:email-code:send', limit: 5, subject: EMAIL }),
    ]);
  });

  test('DD-AUTH-059 枠を使い切ったら 429 で、送らない', async () => {
    rateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const res = await POST(req(cookieFor(now(), 'j')));
    expect(res.status).toBe(429);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 IP の枠を使い切ったら 429 で、送らない', async () => {
    rateLimit.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await POST(req(cookieFor(now(), 'j')))).status).toBe(429);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 GoTrue の 429 は成功と同じ 200・本文・Cookie の付け直しで隠し、監査 email_code_send_throttled とログ1回。otp_resent は書かない', async () => {
    const iat = now() - 60;
    const ok = await POST(req(cookieFor(iat, 'jti-m')));
    const okCookie = decodeURIComponent((ok.headers.get('set-cookie') ?? '').split(';')[0].split('=')[1]);
    const okBody = await ok.json();
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    audit.mockClear();
    signInWithOtp.mockResolvedValueOnce({ error: { status: 429, message: 'over_email_send_rate_limit' } });
    const masked = await POST(req(cookieFor(iat, 'jti-m')));
    expect(masked.status).toBe(ok.status);
    expect(await masked.json()).toEqual(okBody);
    expect(masked.headers.get('Retry-After')).toBeNull();
    const maskedCookie = decodeURIComponent((masked.headers.get('set-cookie') ?? '').split(';')[0].split('=')[1]);
    expect(verifyEmailCodeSessionToken(maskedCookie)).toMatchObject({ email: EMAIL, jti: 'jti-m', iat });
    expect(verifyEmailCodeSessionToken(okCookie)).toMatchObject({ jti: 'jti-m' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'email_code_send_throttled' }));
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'otp_resent' }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  test('DD-AUTH-059 GoTrue の 5xx・通信の失敗は 503 と Retry-After（Cookie は付け直さない）', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { status: 502, message: 'x' } });
    const down = await POST(req(cookieFor(now(), 'j')));
    expect(down.status).toBe(503);
    expect(down.headers.get('Retry-After')).toBe('30');
    expect(down.headers.get('set-cookie')).toBeNull();
    signInWithOtp.mockResolvedValueOnce({ error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } });
    expect((await POST(req(cookieFor(now(), 'j')))).status).toBe(503);
  });

  test('DD-AUTH-059 送信の失敗（captcha の拒否を含む）は 500 で、Cookie を付け直さない', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { code: 'captcha_failed', status: 400, message: 'captcha' } });
    const a = await POST(req(cookieFor(now(), 'j')));
    signInWithOtp.mockResolvedValueOnce({ error: { status: 400, message: 'x' } });
    const b = await POST(req(cookieFor(now(), 'j')));
    expect([a.status, b.status]).toEqual([500, 500]);
    expect(a.headers.get('set-cookie')).toBeNull();
    expect(b.headers.get('set-cookie')).toBeNull();
  });
});
