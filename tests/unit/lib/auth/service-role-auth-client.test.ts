/** @jest-environment node */
/**
 * DD-AUTH-040 captcha を免除される auth だけのクライアント（IMPL-AUTH-228）。
 */
import { createServiceRoleAuthClient, isCaptchaRejection } from '@/lib/auth/service-role-auth-client';
import { createServiceRoleClient } from '@/lib/supabase/server';

jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));

function fakeAuthFunctions() {
  return { signInWithOtp: jest.fn() };
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
    expect(typeof client.auth.signInWithOtp).toBe('function');
    // パスワードの道（signInWithPassword・signUp）と、呼び手が無い resend はパスキー段4で消した。
    expect('resend' in client.auth).toBe(false);
    expect('signInWithPassword' in client.auth).toBe(false);
    expect('signUp' in client.auth).toBe(false);
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
    await client.auth.signInWithOtp({ email: 'user@example.invalid', options: { shouldCreateUser: false } });
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
    expect(Object.keys(client.auth).sort()).toEqual(['signInWithOtp']);
  });

  test('DD-AUTH-040 auth.admin・auth.mfa などの残りの auth の機能には届かない（signInWithOtp だけ）', async () => {
    const fakeAuth = { ...fakeAuthFunctions(), signInWithPassword: jest.fn(), signUp: jest.fn(), resend: jest.fn(), admin: { deleteUser: jest.fn() }, mfa: {}, getSession: jest.fn() };
    jest.resetModules();
    jest.doMock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: fakeAuth }) }));
    const { createServiceRoleAuthClient: fresh } = await import('@/lib/auth/service-role-auth-client');
    const client = await fresh();
    expect('admin' in client.auth).toBe(false);
    expect('mfa' in client.auth).toBe(false);
    expect('getSession' in client.auth).toBe(false);
    expect('signInWithPassword' in client.auth).toBe(false);
    expect('signUp' in client.auth).toBe(false);
    expect('resend' in client.auth).toBe(false);
    expect((client.auth as unknown as Record<string, unknown>).admin).toBeUndefined();
  });

  test('DD-AUTH-040 本物の SDK の client でも auth.admin に届かず、signInWithOtp は束ねられていて取り出して呼べる', async () => {
    const client = await createServiceRoleAuthClient();
    expect('admin' in client.auth).toBe(false);
    expect(Object.keys(client.auth).sort()).toEqual(['signInWithOtp']);
    const { signInWithOtp } = client.auth;
    const result = await signInWithOtp({ email: 'user@example.invalid', options: { shouldCreateUser: false } });
    expect(result.error).toBeNull();
    expect(requests.some(r => r.path.endsWith('/otp'))).toBe(true);
  });

  test('DD-AUTH-040 signInWithOtp の要求はサービスの鍵で送られ、2 回呼んでも鍵は混ざらない', async () => {
    const client = await createServiceRoleAuthClient();
    const first = await client.auth.signInWithOtp({ email: 'user@example.invalid', options: { shouldCreateUser: false } });
    expect(first.error).toBeNull();
    await client.auth.signInWithOtp({ email: 'other@example.invalid', options: { shouldCreateUser: false } });

    const otp = requests.filter(r => r.path.endsWith('/otp'));
    expect(otp).toHaveLength(2);
    for (const request of otp) {
      expect(request.authorization).toBe('Bearer fake-service-key');
      expect(request.apikey).toBe('fake-service-key');
    }
  });

  test('DD-AUTH-040 auth だけのクライアントを作っても createServiceRoleClient の DB 要求は混ざらない', async () => {
    const authClient = await createServiceRoleAuthClient();
    await authClient.auth.signInWithOtp({ email: 'user@example.invalid', options: { shouldCreateUser: false } });
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
