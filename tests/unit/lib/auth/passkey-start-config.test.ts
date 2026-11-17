/** @jest-environment node */
/**
 * DD-AUTH-051 始め (a) が使う鍵と手元の開発の IP の設定（src/lib/auth/passkey-start-config.ts）の単体テスト。
 */
jest.mock('server-only', () => ({}), { virtual: true });

import { isSbSecretKey, resolvePasskeyStartDevIp, resolveStartSecretKey } from '@/lib/auth/passkey-start-config';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln';

describe('DD-AUTH-051 isSbSecretKey', () => {
  test.each([
    ['sb_secret_x', true],
    [' sb_secret_x ', true],
    ['sb_secret_', false],
    ['  sb_secret_  ', false],
    [JWT, false],
    ['sb_publishable_abc', false],
    ['', false],
    [undefined, false],
  ])('DD-AUTH-051 %p は %p', (value, expected) => {
    expect(isSbSecretKey(value)).toBe(expected);
  });
});

describe('DD-AUTH-051 resolveStartSecretKey', () => {
  test('DD-AUTH-051 新しい変数だけがあれば、それを返す', () => {
    expect(resolveStartSecretKey({ SUPABASE_SECRET_KEY: 'sb_secret_new' })).toEqual({ ok: true, key: 'sb_secret_new' });
  });

  test('DD-AUTH-051 古い変数が sb_secret_ の形なら、それを返す', () => {
    expect(resolveStartSecretKey({ SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_old' })).toEqual({ ok: true, key: 'sb_secret_old' });
  });

  test('DD-AUTH-051 両方が正しければ新しい変数を先にする', () => {
    expect(
      resolveStartSecretKey({ SUPABASE_SECRET_KEY: 'sb_secret_new', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_old' }),
    ).toEqual({ ok: true, key: 'sb_secret_new' });
  });

  test('DD-AUTH-051 古い変数が JWT の形なら bad_shape', () => {
    expect(resolveStartSecretKey({ SUPABASE_SERVICE_ROLE_KEY: JWT })).toEqual({ ok: false, reason: 'bad_shape' });
  });

  test('DD-AUTH-051 新しい変数が不正で古い変数が正しくても、古い方に倒さず bad_shape', () => {
    expect(
      resolveStartSecretKey({ SUPABASE_SECRET_KEY: 'not-a-secret', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_old' }),
    ).toEqual({ ok: false, reason: 'bad_shape' });
  });

  test('DD-AUTH-051 両方が無ければ missing', () => {
    expect(resolveStartSecretKey({})).toEqual({ ok: false, reason: 'missing' });
    expect(resolveStartSecretKey({ SUPABASE_SECRET_KEY: '  ', SUPABASE_SERVICE_ROLE_KEY: '' })).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  test('DD-AUTH-051 失敗の戻りに鍵の値を載せない', () => {
    expect(JSON.stringify(resolveStartSecretKey({ SUPABASE_SERVICE_ROLE_KEY: JWT }))).not.toContain(JWT);
  });
});

describe('DD-AUTH-051 resolvePasskeyStartDevIp', () => {
  const local = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', PASSKEY_START_DEV_IP: '203.0.113.7' };

  test('DD-AUTH-051 手元の URL で IP の形なら値を返す', () => {
    expect(resolvePasskeyStartDevIp(local)).toBe('203.0.113.7');
    expect(resolvePasskeyStartDevIp({ ...local, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' })).toBe('203.0.113.7');
    expect(resolvePasskeyStartDevIp({ ...local, NEXT_PUBLIC_SUPABASE_URL: 'http://[::1]:54321' })).toBe('203.0.113.7');
  });

  test('DD-AUTH-051 ::1 のような IPv6 も値を返す', () => {
    expect(resolvePasskeyStartDevIp({ ...local, PASSKEY_START_DEV_IP: '::1' })).toBe('::1');
  });

  test('DD-AUTH-051 本番の URL・手元でない・未設定の URL は null', () => {
    expect(resolvePasskeyStartDevIp({ ...local, NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ ...local, NEXT_PUBLIC_SUPABASE_URL: 'https://localhost.evil.test' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ ...local, NEXT_PUBLIC_SUPABASE_URL: 'not a url' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ PASSKEY_START_DEV_IP: '203.0.113.7' })).toBeNull();
  });

  test('DD-AUTH-051 VERCEL=1 か VERCEL_ENV が設定されていれば null', () => {
    expect(resolvePasskeyStartDevIp({ ...local, VERCEL: '1' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ ...local, VERCEL_ENV: 'production' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ ...local, VERCEL_ENV: 'development' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ ...local, VERCEL_ENV: '' })).toBe('203.0.113.7');
  });

  test('DD-AUTH-051 IP でない文字列・空・未設定は null', () => {
    expect(resolvePasskeyStartDevIp({ ...local, PASSKEY_START_DEV_IP: 'localhost' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ ...local, PASSKEY_START_DEV_IP: '999.1.1.1' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ ...local, PASSKEY_START_DEV_IP: ' ' })).toBeNull();
    expect(resolvePasskeyStartDevIp({ NEXT_PUBLIC_SUPABASE_URL: local.NEXT_PUBLIC_SUPABASE_URL })).toBeNull();
  });
});

describe('DD-AUTH-051 環境を渡さない時は process.env を読む', () => {
  const NAMES = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PASSKEY_START_DEV_IP', 'NEXT_PUBLIC_SUPABASE_URL', 'VERCEL', 'VERCEL_ENV'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test('DD-AUTH-051 鍵と開発用の IP を process.env から読む', () => {
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_env';
    process.env.PASSKEY_START_DEV_IP = '203.0.113.9';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    expect(resolveStartSecretKey()).toEqual({ ok: true, key: 'sb_secret_env' });
    expect(resolvePasskeyStartDevIp()).toBe('203.0.113.9');
  });
});

