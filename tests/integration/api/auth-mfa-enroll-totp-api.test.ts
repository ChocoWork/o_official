/**
 * TOTP 登録の窓口（API-AUTH-017）の結合テスト。
 * 順番（制限 → 形 → 認証 → 役割 → 一覧 → 確かめ済み → 未確認の除去 → 登録）の各分岐を確かめる。
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

const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { createClient } = require('@/lib/supabase/server');
const { authenticateRequest } = require('@/lib/auth/authenticate');

function makeRequest(body?: unknown) {
  return new Request('http://localhost/api/auth/mfa/enroll-totp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const enrolled = (qr: string) => ({
  data: {
    id: 'factor-new',
    friendly_name: 'Fresh',
    totp: { qr_code: qr, secret: 'SECRET', uri: 'otpauth://totp/x' },
  },
  error: null,
});

let mfa: { listFactors: jest.Mock; unenroll: jest.Mock; enroll: jest.Mock };

function setup(opts: { role?: string; totp?: unknown[]; listError?: unknown; enroll?: unknown }) {
  authenticateRequest.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: { role: opts.role ?? 'admin' } },
  });
  mfa = {
    listFactors: jest
      .fn()
      .mockResolvedValue(
        opts.listError ? { data: null, error: opts.listError } : { data: { totp: opts.totp ?? [] }, error: null },
      ),
    unenroll: jest.fn().mockResolvedValue({ error: null }),
    enroll: jest.fn().mockResolvedValue(opts.enroll ?? enrolled('data:image/svg+xml;utf8,<svg/>')),
  };
  createClient.mockResolvedValue({ auth: { mfa } });
}

describe('POST /api/auth/mfa/enroll-totp', () => {
  let POST: (request: Request) => Promise<{ status: number; json: () => Promise<any> }>;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    POST = require('@/app/api/auth/mfa/enroll-totp/route').POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('API-AUTH-017 管理者が未登録なら QR・秘密・URI を 200 で返す', async () => {
    setup({ enroll: enrolled('data:image/png;base64,AAAA') });

    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      factorId: 'factor-new',
      friendlyName: 'Fresh',
      qrCode: 'data:image/png;base64,AAAA',
      secret: 'SECRET',
      uri: 'otpauth://totp/x',
    });
    expect(mfa.enroll).toHaveBeenCalledWith({ factorType: 'totp' });
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:mfa:enroll-totp', limit: 10, windowSeconds: 600 }),
    );
  });

  test('API-AUTH-017 サポーターも登録でき、本文が空でも通る', async () => {
    setup({ role: 'supporter' });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(mfa.enroll).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-017 SVG の QR は画像として表示できる data URI に直す', async () => {
    setup({ enroll: enrolled('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });

    const body = await (await POST(makeRequest({}))).json();

    expect(body.data.qrCode).toBe(
      `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`,
    );
  });

  test('API-AUTH-017 data URI でも SVG でもない QR は前後の空白だけ除いて返し、空白だけなら空にする', async () => {
    setup({ enroll: enrolled('  https://example.com/qr.png  ') });
    expect((await (await POST(makeRequest({}))).json()).data.qrCode).toBe('https://example.com/qr.png');

    setup({ enroll: enrolled('   ') });
    expect((await (await POST(makeRequest({}))).json()).data.qrCode).toBe('');
  });

  test('API-AUTH-017 回数の制限に掛かったらその応答（429）を返し、認証もしない', async () => {
    setup({});
    enforceRateLimit.mockResolvedValue({ status: 429, json: async () => ({ error: 'Too many requests' }) });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(429);
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 回数の制限の部品が落ちても処理を続ける', async () => {
    setup({});
    enforceRateLimit.mockRejectedValue(new Error('limiter down'));

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(200);
  });

  test('API-AUTH-017 forceReEnroll が真偽値でなければ 400 を返し、認証もしない', async () => {
    setup({});

    const res = await POST(makeRequest({ forceReEnroll: 'yes' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad Request' });
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 認証に失敗したら 401 を返し、要素も引かない', async () => {
    setup({});
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthorized' });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(401);
    expect(mfa.listFactors).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 認証の部品が使えない時は 503 を返す', async () => {
    setup({});
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(503);
  });

  test('API-AUTH-017 一般の会員には 403 を返し、要素を作らない', async () => {
    setup({ role: 'user' });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mfa.listFactors).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 要素の一覧の取得に失敗したら 500 を返す', async () => {
    setup({ listError: { message: 'down' } });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to list factors' });
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 確かめ済みの要素があれば 409 で既存の要素を知らせ、作り直さない', async () => {
    setup({ totp: [{ id: 'f-old', factor_type: 'totp', status: 'verified', friendly_name: 'Old' }] });

    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe('MFA factor already enrolled');
    expect(body.data).toEqual({ factorId: 'f-old', factorType: 'totp', friendlyName: 'Old' });
    expect(mfa.unenroll).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 確かめ済みの要素の名前が無ければ 409 の応答でも null にする', async () => {
    setup({ totp: [{ id: 'f-old', factor_type: 'totp', status: 'verified' }] });

    const body = await (await POST(makeRequest({}))).json();

    expect(body.data.friendlyName).toBeNull();
  });

  test('API-AUTH-017 確かめ済みがある時に forceReEnroll を求めても 403 で、要素を外さない', async () => {
    setup({ totp: [{ id: 'f-old', factor_type: 'totp', status: 'verified' }] });

    const res = await POST(makeRequest({ forceReEnroll: true }));

    expect(res.status).toBe(403);
    expect(mfa.unenroll).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 前の登録の途中で残った未確認の要素は外してから登録する', async () => {
    setup({ totp: [{ id: 'f-un', factor_type: 'totp', status: 'unverified' }] });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(200);
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: 'f-un' });
    expect(mfa.unenroll.mock.invocationCallOrder[0]).toBeLessThan(mfa.enroll.mock.invocationCallOrder[0]);
  });

  test('API-AUTH-017 未確認の要素が無ければ外す呼び出しをしない', async () => {
    setup({});

    await POST(makeRequest({}));

    expect(mfa.unenroll).not.toHaveBeenCalled();
  });

  test('API-AUTH-017 確かめ済みが無い時に forceReEnroll を求めると時刻入りの名前を付けて登録する', async () => {
    setup({});

    const res = await POST(makeRequest({ forceReEnroll: true }));

    expect(res.status).toBe(200);
    expect(mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: expect.stringMatching(/^Admin TOTP \d{4}-\d{2}-\d{2}T/),
    });
  });

  test('API-AUTH-017 登録が insufficient_aal で拒まれたら 403 を返す', async () => {
    setup({ enroll: { data: null, error: { code: 'insufficient_aal', message: 'aal' } } });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(403);
  });

  test('API-AUTH-017 登録が名前の衝突で拒まれたら 409 を返す', async () => {
    setup({ enroll: { data: null, error: { code: 'mfa_factor_name_conflict', message: 'dup' } } });

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(409);
  });

  test('API-AUTH-017 そのほかの登録の失敗や空の結果は 500 を返す', async () => {
    setup({ enroll: { data: null, error: { code: 'other', message: 'x' } } });
    expect((await POST(makeRequest({}))).status).toBe(500);

    setup({ enroll: { data: null, error: null } });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to enroll MFA factor' });
  });

  test('API-AUTH-017 想定外の例外は 500 の汎用エラーに丸める', async () => {
    setup({});
    authenticateRequest.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
