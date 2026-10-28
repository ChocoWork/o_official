/**
 * TOTP 確認の窓口（API-AUTH-018）の結合テスト。
 * 入力の形・役割・チャレンジ・コードの確かめ・書き戻しの各分岐を確かめる。
 * Cookie と sessions 行の書き戻しの中身は tests/integration/api/auth/mfa-verify.test.ts で本物の部品を通して確かめる。
 */
export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: (reason: string) =>
    require('next/server').NextResponse.json(
      { error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' },
      { status: reason === 'unavailable' ? 503 : 401 },
    ),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/features/auth/services/session', () => ({
  findSessionByRefreshHash: jest.fn(),
  persistNewSession: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { createClient } = require('@/lib/supabase/server');
const { authenticateRequest } = require('@/lib/auth/authenticate');
const { cookies } = require('next/headers');
const { findSessionByRefreshHash, persistNewSession } = require('@/features/auth/services/session');
const { logAudit } = require('@/lib/audit');

const FACTOR_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest(body: unknown, raw?: string) {
  return new Request('http://localhost/api/auth/mfa/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

const validBody = { factorId: FACTOR_ID, code: '123456' };

let mfa: { challenge: jest.Mock; verify: jest.Mock; getAuthenticatorAssuranceLevel: jest.Mock };

function setup(opts: {
  role?: string;
  challenge?: unknown;
  verify?: unknown;
  aal?: unknown;
  refreshCookie?: string | null;
  session?: unknown;
} = {}) {
  authenticateRequest.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: { role: opts.role ?? 'admin' } },
  });
  mfa = {
    challenge: jest.fn().mockResolvedValue(opts.challenge ?? { data: { id: 'challenge-1' }, error: null }),
    verify: jest.fn().mockResolvedValue(
      opts.verify ?? { data: { access_token: 'aal2-access', refresh_token: 'aal2-refresh' }, error: null },
    ),
    getAuthenticatorAssuranceLevel: jest
      .fn()
      .mockResolvedValue(opts.aal ?? { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
  };
  createClient.mockResolvedValue({ auth: { mfa } });
  const refreshCookie = opts.refreshCookie === undefined ? 'old-refresh' : opts.refreshCookie;
  cookies.mockResolvedValue({ get: jest.fn().mockReturnValue(refreshCookie ? { value: refreshCookie } : undefined) });
  findSessionByRefreshHash.mockResolvedValue(opts.session === undefined ? { id: 'sess-1' } : opts.session);
  persistNewSession.mockResolvedValue(undefined);
}

describe('POST /api/auth/mfa/verify', () => {
  let POST: (request: Request) => Promise<{ status: number; json: () => Promise<any> }>;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    POST = require('@/app/api/auth/mfa/verify/route').POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('API-AUTH-018 コードが通ったら aal2 の状態を 200 で返し、新しいトークン対を書き戻す', async () => {
    setup();

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ data: { role: 'admin', currentLevel: 'aal2', nextLevel: 'aal2', verified: true } });
    expect(mfa.challenge).toHaveBeenCalledWith({ factorId: FACTOR_ID });
    expect(mfa.verify).toHaveBeenCalledWith({ factorId: FACTOR_ID, challengeId: 'challenge-1', code: '123456' });
    expect(persistNewSession).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        accessToken: 'aal2-access',
        refreshToken: 'aal2-refresh',
        userId: 'user-1',
        previousSessionId: 'sess-1',
        previousRefreshToken: 'old-refresh',
      }),
    );
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:mfa:verify', limit: 20, windowSeconds: 600 }),
    );
  });

  test('API-AUTH-018 サポーターも通り、8桁のコードも受ける', async () => {
    setup({ role: 'supporter' });

    const res = await POST(makeRequest({ factorId: FACTOR_ID, code: '12345678' }));

    expect(res.status).toBe(200);
    expect((await res.json()).data.role).toBe('supporter');
  });

  test('API-AUTH-018 旧 refresh の Cookie が無ければ旧行を探さず、前の session を空にして書き戻す', async () => {
    setup({ refreshCookie: null });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(200);
    expect(findSessionByRefreshHash).not.toHaveBeenCalled();
    expect(persistNewSession).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ previousSessionId: null, previousRefreshToken: null }),
    );
  });

  test('API-AUTH-018 旧 refresh の行が見つからなくても書き戻しは前の session を空にして進む', async () => {
    setup({ session: null });

    await POST(makeRequest(validBody));

    expect(persistNewSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ previousSessionId: null, previousRefreshToken: 'old-refresh' }),
    );
  });

  test('API-AUTH-018 AAL の読み直しに失敗しても aal を null にして 200 で配る', async () => {
    setup({ aal: { data: null, error: { message: 'aal down' } } });

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.currentLevel).toBeNull();
    expect(body.data.nextLevel).toBeNull();
    expect(body.data.verified).toBe(true);
    expect(persistNewSession).toHaveBeenCalled();
  });

  test('API-AUTH-018 行の保存に失敗しても 200 で配り、mfa_verify の error を監査に残す', async () => {
    setup();
    persistNewSession.mockRejectedValue(new Error('db down'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mfa_verify', actor_id: 'user-1', outcome: 'error' }),
    );
  });

  test('API-AUTH-018 コードの成否を監査に残し、コードと Supabase の誤りの文は残さない', async () => {
    setup();
    await POST(makeRequest(validBody));

    setup({ verify: { data: null, error: { message: 'invalid' } } });
    await POST(makeRequest(validBody));

    expect(logAudit).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenNthCalledWith(1, {
      action: 'mfa_verify',
      actor_id: 'user-1',
      outcome: 'success',
      detail: 'verified',
    });
    expect(logAudit).toHaveBeenNthCalledWith(2, {
      action: 'mfa_verify',
      actor_id: 'user-1',
      outcome: 'failure',
      detail: 'invalid_code',
    });
    expect(JSON.stringify(logAudit.mock.calls)).not.toMatch(/123456|invalid'/);
  });

  test('API-AUTH-018 利用者単位の枠は検証済みの sub を鍵にし、尽きたら challenge を呼ばず 429', async () => {
    setup();
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      status: 429,
      json: async () => ({ error: 'Too many requests' }),
    });

    const res = await POST(makeRequest({ factorId: FACTOR_ID, code: '123456' }));

    expect(res.status).toBe(429);
    expect(enforceRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ endpoint: 'auth:mfa:verify', limit: 5, windowSeconds: 600, subject: 'user-1' }),
    );
    expect(mfa.challenge).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mfa_verify', outcome: 'failure', detail: 'account_rate_limited' }),
    );
  });

  test('API-AUTH-018 回数の制限に掛かったらその応答（429）を返し、何も確かめない', async () => {
    setup();
    enforceRateLimit.mockResolvedValue({ status: 429, json: async () => ({ error: 'Too many requests' }) });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(429);
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(mfa.challenge).not.toHaveBeenCalled();
  });

  test('API-AUTH-018 回数の制限の部品が落ちたら 500 で止まり、確かめへ進まない（SEC-AUTH-013-AC-02）', async () => {
    setup();
    enforceRateLimit.mockRejectedValue(new Error('limiter down'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(mfa.challenge).not.toHaveBeenCalled();
  });

  test.each([
    ['本文が JSON でない', undefined, '{not json'],
    ['factorId が UUID でない', { factorId: 'abc', code: '123456' }, undefined],
    ['factorId が無い', { code: '123456' }, undefined],
    ['code が5桁', { factorId: FACTOR_ID, code: '12345' }, undefined],
    ['code が9桁', { factorId: FACTOR_ID, code: '123456789' }, undefined],
    ['code に数字以外が混じる', { factorId: FACTOR_ID, code: '12a456' }, undefined],
    ['code が数値型', { factorId: FACTOR_ID, code: 123456 }, undefined],
  ])('API-AUTH-018 形が合わない入力（%s）は 400 を返し、認証もチャレンジもしない', async (_name, body, raw) => {
    setup();

    const res = await POST(makeRequest(body, raw));

    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe('string');
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(mfa.challenge).not.toHaveBeenCalled();
  });

  test('API-AUTH-018 code の形の誤りには桁数の案内を返す', async () => {
    setup();

    const res = await POST(makeRequest({ factorId: FACTOR_ID, code: 'abc' }));

    expect((await res.json()).error).toContain('6〜8桁');
  });

  test('API-AUTH-018 認証に失敗したら 401 を返し、チャレンジを作らない', async () => {
    setup();
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthorized' });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(401);
    expect(mfa.challenge).not.toHaveBeenCalled();
  });

  test('API-AUTH-018 認証の部品が使えない時は 503 を返す', async () => {
    setup();
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(503);
  });

  test('API-AUTH-018 一般の会員には 403 を返し、チャレンジを作らない', async () => {
    setup({ role: 'user' });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mfa.challenge).not.toHaveBeenCalled();
    expect(persistNewSession).not.toHaveBeenCalled();
  });

  test('API-AUTH-018 チャレンジの失敗が「見つからない」なら 404 を返す', async () => {
    setup({ challenge: { data: null, error: { message: 'Factor Not Found' } } });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(404);
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  test('API-AUTH-018 そのほかのチャレンジの失敗や空の結果は 400 を返す', async () => {
    setup({ challenge: { data: null, error: { message: 'rate limited' } } });
    expect((await POST(makeRequest(validBody))).status).toBe(400);

    setup({ challenge: { data: null, error: null } });
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(400);
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  test('API-AUTH-018 コードが誤りなら 400 を返し、トークンを書き戻さない', async () => {
    setup({ verify: { data: null, error: { message: 'Invalid TOTP code' } } });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '認証コードが正しくありません。' });
    expect(persistNewSession).not.toHaveBeenCalled();
    expect(mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  test('API-AUTH-018 想定外の例外は 500 の汎用エラーに丸める', async () => {
    setup();
    authenticateRequest.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
