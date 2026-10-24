// パスワード再設定リンクの確かめの窓口（DD-AUTH-023）の単体テスト。
// 再設定の Cookie の署名・寿命は本物の共有部品で作り、DB・制限・監査だけを差し替える。

jest.mock('next/server', () => {
  const build = (status: number, body: unknown) => {
    const cookieCalls: Array<Record<string, unknown>> = [];
    return {
      status,
      _body: body,
      _cookies: cookieCalls,
      headers: new Headers(),
      cookies: {
        set: (cookie: Record<string, unknown>) => {
          cookieCalls.push(cookie);
        },
      },
      json: async () => body,
    };
  };
  return {
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => build(init?.status ?? 200, body),
      redirect: (url: URL | string, init?: { status?: number }) => {
        const res = build(init?.status ?? 307, null);
        res.headers.set('location', String(url));
        return res;
      },
    },
  };
});

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockGetRequestOrigin = jest.fn();
jest.mock('@/lib/redirect', () => ({
  getRequestOrigin: (...args: unknown[]) => mockGetRequestOrigin(...args),
}));

const mockFindAuthUserIdByEmail = jest.fn();
jest.mock('@/features/auth/services/auth-admin-user', () => ({
  findAuthUserIdByEmail: (...args: unknown[]) => mockFindAuthUserIdByEmail(...args),
}));

// token_hash で引く 1 本のチェーン。呼ばれた条件を記録し、最後の maybeSingle で結果を返す。
const mockSelect = jest.fn();
const mockEqTokenHash = jest.fn();
const mockEqUsed = jest.fn();
const mockGte = jest.fn();
const mockMaybeSingle = jest.fn();
const mockFrom = jest.fn();
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));

import crypto from 'crypto';
import { GET, POST } from '@/app/api/auth/password-reset/link/route';
import { passwordResetSessionCookieName } from '@/lib/cookie';
import { verifyPasswordResetSessionToken } from '@/features/auth/services/password-reset-session';

const ORIGIN = 'https://shop.example.com';

type FakeResponse = {
  status: number;
  _body: unknown;
  _cookies: Array<Record<string, unknown>>;
  headers: Headers;
};

function getRequest(query: string) {
  return { url: `${ORIGIN}/api/auth/password-reset/link${query}` } as unknown as Request;
}

function postRequest(body: unknown) {
  return {
    url: `${ORIGIN}/api/auth/password-reset/link`,
    json: async () => body,
  } as unknown as Request;
}

function brokenPostRequest() {
  return {
    url: `${ORIGIN}/api/auth/password-reset/link`,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  } as unknown as Request;
}

function expectNoStoreHeaders(res: FakeResponse) {
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
}

