/**
 * DD-AUTH-031 TOTP の確認の窓口（src/app/api/auth/mfa/verify/route.ts）の単体テスト。
 * 共有部品（回数の制限・client の作成・認証・セッションの保存・監査・Cookie）は差し替え、窓口の分岐だけを確かめる。
 */

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn((reason: string) => ({
    status: reason === 'unavailable' ? 503 : 401,
    json: async () => ({ error: reason }),
  })),
}));

jest.mock('@/features/auth/services/session', () => ({
  findSessionByRefreshHash: jest.fn(),
  persistNewSession: jest.fn(),
}));

jest.mock('@/lib/cookie', () => ({
  refreshCookieName: 'sb-refresh-token',
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

import { cookies } from 'next/headers';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { findSessionByRefreshHash, persistNewSession } from '@/features/auth/services/session';
import { logAudit } from '@/lib/audit';
import { POST } from '@/app/api/auth/mfa/verify/route';

const mockCookies = cookies as jest.Mock;
const mockRateLimit = enforceRateLimit as jest.Mock;
const mockCreateClient = createClient as jest.Mock;
const mockAuthenticate = authenticateRequest as jest.Mock;
const mockFailure = authFailureResponse as jest.Mock;
const mockFindSession = findSessionByRefreshHash as jest.Mock;
const mockPersist = persistNewSession as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

const FACTOR_ID = '11111111-1111-4111-8111-111111111111';

const challenge = jest.fn();
const verify = jest.fn();
const getAal = jest.fn();
const cookieGet = jest.fn();
let errorSpy: jest.SpyInstance;

function buildRequest(body?: string) {
  return new Request('http://localhost/api/auth/mfa/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return buildRequest(JSON.stringify({ factorId: FACTOR_ID, code: '123456', ...overrides }));
}

function authAs(role?: unknown) {
  mockAuthenticate.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: role === undefined ? undefined : { role } },
  });
}

async function call(request: Request) {
  const res = await POST(request);
  return { res, status: res.status, body: await res.json() };
}

describe('POST /api/auth/mfa/verify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRateLimit.mockResolvedValue(undefined);
    mockCreateClient.mockResolvedValue({ auth: { mfa: { challenge, verify, getAuthenticatorAssuranceLevel: getAal } } });
    authAs('admin');
    challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    verify.mockResolvedValue({
      data: { access_token: 'aal2-access', refresh_token: 'aal2-refresh' },
      error: null,
    });
    getAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
    cookieGet.mockReturnValue({ value: 'old-refresh' });
    mockCookies.mockResolvedValue({ get: cookieGet });
    mockFindSession.mockResolvedValue({ id: 'sess-1' });
    mockPersist.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-031 管理者の正しいコードで 200 を返し、aal2 のトークン対を書き戻す', async () => {
    const { res, status, body } = await call(validRequest());

    expect(status).toBe(200);
    expect(body).toEqual({
      data: { role: 'admin', currentLevel: 'aal2', nextLevel: 'aal2', verified: true },
    });
    expect(challenge).toHaveBeenCalledWith({ factorId: FACTOR_ID });
    expect(verify).toHaveBeenCalledWith({ factorId: FACTOR_ID, challengeId: 'challenge-1', code: '123456' });
    expect(mockPersist).toHaveBeenCalledWith(res, {
      accessToken: 'aal2-access',
      refreshToken: 'aal2-refresh',
      userId: 'user-1',
      previousSessionId: 'sess-1',
      previousRefreshToken: 'old-refresh',
    });
    expect(cookieGet).toHaveBeenCalledWith('sb-refresh-token');
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:mfa:verify', limit: 20, windowSeconds: 600 }),
    );
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-AUTH-031 サポーターも確認できる', async () => {
    authAs('supporter');

    const { status, body } = await call(validRequest());

    expect(status).toBe(200);
    expect(body.data.role).toBe('supporter');
  });

  it('DD-AUTH-031 回数の制限が応答を返したらその応答を返し、先へ進まない', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too Many Requests' }) };
    mockRateLimit.mockResolvedValue(limited);

    const res = await POST(validRequest());

    expect(res).toBe(limited);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(challenge).not.toHaveBeenCalled();
  });

  it('DD-AUTH-031 回数の制限の呼び出しが投げたら記録して先へ進む', async () => {
    mockRateLimit.mockRejectedValue(new Error('limiter down'));

    const { status } = await call(validRequest());

    expect(status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      '[auth.mfa.verify] rate limit middleware error:',
      expect.any(Error),
    );
  });

  it('DD-AUTH-031 本文が JSON でなければ形の文をつないで 400', async () => {
    const { status, body } = await call(buildRequest('not json'));

    expect(status).toBe(400);
    expect(body.error).toEqual(expect.any(String));
    expect(body.error.length).toBeGreaterThan(0);
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('DD-AUTH-031 コードが5桁なら 400 でコードの桁の案内を返す', async () => {
    const { status, body } = await call(validRequest({ code: '12345' }));

    expect(status).toBe(400);
    expect(body.error).toBe('認証コードは6〜8桁の数字で入力してください。');
    expect(challenge).not.toHaveBeenCalled();
  });

  it('DD-AUTH-031 factorId が UUID でなく、コードも誤りなら両方の文をつないで 400', async () => {
    const { status, body } = await call(validRequest({ factorId: 'abc', code: 'abcdef' }));

    expect(status).toBe(400);
    expect(body.error).toContain('認証コードは6〜8桁の数字で入力してください。');
    expect(body.error).toContain(' ');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unavailable'])(
    'DD-AUTH-031 確かめが通らない時（%s）は共有部品の失敗の応答を返す',
    async (reason) => {
      mockAuthenticate.mockResolvedValue({ ok: false, reason });

      const { status } = await call(validRequest());

      expect(mockFailure).toHaveBeenCalledWith(reason);
      expect(status).toBe(reason === 'unavailable' ? 503 : 401);
      expect(challenge).not.toHaveBeenCalled();
    },
  );

  it.each([['user'], ['owner'], [undefined]])(
    'DD-AUTH-031 一般の会員・知らない役割・役割が無い時（%p）は 403',
    async (role) => {
      authAs(role);

      const { status, body } = await call(validRequest());

      expect(status).toBe(403);
      expect(body).toEqual({ error: 'Forbidden' });
      expect(challenge).not.toHaveBeenCalled();
    },
  );

  it('DD-AUTH-031 チャレンジの誤りの文が not found なら 404', async () => {
    challenge.mockResolvedValue({ data: null, error: { message: 'Factor Not Found' } });

    const { status, body } = await call(validRequest());

    expect(status).toBe(404);
    expect(body).toEqual({ error: '対象のMFA要素が見つかりません。' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('DD-AUTH-031 チャレンジのほかの誤りは 400', async () => {
    challenge.mockResolvedValue({ data: null, error: { message: 'rate limited' } });

    const { status, body } = await call(validRequest());

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'MFAチャレンジの作成に失敗しました。' });
  });

  it('DD-AUTH-031 チャレンジの誤りに文が無ければ 400', async () => {
    challenge.mockResolvedValue({ data: null, error: {} });

    const { status, body } = await call(validRequest());

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'MFAチャレンジの作成に失敗しました。' });
  });

  it('DD-AUTH-031 チャレンジのデータが無く誤りも無い時は 400', async () => {
    challenge.mockResolvedValue({ data: null, error: null });

    const { status, body } = await call(validRequest());

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'MFAチャレンジの作成に失敗しました。' });
  });

  it('DD-AUTH-031 コードの誤りは 400 で、書き戻しも監査もしない', async () => {
    verify.mockResolvedValue({ data: null, error: { message: 'invalid code' } });

    const { status, body } = await call(validRequest());

    expect(status).toBe(400);
    expect(body).toEqual({ error: '認証コードが正しくありません。' });
    expect(getAal).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-AUTH-031 AAL の読み直しが誤りなら記録して続け、今・次は null', async () => {
    getAal.mockResolvedValue({ data: null, error: { message: 'aal down' } });

    const { status, body } = await call(validRequest());

    expect(status).toBe(200);
    expect(body.data).toEqual({ role: 'admin', currentLevel: null, nextLevel: null, verified: true });
    expect(errorSpy).toHaveBeenCalledWith(
      '[auth.mfa.verify] failed to read AAL after verification:',
      expect.objectContaining({ message: 'aal down' }),
    );
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-031 AAL の今・次が無ければ null で返す', async () => {
    getAal.mockResolvedValue({ data: {}, error: null });

    const { body } = await call(validRequest());

    expect(body.data.currentLevel).toBeNull();
    expect(body.data.nextLevel).toBeNull();
  });

  it('DD-AUTH-031 前の refresh の Cookie が無ければ前の行を引かず、前の印は null', async () => {
    cookieGet.mockReturnValue(undefined);

    const { res, status } = await call(validRequest());

    expect(status).toBe(200);
    expect(mockFindSession).not.toHaveBeenCalled();
    expect(mockPersist).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ previousSessionId: null, previousRefreshToken: null }),
    );
  });

  it('DD-AUTH-031 前の refresh の Cookie があっても行が無ければ前の行の id は null', async () => {
    mockFindSession.mockResolvedValue(null);

    const { res } = await call(validRequest());

    expect(mockFindSession).toHaveBeenCalledWith('old-refresh');
    expect(mockPersist).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ previousSessionId: null, previousRefreshToken: 'old-refresh' }),
    );
  });

  it('DD-AUTH-031 書き戻しが投げても mfa_verify の error を残して 200 を返す', async () => {
    mockPersist.mockRejectedValue(new Error('db down'));

    const { status, body } = await call(validRequest());

    expect(status).toBe(200);
    expect(body.data.verified).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'mfa_verify',
      actor_id: 'user-1',
      outcome: 'error',
      detail: 'Error: db down',
    });
  });

  it('DD-AUTH-031 client の作成が投げたら 500', async () => {
    mockCreateClient.mockRejectedValue(new Error('boom'));

    const { status, body } = await call(validRequest());

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
  });
});
