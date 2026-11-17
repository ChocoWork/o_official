/** @jest-environment node */
/**
 * DD-AUTH-056 パスキーの登録の終わりの窓口（src/app/api/auth/passkey/register/finish/route.ts）の単体テスト。
 * 始めと同じ確かめのやり直し・UV の確かめ・認めと補償の削除を、GoTrue・認めの RPC を差し替えて確かめる。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
  authFailureResponse: (reason: string) =>
    reason === 'unavailable'
      ? new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({
  isStaff: jest.fn(),
  windowIsOpen: jest.fn(),
  approvedCount: jest.fn(),
  approve: jest.fn(),
}));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ registrationVerify: jest.fn() }));
jest.mock('@/lib/auth/passkey-uv', () => ({ readAttestationUserVerified: jest.fn() }));

import { POST } from '@/app/api/auth/passkey/register/finish/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authenticateRequest, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { approve, approvedCount, isStaff, windowIsOpen } from '@/lib/auth/passkey-approval-rpc';
import { registrationVerify } from '@/lib/auth/passkey-gotrue';
import { readAttestationUserVerified } from '@/lib/auth/passkey-uv';
import { logAudit } from '@/lib/audit';

const rateLimit = enforceRateLimit as jest.Mock;
const csrf = requireCsrfOrDeny as jest.Mock;
const serviceClient = createServiceRoleClient as jest.Mock;
const authenticate = authenticateRequest as jest.Mock;
const liveness = checkAuthSessionLiveness as jest.Mock;
const staffMock = isStaff as jest.Mock;
const windowMock = windowIsOpen as jest.Mock;
const countMock = approvedCount as jest.Mock;
const approveMock = approve as jest.Mock;
const verifyMock = registrationVerify as jest.Mock;
const uvMock = readAttestationUserVerified as jest.Mock;
const audit = logAudit as jest.Mock;

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const PASSKEY_ID = '44444444-4444-4444-8444-444444444444';
const nowSec = () => Math.floor(Date.now() / 1000);

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'AAECAw',
    rawId: 'AAECAw',
    type: 'public-key',
    response: { clientDataJSON: 'eyJ4IjoxfQ', attestationObject: 'o2NmbXRkbm9uZQ' },
    ...overrides,
  };
}

function req(body: unknown = { challenge_id: CHALLENGE_ID, credential: credential() }) {
  return new Request('http://localhost/api/auth/passkey/register/finish', {
    method: 'POST',
    headers: { authorization: 'Bearer tok-abc', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function setClaims(over: Record<string, unknown> = {}) {
  authenticate.mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: SESSION_ID, amr: [], ...over } });
}

let deletePasskey: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit.mockResolvedValue(null);
  csrf.mockResolvedValue(undefined);
  liveness.mockResolvedValue('active');
  staffMock.mockResolvedValue({ ok: true, value: true });
  windowMock.mockResolvedValue({ ok: true, value: true });
  countMock.mockResolvedValue({ ok: true, value: 1 });
  approveMock.mockResolvedValue({ ok: true });
  uvMock.mockReturnValue(true);
  setClaims();
  verifyMock.mockResolvedValue({
    ok: true,
    data: { id: PASSKEY_ID, friendly_name: 'k', created_at: '2026-11-17T00:00:00Z' },
  });
  deletePasskey = jest.fn().mockResolvedValue({ data: null, error: null });
  serviceClient.mockResolvedValue({ auth: { admin: { passkey: { deletePasskey } } } });
});

describe('DD-AUTH-056 POST /api/auth/passkey/register/finish', () => {
  test('DD-AUTH-056 窓の中の店員は 200 で、window で認め、認めた鍵の本数を返す', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      passkey: { id: PASSKEY_ID, friendly_name: 'k', created_at: '2026-11-17T00:00:00Z' },
      approvedCount: 1,
    });
    expect(verifyMock).toHaveBeenCalledWith('tok-abc', { challengeId: CHALLENGE_ID, credential: expect.anything() });
    expect(approveMock).toHaveBeenCalledWith(USER_ID, PASSKEY_ID, 'window');
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 入り直しの店員は reauth で認める', async () => {
    windowMock.mockResolvedValue({ ok: true, value: false });
    setClaims({ amr: [{ method: 'passkey', timestamp: nowSec() - 5 }] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(approveMock).toHaveBeenCalledWith(USER_ID, PASSKEY_ID, 'reauth');
  });

  test('DD-AUTH-056 お客さんは認めを呼ばず、approvedCount を返さない', async () => {
    staffMock.mockResolvedValue({ ok: true, value: false });
    setClaims({ amr: [{ method: 'otp', timestamp: nowSec() - 5 }] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      passkey: { id: PASSKEY_ID, friendly_name: 'k', created_at: '2026-11-17T00:00:00Z' },
    });
    expect(approveMock).not.toHaveBeenCalled();
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 始めの後に窓が閉じていたら、終わりは 403 で GoTrue の検証を呼ばない', async () => {
    windowMock.mockResolvedValue({ ok: true, value: false });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
    expect(verifyMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 窓の中でも認めた鍵が2本なら、終わりも 403 reauth_required で検証を呼ばない', async () => {
    countMock.mockResolvedValue({ ok: true, value: 2 });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'reauth_required' });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 旗 AUTH_REQUIRE_APP_SESSION を切っても、結び付かない店員のセッションは 401 で検証を呼ばない', async () => {
    const original = process.env.AUTH_REQUIRE_APP_SESSION;
    process.env.AUTH_REQUIRE_APP_SESSION = 'false';
    try {
      liveness.mockResolvedValue('revoked');
      const res = await POST(req());
      expect(res.status).toBe(401);
      expect(liveness).toHaveBeenCalledWith(SESSION_ID, true);
      expect(verifyMock).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.AUTH_REQUIRE_APP_SESSION;
      else process.env.AUTH_REQUIRE_APP_SESSION = original;
    }
  });

  test('DD-AUTH-056 CSRF が外れたら 403 で検証を呼ばない', async () => {
    csrf.mockResolvedValue(new Response('{}', { status: 403 }));
    expect((await POST(req())).status).toBe(403);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 id と rawId が違う応答は 400 invalid_request で GoTrue を呼ばない', async () => {
    const res = await POST(req({ challenge_id: CHALLENGE_ID, credential: credential({ rawId: 'AAECBA' }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 本文が JSON でない・形が違う時も 400', async () => {
    expect((await POST(req('not json'))).status).toBe(400);
    expect((await POST(req({ challenge_id: 'x', credential: credential() }))).status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 UV の印が無い・読めない attestationObject は 400 uv_required で、検証も認めも呼ばない', async () => {
    uvMock.mockReturnValue(false);
    let res = await POST(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'uv_required' });
    uvMock.mockReturnValue(null);
    res = await POST(req());
    expect(res.status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
  });

  test.each(['stale', 'window_full', 'other'] as const)(
    'DD-AUTH-056 認めが %s で落ちたら、今作られた鍵を1回消して 500 passkey_approve_failed',
    async (reason) => {
      approveMock.mockResolvedValue({ ok: false, reason });
      const res = await POST(req());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'passkey_approve_failed' });
      expect(deletePasskey).toHaveBeenCalledTimes(1);
      expect(deletePasskey).toHaveBeenCalledWith({ userId: USER_ID, passkeyId: PASSKEY_ID });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'passkey_approve_failed', actor_id: USER_ID }));
    },
  );

  test('DD-AUTH-056 補償の削除も落ちたら 500 で、監査に passkey_approve_failed:compensation_failed を残す', async () => {
    approveMock.mockResolvedValue({ ok: false, reason: 'other' });
    deletePasskey.mockResolvedValue({ data: null, error: { message: 'x' } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'passkey_approve_failed:compensation_failed', actor_id: USER_ID }),
    );
    deletePasskey.mockRejectedValue(new Error('boom'));
    expect((await POST(req())).status).toBe(500);
  });

  test('DD-AUTH-056 GoTrue の検証の失敗・形の違う応答は 502 で、認めを呼ばない', async () => {
    verifyMock.mockResolvedValue({ ok: false, status: 400 });
    expect((await POST(req())).status).toBe(502);
    verifyMock.mockResolvedValue({ ok: true, data: { friendly_name: 'k' } });
    expect((await POST(req())).status).toBe(502);
    expect(approveMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 GoTrue の検証の応答が null でも 502 で、認めを呼ばない', async () => {
    verifyMock.mockResolvedValue({ ok: true, data: null });
    expect((await POST(req())).status).toBe(502);
    expect(approveMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 friendly_name が無い応答は null にして 200 で返す', async () => {
    verifyMock.mockResolvedValue({ ok: true, data: { id: PASSKEY_ID, created_at: '2026-11-17T00:00:00Z' } });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).passkey.friendly_name).toBeNull();
  });

  test('DD-AUTH-056 認めた後の本数が読めなくても 200（approvedCount だけ省く）', async () => {
    countMock.mockResolvedValueOnce({ ok: true, value: 1 }).mockResolvedValueOnce({ ok: false });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('approvedCount');
  });

  test('DD-AUTH-056 監査にトークン・challenge_id を残さない', async () => {
    await POST(req());
    const serialized = JSON.stringify(audit.mock.calls);
    expect(serialized).not.toContain('tok-abc');
    expect(serialized).not.toContain(CHALLENGE_ID);
  });
});
