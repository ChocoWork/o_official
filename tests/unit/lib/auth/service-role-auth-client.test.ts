/** @jest-environment node */
/**
 * DD-AUTH-040 captcha を免除される auth だけのクライアント（IMPL-AUTH-228）。
 */
import { createServiceRoleAuthClient, isCaptchaRejection } from '@/lib/auth/service-role-auth-client';
import { createServiceRoleClient } from '@/lib/supabase/server';

jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));

function fakeAuthFunctions() {
  return { signInWithPassword: jest.fn(), signInWithOtp: jest.fn(), signUp: jest.fn(), resend: jest.fn() };
}

describe('DD-AUTH-040 createServiceRoleAuthClient', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const requests: Array<{ path: string; authorization: string | null; apikey: string | null }> = [];

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fake-public-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
    requests.length = 0;
    global.fetch = jest.fn(async (input, init) => {
      const headers = new Headers(init?.headers);
      const path = new URL(String(input)).pathname;
      requests.push({ path, authorization: headers.get('authorization'), apikey: headers.get('apikey') });
      const body = path.endsWith('/token')
        ? {
            access_token: 'fake-access',
            refresh_token: 'fake-refresh',
            expires_in: 3600,
            token_type: 'bearer',
            user: { id: 'user-1', email: 'user@example.invalid' },
          }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.dontMock('@supabase/supabase-js');
    jest.resetModules();
  });

  test('DD-AUTH-040 from・rpc・storage を型にも実体にも持たない（DB へ使い回せない）', async () => {
    const client = await createServiceRoleAuthClient();
    expect('from' in client).toBe(false);
    expect('rpc' in client).toBe(false);
    expect('storage' in client).toBe(false);
    expect(typeof client.auth.signInWithPassword).toBe('function');
  });

  test('DD-AUTH-040 呼ぶたびに別のオブジェクトを返す（使い回さない）', async () => {
    const first = await createServiceRoleAuthClient();
    const second = await createServiceRoleAuthClient();
    expect(second).not.toBe(first);
    expect(second.auth).not.toBe(first.auth);
  });

  test('DD-AUTH-040 URL が無ければ throw し、鍵の値を文に載せない', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await expect(createServiceRoleAuthClient()).rejects.toThrow(
      'SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL must be set for service role client',
    );
    await createServiceRoleAuthClient().catch((e: Error) => {
      expect(e.message).not.toContain('fake-service-key');
    });
  });

  test('DD-AUTH-040 サービスの鍵が無ければ throw する', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(createServiceRoleAuthClient()).rejects.toThrow(
      'SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL must be set for service role client',
    );
  });

  test('DD-AUTH-040 SUPABASE_URL が無ければ NEXT_PUBLIC_SUPABASE_URL を使う', async () => {
    delete process.env.SUPABASE_URL;
    const client = await createServiceRoleAuthClient();
    await client.auth.signInWithPassword({ email: 'user@example.invalid', password: 'x'.repeat(16) });
    expect(requests).toHaveLength(1);
  });

  test('DD-AUTH-040 createClient へ渡す auth は更新のタイマー・保存・URL の読みを全部切る', async () => {
    const createClientMock = jest.fn(() => ({ auth: fakeAuthFunctions(), from: jest.fn() }));
    jest.resetModules();
    jest.doMock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
    const { createServiceRoleAuthClient: fresh } = await import('@/lib/auth/service-role-auth-client');
    await fresh();
    expect(createClientMock).toHaveBeenCalledTimes(1);
    const calls = createClientMock.mock.calls as unknown as Array<[string, string, { auth: Record<string, unknown> }]>;
    const [url, key, options] = calls[0];
    expect(url).toBe('https://example.invalid');
    expect(key).toBe('fake-service-key');
    expect(options.auth).toMatchObject({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
  });

  test('DD-AUTH-040 返り値は auth だけで、モックの createClient が from を持っていても漏らさない', async () => {
    const fakeAuth = fakeAuthFunctions();
    jest.resetModules();
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ auth: fakeAuth, from: jest.fn(), rpc: jest.fn(), storage: {} }),
    }));
    const { createServiceRoleAuthClient: fresh } = await import('@/lib/auth/service-role-auth-client');
    const client = await fresh();
    expect(Object.keys(client)).toEqual(['auth']);
    expect(Object.keys(client.auth).sort()).toEqual(['resend', 'signInWithOtp', 'signInWithPassword', 'signUp']);
  });

  test('DD-AUTH-040 auth.admin・auth.mfa などの残りの auth の機能には届かない（4 つの関数だけ）', async () => {
    const fakeAuth = { ...fakeAuthFunctions(), admin: { deleteUser: jest.fn() }, mfa: {}, getSession: jest.fn() };
    jest.resetModules();
    jest.doMock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: fakeAuth }) }));
    const { createServiceRoleAuthClient: fresh } = await import('@/lib/auth/service-role-auth-client');
    const client = await fresh();
    expect('admin' in client.auth).toBe(false);
    expect('mfa' in client.auth).toBe(false);
    expect('getSession' in client.auth).toBe(false);
    expect((client.auth as unknown as Record<string, unknown>).admin).toBeUndefined();
  });

  test('DD-AUTH-040 本物の SDK の client でも auth.admin に届かず、4 つの関数は束ねられていて取り出して呼べる', async () => {
    const client = await createServiceRoleAuthClient();
    expect('admin' in client.auth).toBe(false);
    expect(Object.keys(client.auth).sort()).toEqual(['resend', 'signInWithOtp', 'signInWithPassword', 'signUp']);
    const { signInWithPassword } = client.auth;
    const result = await signInWithPassword({ email: 'user@example.invalid', password: 'x'.repeat(16) });
    expect(result.error).toBeNull();
    expect(requests.some(r => r.path.endsWith('/token'))).toBe(true);
  });

  test('DD-AUTH-040 signInWithPassword の後に signInWithOtp を呼んでも、両方の要求がサービスの鍵のまま', async () => {
    const client = await createServiceRoleAuthClient();
    const password = await client.auth.signInWithPassword({ email: 'user@example.invalid', password: 'x'.repeat(16) });
    expect(password.error).toBeNull();
    expect(password.data.session).not.toBeNull();
    await client.auth.signInWithOtp({ email: 'user@example.invalid', options: { shouldCreateUser: false } });

    const token = requests.find(r => r.path.endsWith('/token'));
    const otp = requests.find(r => r.path.endsWith('/otp'));
    expect(token).toBeDefined();
    expect(otp).toBeDefined();
    expect(token?.authorization).toBe('Bearer fake-service-key');
    expect(otp?.authorization).toBe('Bearer fake-service-key');
    expect(token?.apikey).toBe('fake-service-key');
    expect(otp?.apikey).toBe('fake-service-key');
  });

  test('DD-AUTH-040 auth だけのクライアントを作っても createServiceRoleClient の DB 要求は混ざらない', async () => {
    const authClient = await createServiceRoleAuthClient();
    await authClient.auth.signInWithPassword({ email: 'user@example.invalid', password: 'x'.repeat(16) });
    const admin = await createServiceRoleClient();
    await admin.from('sessions').select('id');
    const rest = requests.filter(r => r.path.startsWith('/rest/'));
    expect(rest).toHaveLength(1);
    expect(rest[0].authorization).toBe('Bearer fake-service-key');
  });
});

describe('DD-AUTH-040 isCaptchaRejection', () => {
  test.each([
    ['code が captcha_failed', { code: 'captcha_failed' }, true],
    [
      '400 で本文に captcha を含む',
      { status: 400, message: 'captcha protection: request disallowed (no captcha_token found)' },
      true,
    ],
    ['400 でも資格情報の誤りは別', { status: 400, message: 'Invalid login credentials' }, false],
    ['401 で本文に captcha を含むだけでは断定しない', { status: 401, message: 'captcha' }, false],
    ['code が別', { code: 'invalid_credentials', status: 400 }, false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('DD-AUTH-040 %s -> %s', (_name, error, expected) => {
    expect(isCaptchaRejection(error as never)).toBe(expected);
  });
});
