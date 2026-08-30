export {};

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const getClaimsMock = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { getClaims: getClaimsMock } })),
}));

const SUPABASE_URL = 'https://project.supabase.co';

const buildClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: `${SUPABASE_URL}/auth/v1`,
  aud: 'authenticated',
  sub: 'user-1',
  aal: 'aal2',
  session_id: 'session-1',
  ...overrides,
});

const requestWith = (headers: Record<string, string>) =>
  new Request('http://localhost/api/admin/anything', { headers });

describe('verifyAccessToken', () => {
  let verifyAccessToken: typeof import('@/lib/supabase/server').verifyAccessToken;

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    ({ verifyAccessToken } = await import('@/lib/supabase/server'));
  });

  beforeEach(() => {
    getClaimsMock.mockReset();
  });

  test('Cookie の access token だけで検証できる', async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });

    const result = await verifyAccessToken(requestWith({ cookie: 'sb-access-token=cookie-token' }));

    expect(getClaimsMock).toHaveBeenCalledWith('cookie-token');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('user-1');
    }
  });

  test('Authorization ヘッダーがあれば Cookie より優先する', async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });

    await verifyAccessToken(
      requestWith({ authorization: 'Bearer header-token', cookie: 'sb-access-token=cookie-token' }),
    );

    expect(getClaimsMock).toHaveBeenCalledWith('header-token');
  });

  test('トークンが無ければ検証を試みずに missing を返す', async () => {
    const result = await verifyAccessToken(requestWith({}));

    expect(result).toEqual({ ok: false, reason: 'missing' });
    expect(getClaimsMock).not.toHaveBeenCalled();
  });

  test('署名検証に失敗したら invalid を返す', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'bad signature' } });

    const result = await verifyAccessToken(requestWith({ cookie: 'sb-access-token=cookie-token' }));

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  test('iss が自プロジェクトと一致しなければ拒否する', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: buildClaims({ iss: 'https://attacker.supabase.co/auth/v1' }) },
      error: null,
    });

    const result = await verifyAccessToken(requestWith({ cookie: 'sb-access-token=cookie-token' }));

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  test('aud が authenticated でなければ拒否する', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: buildClaims({ aud: 'anon' }) },
      error: null,
    });

    const result = await verifyAccessToken(requestWith({ cookie: 'sb-access-token=cookie-token' }));

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  test('aud が配列でも authenticated を含めば通す', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: buildClaims({ aud: ['authenticated', 'other'] }) },
      error: null,
    });

    const result = await verifyAccessToken(requestWith({ cookie: 'sb-access-token=cookie-token' }));

    expect(result.ok).toBe(true);
  });

  test('検証用クライアントは JWKS キャッシュ共有のため使い回す', async () => {
    const { createClient } = require('@supabase/supabase-js');
    (createClient as jest.Mock).mockClear();
    getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });

    await Promise.all([
      verifyAccessToken(requestWith({ cookie: 'sb-access-token=a' })),
      verifyAccessToken(requestWith({ cookie: 'sb-access-token=b' })),
    ]);

    expect((createClient as jest.Mock).mock.calls.length).toBe(0);
  });
});
