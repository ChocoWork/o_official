/**
 * DD-AUTH-030 TOTP の登録の窓口（src/app/api/auth/mfa/enroll-totp/route.ts）の単体テスト。
 * 共有部品（回数の制限・client の作成・認証）は差し替え、窓口の分岐だけを確かめる。
 */

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
  authFailureResponse: jest.fn((reason: string) => ({
    status: reason === 'unavailable' ? 503 : 401,
    json: async () => ({ error: reason }),
  })),
}));

import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { POST } from '@/app/api/auth/mfa/enroll-totp/route';

const mockRateLimit = enforceRateLimit as jest.Mock;
const mockCreateClient = createClient as jest.Mock;
const mockAuthenticate = authenticateRequest as jest.Mock;
const mockFailure = authFailureResponse as jest.Mock;

const listFactors = jest.fn();
const unenroll = jest.fn();
const enroll = jest.fn();
let errorSpy: jest.SpyInstance;

function buildRequest(body?: string) {
  return new Request('http://localhost/api/auth/mfa/enroll-totp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function jsonRequest(payload: unknown) {
  return buildRequest(JSON.stringify(payload));
}

function authAs(role?: unknown) {
  mockAuthenticate.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: role === undefined ? undefined : { role } },
  });
}

function enrollOk(overrides: { qr?: string; friendlyName?: string | null } = {}) {
  enroll.mockResolvedValue({
    data: {
      id: 'new-factor',
      friendly_name: overrides.friendlyName === undefined ? 'Authenticator' : overrides.friendlyName,
      totp: {
        qr_code: overrides.qr ?? 'data:image/svg+xml;utf8,<svg/>',
        secret: 'SECRET',
        uri: 'otpauth://totp/x',
      },
    },
    error: null,
  });
}

async function call(request: Request) {
  const res = await POST(request);
  return { status: res.status, body: await res.json() };
}

