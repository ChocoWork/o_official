export {};

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const getClaimsMock = jest.fn();
const rpcMock = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { getClaims: getClaimsMock }, rpc: rpcMock })),
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

describe('verifyAccessToken / authenticateRequest', () => {
  let mod: typeof import('@/lib/supabase/server');

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    mod = await import('@/lib/supabase/server');
  });

  beforeEach(() => {
    getClaimsMock.mockReset();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: true, error: null });
  });

  describe('verifyAccessToken（暗号検証のみ）', () => {
    test('Cookie の access token だけで検証できる', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });

      const result = await mod.verifyAccessToken(requestWith({ cookie: 'sb-access-token=cookie-token' }));

      expect(getClaimsMock).toHaveBeenCalledWith('cookie-token', { allowExpired: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.sub).toBe('user-1');
      }
    });

    test('Authorization ヘッダーがあれば Cookie より優先する', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });

      await mod.verifyAccessToken(
        requestWith({ authorization: 'Bearer header-token', cookie: 'sb-access-token=cookie-token' }),
      );

      expect(getClaimsMock).toHaveBeenCalledWith('header-token', { allowExpired: false });
    });

    test('allowExpired を渡すと getClaims に委譲する', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });

      await mod.verifyAccessToken(requestWith({ cookie: 'sb-access-token=t' }), { allowExpired: true });

      expect(getClaimsMock).toHaveBeenCalledWith('t', { allowExpired: true });
    });

    test('トークンが無ければ検証を試みずに missing を返す', async () => {
      const result = await mod.verifyAccessToken(requestWith({}));

      expect(result).toEqual({ ok: false, reason: 'missing' });
      expect(getClaimsMock).not.toHaveBeenCalled();
    });

    test('署名検証に失敗したら invalid を返す', async () => {
      getClaimsMock.mockResolvedValue({ data: null, error: { message: 'bad signature' } });

      const result = await mod.verifyAccessToken(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    test('iss が自プロジェクトと一致しなければ拒否する', async () => {
      getClaimsMock.mockResolvedValue({
        data: { claims: buildClaims({ iss: 'https://attacker.supabase.co/auth/v1' }) },
        error: null,
      });

      const result = await mod.verifyAccessToken(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    test('aud が authenticated でなければ拒否する', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims({ aud: 'anon' }) }, error: null });

      const result = await mod.verifyAccessToken(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    test('aud が配列でも authenticated を含めば通す', async () => {
      getClaimsMock.mockResolvedValue({
        data: { claims: buildClaims({ aud: ['authenticated', 'other'] }) },
        error: null,
      });

      const result = await mod.verifyAccessToken(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result.ok).toBe(true);
    });

    test('失効済みセッションでも ok を返す（暗号検証しか見ないため）', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });
      rpcMock.mockResolvedValue({ data: false, error: null });

      const result = await mod.verifyAccessToken(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result.ok).toBe(true);
      expect(rpcMock).not.toHaveBeenCalled();
    });
  });

  describe('authenticateRequest（暗号検証 + 失効照合）', () => {
    test('セッションが生きていれば claims を返す', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });

      const result = await mod.authenticateRequest(requestWith({ cookie: 'sb-access-token=t' }));

      expect(rpcMock).toHaveBeenCalledWith('is_auth_session_active', { p_session_id: 'session-1' });
      expect(result.ok).toBe(true);
    });

    test('セッションが失効していれば revoked を返す', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });
      rpcMock.mockResolvedValue({ data: false, error: null });

      const result = await mod.authenticateRequest(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result).toEqual({ ok: false, reason: 'revoked' });
    });

    // 「失効している」と「失効しているか確認できなかった」を混ぜない。
    // 混ぜて 401 を返すと、クライアントは「トークンが古い」と解釈して
    // セッション更新を撃ち、DB 障害の最中に refresh が殺到して障害を増幅する。
    // アクセスを拒否する点は同じなので fail-closed は保たれている。
    test('失効照合が失敗したら revoked ではなく unavailable にする', async () => {
      getClaimsMock.mockResolvedValue({ data: { claims: buildClaims() }, error: null });
      rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });

      const result = await mod.authenticateRequest(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result).toEqual({ ok: false, reason: 'unavailable' });
    });

    test('session_id クレームが無ければ拒否する', async () => {
      getClaimsMock.mockResolvedValue({
        data: { claims: { ...buildClaims(), session_id: undefined } },
        error: null,
      });

      const result = await mod.authenticateRequest(requestWith({ cookie: 'sb-access-token=t' }));

      expect(result).toEqual({ ok: false, reason: 'revoked' });
      expect(rpcMock).not.toHaveBeenCalled();
    });
  });
});
