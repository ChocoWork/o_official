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

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { logAudit } from '@/lib/audit';
import { POST } from '@/app/api/auth/mfa/enroll-totp/route';

const mockRateLimit = enforceRateLimit as jest.Mock;
const mockCreateClient = createClient as jest.Mock;
const mockAuthenticate = authenticateRequest as jest.Mock;
const mockFailure = authFailureResponse as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

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

function authAs(role?: unknown, amr: unknown = [{ method: 'otp', timestamp: 0 }]) {
  mockAuthenticate.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: role === undefined ? undefined : { role }, amr },
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
    mockLogAudit.mockResolvedValue(undefined);
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

  it('DD-AUTH-030 回数の制限の呼び出しが投げたら 500 で、先へ進まない（SEC-AUTH-013-AC-02）', async () => {
    mockRateLimit.mockRejectedValue(new Error('limiter down'));

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(500);
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[auth.mfa.enroll] rate limit middleware error:',
      expect.anything(),
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
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

  // 結び付いていない session（アプリを通らずに取った OTP だけの通行証など）は authenticateRequest が
  // revoked で返す。断りは行為者つきで監査に残し、値（session_id・トークン）は残さない。
  it('DD-AUTH-039 SEC-AUTH-031-AC-02 結び付いていない session（revoked＋claims）は 401 で、app_session_required を監査に 1 行だけ残す', async () => {
    mockAuthenticate.mockResolvedValue({
      ok: false,
      reason: 'revoked',
      claims: {
        sub: 'user-1',
        session_id: '11111111-2222-3333-4444-555555555555',
        app_metadata: { role: 'admin' },
        amr: [{ method: 'otp', timestamp: 0 }],
      },
    });

    const { status } = await call(jsonRequest({}));

    expect(mockFailure).toHaveBeenCalledWith('revoked');
    expect(status).toBe(401);
    expect(listFactors).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    expect(unenroll).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'mfa_enroll',
      actor_id: 'user-1',
      outcome: 'denied',
      detail: 'app_session_required',
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('11111111-2222');
  });

  it('DD-AUTH-039 revoked でも claims が無ければ断りの監査は書かない（行為者が分からない）', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'revoked' });

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(listFactors).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid', 'unavailable'])(
    'DD-AUTH-039 確かめが通らない時（%s）は app_session_required の監査を書かない',
    async (reason) => {
      mockAuthenticate.mockResolvedValue({ ok: false, reason });

      await call(jsonRequest({}));

      expect(mockLogAudit).not.toHaveBeenCalled();
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

  it('DD-AUTH-030 password だけの通行証の管理者は 403 で、登録せず second_factor_required を監査に残す', async () => {
    authAs('admin', [{ method: 'password', timestamp: 0 }]);

    const { status, body } = await call(jsonRequest({}));

    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Forbidden' });
    expect(listFactors).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'mfa_enroll',
      actor_id: 'user-1',
      outcome: 'denied',
      detail: 'second_factor_required',
    });
  });

  it.each([[null], [[]], ['otp']])('DD-AUTH-030 amr が %p の通行証は 403', async (amr) => {
    authAs('admin', amr);

    const { status } = await call(jsonRequest({}));

    expect(status).toBe(403);
    expect(enroll).not.toHaveBeenCalled();
  });

  it.each(['otp', 'magiclink', 'totp', 'oauth', 'sso/saml', 'email/signup'])(
    'DD-AUTH-030 password と %s を持つ通行証なら登録でき、成功を監査に残す（秘密の値は残さない）',
    async (method) => {
      authAs('admin', [{ method: 'password' }, { method }]);

      const { status } = await call(jsonRequest({}));

      expect(status).toBe(200);
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'mfa_enroll',
        actor_id: 'user-1',
        outcome: 'success',
        detail: 'totp_factor_enrolled',
        resource_id: 'new-factor',
      });
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('SECRET');
    },
  );

  it('DD-AUTH-030 一般の会員の 403 は mfa_enroll の監査を書かない', async () => {
    authAs('user', [{ method: 'password' }]);

    await call(jsonRequest({}));

    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-AUTH-030 確かめ済みの TOTP がある時の 409 と 403 は mfa_enroll の成功を書かない', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f-1', status: 'verified', factor_type: 'totp' }] },
      error: null,
    });

    await call(jsonRequest({}));
    await call(jsonRequest({ forceReEnroll: true }));

    expect(mockLogAudit).not.toHaveBeenCalled();
  });

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
    // 取り外しは 'enroll' の字を含まない action で 1 行（登録の行を数える確かめを乱さない）
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'mfa_factor_remove',
      actor_id: 'user-1',
      outcome: 'success',
      resource_id: 'f-9',
    });
    const actions = mockLogAudit.mock.calls.map(([event]) => event.action);
    expect(actions.filter((action) => action.includes('enroll'))).toEqual(['mfa_enroll']);
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