describe('POST /api/auth/mfa/enroll-totp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRateLimit.mockResolvedValue(undefined);
    mockCreateClient.mockResolvedValue({
      auth: { mfa: { listFactors, unenroll, enroll } },
    });
    authAs('admin');
    listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    unenroll.mockResolvedValue({ data: {}, error: null });
    enrollOk();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-030 管理者で要素が無ければ登録して 200 を返し、SVG の QR を data URI に整える', async () => {
    enrollOk({ qr: '<svg viewBox="0 0 1 1"></svg>' });

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(200);
    expect(body.data).toEqual({
      factorId: 'new-factor',
      friendlyName: 'Authenticator',
      qrCode: `data:image/svg+xml;utf8,${encodeURIComponent('<svg viewBox="0 0 1 1"></svg>')}`,
      secret: 'SECRET',
      uri: 'otpauth://totp/x',
    });
    expect(enroll).toHaveBeenCalledWith({ factorType: 'totp' });
    expect(unenroll).not.toHaveBeenCalled();
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:mfa:enroll-totp', limit: 10, windowSeconds: 600 }),
    );
  });

  it('DD-AUTH-030 回数の制限が応答を返したらその応答を返し、先へ進まない', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too Many Requests' }) };
    mockRateLimit.mockResolvedValue(limited);

    const res = await POST(jsonRequest({}));

    expect(res).toBe(limited);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('DD-AUTH-030 回数の制限の呼び出しが投げたら記録して先へ進む', async () => {
    mockRateLimit.mockRejectedValue(new Error('limiter down'));

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      '[auth.mfa.enroll] rate limit middleware error:',
      expect.any(Error),
    );
  });

  it('DD-AUTH-030 本文が JSON でなければ空の本文として扱い登録する', async () => {
    const { status } = await call(buildRequest('not json'));

    expect(status).toBe(200);
    expect(enroll).toHaveBeenCalledWith({ factorType: 'totp' });
  });

  it('DD-AUTH-030 forceReEnroll が文字なら 400 で、確かめも登録もしない', async () => {
    const { status, body } = await call(jsonRequest({ forceReEnroll: 'yes' }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Bad Request' });
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unavailable'])(
    'DD-AUTH-030 確かめが通らない時（%s）は共有部品の失敗の応答を返す',
    async (reason) => {
      mockAuthenticate.mockResolvedValue({ ok: false, reason });

      const { status } = await call(jsonRequest({}));

      expect(mockFailure).toHaveBeenCalledWith(reason);
      expect(status).toBe(reason === 'unavailable' ? 503 : 401);
      expect(listFactors).not.toHaveBeenCalled();
    },
  );

  it.each([['user'], ['owner'], [undefined]])(
    'DD-AUTH-030 一般の会員・知らない役割・役割が無い時（%p）は 403',
    async (role) => {
      authAs(role);

      const { status, body } = await call(jsonRequest({}));

      expect(status).toBe(403);
      expect(body).toEqual({ error: 'Forbidden' });
      expect(listFactors).not.toHaveBeenCalled();
      expect(enroll).not.toHaveBeenCalled();
    },
  );

  it('DD-AUTH-030 サポーターは登録できる', async () => {
    authAs('supporter');

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(200);
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-030 要素の一覧が誤りなら 500', async () => {
    listFactors.mockResolvedValue({ data: null, error: { message: 'list down' } });

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to list factors' });
    expect(enroll).not.toHaveBeenCalled();
  });

  it('DD-AUTH-030 確かめ済みの TOTP があり作り直しを求めなければ 409 と今の要素を返す', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f-1', status: 'verified', factor_type: 'totp', friendly_name: 'Phone' }] },
      error: null,
    });

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(409);
    expect(body).toEqual({
      error: 'MFA factor already enrolled',
      data: { factorId: 'f-1', factorType: 'totp', friendlyName: 'Phone' },
    });
    expect(enroll).not.toHaveBeenCalled();
  });

  it('DD-AUTH-030 確かめ済みの TOTP の名前が無ければ 409 の名前は null', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f-1', status: 'verified', factor_type: 'totp' }] },
      error: null,
    });

    const { status, body } = await call(jsonRequest({ forceReEnroll: false }));

    expect(status).toBe(409);
    expect(body.data.friendlyName).toBeNull();
  });

  it('DD-AUTH-030 確かめ済みの TOTP があり作り直しを求めたら 403 で、外しも登録もしない', async () => {
    listFactors.mockResolvedValue({
      data: {
        totp: [
          { id: 'f-0', status: 'unverified', factor_type: 'totp' },
          { id: 'f-1', status: 'verified', factor_type: 'totp' },
        ],
      },
      error: null,
    });

    const { status, body } = await call(jsonRequest({ forceReEnroll: true }));

    expect(status).toBe(403);
    expect(body.error).toContain('AAL2');
    expect(unenroll).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('DD-AUTH-030 TOTP の一覧が無ければ空とみなして登録する', async () => {
    listFactors.mockResolvedValue({ data: {}, error: null });

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(200);
    expect(unenroll).not.toHaveBeenCalled();
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-030 未確認の要素を外してから登録する', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f-9', status: 'unverified', factor_type: 'totp' }] },
      error: null,
    });
    const order: string[] = [];
    unenroll.mockImplementation(async () => {
      order.push('unenroll');
      return { data: {}, error: null };
    });
    enroll.mockImplementation(async () => {
      order.push('enroll');
      return {
        data: { id: 'n', friendly_name: null, totp: { qr_code: 'x', secret: 's', uri: 'u' } },
        error: null,
      };
    });

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(200);
    expect(unenroll).toHaveBeenCalledWith({ factorId: 'f-9' });
    expect(order).toEqual(['unenroll', 'enroll']);
  });

  it('DD-AUTH-030 外すのが誤りを返しても見ずに登録へ進む', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f-9', status: 'unverified', factor_type: 'totp' }] },
      error: null,
    });
    unenroll.mockResolvedValue({ data: null, error: { message: 'cannot unenroll' } });

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(200);
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-030 作り直しを求めて確かめ済みが無ければ Admin TOTP と時刻の名前で登録する', async () => {
    const { status } = await call(jsonRequest({ forceReEnroll: true }));

    expect(status).toBe(200);
    expect(enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: expect.stringMatching(/^Admin TOTP \d{4}-\d{2}-\d{2}T/),
    });
  });

  it('DD-AUTH-030 登録の誤りの符号が insufficient_aal なら 403', async () => {
    enroll.mockResolvedValue({ data: null, error: { code: 'insufficient_aal', message: 'aal' } });

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(403);
    expect(body.error).toContain('2要素認証');
  });

  it('DD-AUTH-030 登録の誤りの符号が mfa_factor_name_conflict なら 409', async () => {
    enroll.mockResolvedValue({ data: null, error: { code: 'mfa_factor_name_conflict', message: 'dup' } });

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(409);
    expect(body.error).toContain('同名');
  });

  it('DD-AUTH-030 登録のほかの誤りは 500', async () => {
    enroll.mockResolvedValue({ data: null, error: { code: 'unexpected_failure', message: 'x' } });

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to enroll MFA factor' });
  });

  it('DD-AUTH-030 登録がデータを返さず誤りも無い時は 500', async () => {
    enroll.mockResolvedValue({ data: null, error: null });

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to enroll MFA factor' });
  });

  it.each([
    ['空の QR はそのまま', '   ', ''],
    ['data URI はそのまま', 'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ['SVG の文字は data URI に整える', '<svg></svg>', `data:image/svg+xml;utf8,${encodeURIComponent('<svg></svg>')}`],
    ['ほかの文字はそのまま', 'https://example.com/qr.png', 'https://example.com/qr.png'],
  ])('DD-AUTH-030 QR の整え方 %s', async (_label, input, expected) => {
    enrollOk({ qr: input });

    const { body } = await call(jsonRequest({}));

    expect(body.data.qrCode).toBe(expected);
  });

  it('DD-AUTH-030 登録の名前が無ければ null で返す', async () => {
    enroll.mockResolvedValue({
      data: { id: 'n', totp: { qr_code: 'x', secret: 's', uri: 'u' } },
      error: null,
    });

    const { body } = await call(jsonRequest({}));

    expect(body.data.friendlyName).toBeNull();
  });

  it('DD-AUTH-030 client の作成が投げたら 500', async () => {
    mockCreateClient.mockRejectedValue(new Error('boom'));

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
  });
});
