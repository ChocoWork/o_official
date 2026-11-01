/** @jest-environment node */
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';

jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));

describe('Supabase SDK authentication isolation', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const requests: Array<{ path: string; authorization: string | null }> = [];

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fake-public-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
    requests.length = 0;
    global.fetch = jest.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, authorization: new Headers(init?.headers).get('authorization') });
      const body = (path.endsWith('/verify') || path.endsWith('/token'))
        ? (() => {
            const { email } = JSON.parse(String(init?.body)) as { email: string };
            return {
              access_token: 'fake-access-' + email,
              refresh_token: 'fake-refresh-' + email,
              expires_in: 3600,
              token_type: 'bearer',
              user: { id: email, email },
            };
          })()
        : [];
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  test('parallel OTP sessions never replace the DB, audit or rate-limit authorization', async () => {
    const admin = await createServiceRoleClient();
    const first = await createPublicClient();
    const second = await createPublicClient();
    await admin.from('sessions').select('id');
    const results = await Promise.all([
      first.auth.verifyOtp({ email: 'one@example.invalid', token: '12345678', type: 'email' }),
      second.auth.verifyOtp({ email: 'two@example.invalid', token: '87654321', type: 'email' }),
    ]);
    expect(results.map(result => result.error)).toEqual([null, null]);
    expect((await first.auth.getSession()).data.session?.user.email).toBe('one@example.invalid');
    expect((await second.auth.getSession()).data.session?.user.email).toBe('two@example.invalid');
    await admin.from('sessions').insert({ user_id: 'one@example.invalid' });
    await admin.from('audit_logs').insert({ action: 'auth.otp.verify' });
    await admin.rpc('increment_rate_limit_counter', {});
    const freshAdmin = await createServiceRoleClient();
    expect(freshAdmin).not.toBe(admin);
    await freshAdmin.from('sessions').select('id');
    const privileged = requests.filter(request => request.path.startsWith('/rest/'));
    expect(privileged).toHaveLength(5);
    expect(privileged.every(request => request.authorization === 'Bearer fake-service-key')).toBe(true);
    expect(requests.filter(request => request.path.endsWith('/verify'))
      .every(request => request.authorization === 'Bearer fake-public-key')).toBe(true);
    expect((await admin.auth.getSession()).data.session).toBeNull();
  });

  test('DD-AUTH-040 auth だけのクライアントの signInWithPassword の後も、createServiceRoleClient の DB 要求はサービスの鍵のまま', async () => {
    const authOnly = await createServiceRoleAuthClient();
    const admin = await createServiceRoleClient();
    const signedIn = await authOnly.auth.signInWithPassword({ email: 'one@example.invalid', password: 'x'.repeat(16) });
    expect(signedIn.error).toBeNull();
    await admin.from('sessions').select('id');
    const freshAdmin = await createServiceRoleClient();
    await freshAdmin.from('sessions').select('id');
    const rest = requests.filter(request => request.path.startsWith('/rest/'));
    expect(rest).toHaveLength(2);
    expect(rest.every(request => request.authorization === 'Bearer fake-service-key')).toBe(true);
    expect('from' in authOnly).toBe(false);
    expect('rpc' in authOnly).toBe(false);
    // サービスの鍵の見出しで動く管理 API（利用者の削除・更新・generateLink）には届かない。
    expect('admin' in authOnly.auth).toBe(false);
    expect('mfa' in authOnly.auth).toBe(false);
    expect((authOnly.auth as unknown as Record<string, unknown>).admin).toBeUndefined();
  });
});