describe('DD-AUTH-023 パスワード再設定リンクの確かめの窓口', () => {
  let consoleError: jest.SpyInstance;
  const originalSecret = process.env.JWT_SECRET;
  const originalResetSecret = process.env.PASSWORD_RESET_SESSION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.JWT_SECRET = 'test-jwt-secret';
    delete process.env.PASSWORD_RESET_SESSION_SECRET;

    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    mockGetRequestOrigin.mockReturnValue(ORIGIN);
    mockFindAuthUserIdByEmail.mockResolvedValue({ status: 'found', userId: 'user-from-email' });

    mockMaybeSingle.mockResolvedValue({
      data: { id: 'token-row-1', user_id: 'user-1', email: 'user@example.com' },
      error: null,
    });
    mockGte.mockImplementation(() => ({ maybeSingle: mockMaybeSingle }));
    mockEqUsed.mockImplementation(() => ({ gte: mockGte }));
    mockEqTokenHash.mockImplementation(() => ({ eq: mockEqUsed }));
    mockSelect.mockImplementation(() => ({ eq: mockEqTokenHash }));
    mockFrom.mockImplementation(() => ({ select: mockSelect }));
    mockCreateServiceRoleClient.mockResolvedValue({ from: (...args: unknown[]) => mockFrom(...args) });
  });

  afterEach(() => {
    consoleError.mockRestore();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (originalResetSecret === undefined) delete process.env.PASSWORD_RESET_SESSION_SECRET;
    else process.env.PASSWORD_RESET_SESSION_SECRET = originalResetSecret;
  });

  describe('GET', () => {
    it('DD-AUTH-023 GET で token があれば確認の画面へ 303 で送り、印は確かめも消費もしない', async () => {
      const res = (await GET(getRequest('?token=abc%20123'))) as unknown as FakeResponse;

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/auth/password-reset/verify?token=abc+123`);
      expectNoStoreHeaders(res);
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-AUTH-023 GET で token が無ければ missing_token を残して link_invalid の画面へ 303', async () => {
      const res = (await GET(getRequest(''))) as unknown as FakeResponse;

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/auth/password-reset?error=link_invalid`);
      expectNoStoreHeaders(res);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        outcome: 'failure',
        detail: 'missing_token',
      });
    });

    it('DD-AUTH-023 GET で token が空文字でも無いものとして扱う', async () => {
      const res = (await GET(getRequest('?token='))) as unknown as FakeResponse;

      expect(res.headers.get('location')).toBe(`${ORIGIN}/auth/password-reset?error=link_invalid`);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'missing_token' }));
    });
  });

  describe('POST', () => {
    it('DD-AUTH-023 有効な印なら 200 と署名した再設定の Cookie を出し、success を残す（行に利用者の id がある）', async () => {
      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(200);
      expect(res._body).toEqual({ ok: true, redirectTo: '/auth/password-reset' });
      expectNoStoreHeaders(res);

      // DB には生の印ではなく SHA-256 で引く。未使用かつ期限の内だけ
      const expectedHash = crypto.createHash('sha256').update('raw-token').digest('hex');
      expect(mockFrom).toHaveBeenCalledWith('password_reset_tokens');
      expect(mockSelect).toHaveBeenCalledWith('id, user_id, email');
      expect(mockEqTokenHash).toHaveBeenCalledWith('token_hash', expectedHash);
      expect(mockEqUsed).toHaveBeenCalledWith('used', false);
      expect(mockGte).toHaveBeenCalledWith('expires_at', expect.any(String));
      expect(Number.isNaN(new Date(mockGte.mock.calls[0][1] as string).getTime())).toBe(false);

      expect(res._cookies).toHaveLength(1);
      const cookie = res._cookies[0];
      expect(cookie.name).toBe(passwordResetSessionCookieName);
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'strict', maxAge: 600 });
      expect(verifyPasswordResetSessionToken(cookie.value as string)).toMatchObject({
        userId: 'user-1',
        email: 'user@example.com',
        tokenId: 'token-row-1',
      });

      // 利用者の id が行にあるのでメールからは引かない
      expect(mockFindAuthUserIdByEmail).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        actor_email: 'user@example.com',
        outcome: 'success',
        resource_id: 'user-1',
      });
    });

    it('DD-AUTH-023 行に利用者の id が無ければ宛先のメールから引いて 200 を返す', async () => {
      mockMaybeSingle.mockResolvedValue({
        data: { id: 'token-row-2', user_id: null, email: 'legacy@example.com' },
        error: null,
      });

      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(200);
      expect(mockFindAuthUserIdByEmail).toHaveBeenCalledWith(expect.anything(), 'legacy@example.com');
      expect(verifyPasswordResetSessionToken(res._cookies[0].value as string)).toMatchObject({
        userId: 'user-from-email',
        email: 'legacy@example.com',
        tokenId: 'token-row-2',
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success', resource_id: 'user-from-email' }),
      );
    });

    it('DD-AUTH-023 回数の制限が応答を返したらそれを返し、本文も DB も見ない', async () => {
      const limited = { status: 429, _body: { error: 'Too many requests' } };
      mockEnforceRateLimit.mockResolvedValueOnce(limited);
      const req = postRequest({ token: 'raw-token' });
      const jsonSpy = jest.spyOn(req, 'json');

      const res = await POST(req);

      expect(res).toBe(limited);
      expect(mockEnforceRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:password_reset_link', limit: 20, windowSeconds: 600 }),
      );
      expect(jsonSpy).not.toHaveBeenCalled();
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-AUTH-023 回数の制限の呼び出しが投げたら記録して先へ進む', async () => {
      mockEnforceRateLimit.mockRejectedValueOnce(new Error('redis down'));

      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(200);
      expect(consoleError).toHaveBeenCalledWith(
        'Rate limit middleware error (password-reset-link):',
        expect.any(Error),
      );
    });

    it.each([
      ['本文が JSON でない', 'broken'],
      ['token が数字', { token: 12345 }],
      ['token が空', { token: '' }],
      ['token が無い', {}],
      ['本文が null', null],
    ])('DD-AUTH-023 token が使えない入力（%s）は missing_token を残して 400 link_invalid', async (_label, body) => {
      const req = body === 'broken' ? brokenPostRequest() : postRequest(body);

      const res = (await POST(req)) as unknown as FakeResponse;

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'link_invalid' });
      expectNoStoreHeaders(res);
      expect(res._cookies).toHaveLength(0);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        outcome: 'failure',
        detail: 'missing_token',
      });
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-AUTH-023 行の照会が誤りなら error を残して 400 link_expired', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });

      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'link_expired' });
      expectNoStoreHeaders(res);
      expect(res._cookies).toHaveLength(0);
      expect(consoleError).toHaveBeenCalledWith('Password reset link lookup error:', { message: 'db down' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        outcome: 'error',
        detail: 'db down',
      });
    });

    it('DD-AUTH-023 行が無ければ（使用済み・期限切れ・違う印）invalid_or_expired_token を残して 400 link_expired', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });

      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'link_expired' });
      expect(res._cookies).toHaveLength(0);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        outcome: 'failure',
        detail: 'invalid_or_expired_token',
      });
    });

    it('DD-AUTH-023 メールの照会が失敗したら link_expired とは言わず user_lookup_failed を残して 500 internal_error', async () => {
      mockMaybeSingle.mockResolvedValue({
        data: { id: 'token-row-3', user_id: null, email: 'legacy@example.com' },
        error: null,
      });
      mockFindAuthUserIdByEmail.mockResolvedValue({ status: 'error', message: 'rpc_failed' });

      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'internal_error' });
      expectNoStoreHeaders(res);
      expect(res._cookies).toHaveLength(0);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        actor_email: 'legacy@example.com',
        outcome: 'error',
        detail: 'user_lookup_failed',
      });
    });

    it('DD-AUTH-023 メールのアカウントが無ければ user_not_found を残して 400 link_expired', async () => {
      mockMaybeSingle.mockResolvedValue({
        data: { id: 'token-row-4', user_id: null, email: 'gone@example.com' },
        error: null,
      });
      mockFindAuthUserIdByEmail.mockResolvedValue({ status: 'not_found' });

      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'link_expired' });
      expect(res._cookies).toHaveLength(0);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        actor_email: 'gone@example.com',
        outcome: 'error',
        detail: 'user_not_found',
      });
    });

    it('DD-AUTH-023 照会が投げたら 400 link_expired で返し、no-store を付ける', async () => {
      mockMaybeSingle.mockRejectedValue(new Error('network'));

      const res = (await POST(postRequest({ token: 'raw-token' }))) as unknown as FakeResponse;

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'link_expired' });
      expectNoStoreHeaders(res);
      expect(consoleError).toHaveBeenCalledWith('Password reset link error:', expect.any(Error));
    });

    it('DD-AUTH-023 同じ印で何度呼んでも行を書き換えない（読み取りだけ）', async () => {
      await POST(postRequest({ token: 'raw-token' }));
      await POST(postRequest({ token: 'raw-token' }));

      const chainCalls = mockFrom.mock.results.map((r) => Object.keys(r.value as object));
      for (const keys of chainCalls) {
        expect(keys).toEqual(['select']);
      }
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });
  });
});
