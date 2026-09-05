/** @jest-environment node */
import { NextResponse } from 'next/server';
import { POST as verify } from '@/app/api/auth/otp/verify/route';
import { POST as resend } from '@/app/api/auth/login/resend/route';
import { createLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';
import { accessCookieName, refreshCookieName, csrfCookieName, loginTwoFactorSessionCookieName } from '@/lib/cookie';

jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock('@/lib/orders/link-guest-orders', () => ({ linkGuestOrdersByEmail: jest.fn() }));

describe('OTP route with real SDK, session persistence, audit and rate limiter', () => {
  // The repository's node-fetch v2 setup lacks the Web Response.json static method.
  const originalJson = Response.json;
  beforeAll(() => {
    Response.json = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), {
      ...init, headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  });
  afterAll(() => { Response.json = originalJson; });
  const env = { ...process.env };
  const originalFetch = global.fetch;
  let failSessions = false;
  let failLimiter = false;
  let failAudit = false;
  const requests: Array<{ path: string; authorization: string | null; body: string }> = [];
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fake-public-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
    process.env.LOGIN_2FA_SESSION_SECRET = 'fake-test-signing-secret';
    delete process.env.ALERT_AUDIT_URL;
    failSessions = failLimiter = failAudit = false;
    requests.length = 0;
    global.fetch = jest.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, authorization: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
      const denied = (failSessions && path.endsWith('/sessions'))
        || (failLimiter && path.includes('/rpc/'))
        || (failAudit && path.endsWith('/audit_logs'));
      const body = denied ? { message: 'test database failure', code: '42501' }
        : path.endsWith('/verify') ? {
            access_token: 'fake-user-token', refresh_token: 'fake-refresh-token',
            expires_in: 3600, token_type: 'bearer',
            user: { id: 'test-user', email: 'one@example.invalid' },
          }
        : path.includes('/rpc/') ? 1 : {};
      return new Response(JSON.stringify(body), {
        status: denied ? 403 : 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });
  function request(path: string) {
    const pending = createLoginTwoFactorSessionToken({ userId: 'test-user', email: 'one@example.invalid' });
    return new Request('https://example.invalid' + path, {
      method: 'POST',
      headers: { cookie: loginTwoFactorSessionCookieName + '=' + pending, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '12345678' }),
    });
  }

  async function verifyRequest() {
    const response = await verify(request('/api/auth/otp/verify'));
    if (!(response instanceof NextResponse)) throw new Error('Expected a NextResponse');
    return response;
  }

  test('OTP success persists hashed credentials and issues cookies; subsequent resend remains usable', async () => {
    const response = await verifyRequest();
    expect(response.status).toBe(200);
    expect(response.cookies.get(accessCookieName)?.value).toBe('fake-user-token');
    expect(response.cookies.get(refreshCookieName)?.value).toBe('fake-refresh-token');
    expect(response.cookies.get(csrfCookieName)?.value).toBeTruthy();
    expect(response.cookies.get(loginTwoFactorSessionCookieName)?.maxAge).toBe(0);
    const saved = requests.find(item => item.path.endsWith('/sessions'));
    expect(saved?.body).toContain('refresh_token_hash');
    expect(saved?.body).not.toContain('fake-refresh-token');
    const resent = await resend(request('/api/auth/login/resend'));
    expect(resent.status).toBe(200);
    expect(requests.some(item => item.path.endsWith('/otp'))).toBe(true);
    expect(requests.filter(item => item.path.startsWith('/rest/'))
      .every(item => item.authorization === 'Bearer fake-service-key')).toBe(true);
  });

  test('session save failure does not issue login cookies', async () => {
    failSessions = true;
    const response = await verifyRequest();
    expect(response.status).toBe(500);
    expect(response.cookies.get(accessCookieName)).toBeUndefined();
    expect(response.cookies.get(refreshCookieName)).toBeUndefined();
  });

  test('audit failure does not undo successful login', async () => {
    failAudit = true;
    const response = await verifyRequest();
    expect(response.status).toBe(200);
    expect(response.cookies.get(accessCookieName)?.value).toBe('fake-user-token');
    expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
  });

  test('rate limiter failure returns 503 without sending email', async () => {
    failLimiter = true;
    const response = await resend(request('/api/auth/login/resend'));
    expect(response.status).toBe(503);
    expect(requests.some(item => item.path.endsWith('/otp'))).toBe(false);
  });
});
