/** @jest-environment node */
/**
 * DD-AUTH-056 パスキーの登録の始めの窓口（src/app/api/auth/passkey/register/start/route.ts）の単体テスト。
 * 認証・CSRF・回数の制限・認めの RPC・GoTrue は差し替え、断りの順番と GoTrue を呼ばないことを確かめる。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
  authFailureResponse: (reason: string) =>
    reason === 'unavailable'
      ? new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ isStaff: jest.fn(), hasOpenInvite: jest.fn(), windowIsOpen: jest.fn(), approvedCount: jest.fn() }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ registrationOptions: jest.fn() }));

import { POST } from '@/app/api/auth/passkey/register/start/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { authenticateRequest, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { approvedCount, hasOpenInvite, isStaff, windowIsOpen } from '@/lib/auth/passkey-approval-rpc';
import { registrationOptions } from '@/lib/auth/passkey-gotrue';
import { logAudit } from '@/lib/audit';

const rateLimit = enforceRateLimit as jest.Mock;
const csrf = requireCsrfOrDeny as jest.Mock;
const authenticate = authenticateRequest as jest.Mock;
const liveness = checkAuthSessionLiveness as jest.Mock;
const staffMock = isStaff as jest.Mock;
const windowMock = windowIsOpen as jest.Mock;
const countMock = approvedCount as jest.Mock;
const optionsMock = registrationOptions as jest.Mock;
const audit = logAudit as jest.Mock;

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const nowSec = () => Math.floor(Date.now() / 1000);

function req(headers: Record<string, string> = { authorization: 'Bearer tok-abc' }) {
  return new Request('http://localhost/api/auth/passkey/register/start', { method: 'POST', headers });
}

function setClaims(over: Record<string, unknown> = {}) {
  authenticate.mockResolvedValue({
    ok: true,
    claims: { sub: USER_ID, session_id: SESSION_ID, amr: [], ...over },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit.mockResolvedValue(null);
  csrf.mockResolvedValue(undefined);
  liveness.mockResolvedValue('active');
  staffMock.mockResolvedValue({ ok: true, value: true });
  (hasOpenInvite as jest.Mock).mockResolvedValue({ ok: true, value: false });
  windowMock.mockResolvedValue({ ok: true, value: true });
  countMock.mockResolvedValue({ ok: true, value: 0 });
  setClaims();
  optionsMock.mockResolvedValue({
    ok: true,
    data: { challenge_id: 'c-1', expires_at: 123, options: { challenge: 'abc', rp: { id: 'localhost' } } },
  });
});

describe('DD-AUTH-056 POST /api/auth/passkey/register/start', () => {
  test('DD-AUTH-056 窓の中の店員は 200 で、mode は window、userVerification が required に書き換わる（authenticatorSelection が無くても作る）', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      challenge_id: 'c-1',
      expires_at: 123,
      mode: 'window',
      options: { challenge: 'abc', rp: { id: 'localhost' }, authenticatorSelection: { userVerification: 'required' } },
    });
    expect(optionsMock).toHaveBeenCalledWith('tok-abc');
    expect(liveness).toHaveBeenCalledWith(SESSION_ID, true);
    expect(windowMock).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  test('DD-AUTH-056 GoTrue の authenticatorSelection の他の項目は残し、userVerification だけ required にする', async () => {
    optionsMock.mockResolvedValue({
      ok: true,
      data: {
        challenge_id: 'c-1',
        expires_at: 123,
        options: { challenge: 'abc', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' } },
      },
    });
    const body = await (await POST(req())).json();
    expect(body.options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
  });

  test('DD-AUTH-056 窓の中でも認めた鍵が2本なら 403 reauth_required で GoTrue を呼ばない', async () => {
    countMock.mockResolvedValue({ ok: true, value: 2 });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'reauth_required' });
    expect(optionsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 窓が閉じていて passkey の入り直しも無い店員は 403 window_closed', async () => {
    windowMock.mockResolvedValue({ ok: true, value: false });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
    expect(optionsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 5分以内にパスキーで入り直した店員は、窓が閉じていても 200 で mode は reauth', async () => {
    windowMock.mockResolvedValue({ ok: true, value: false });
    countMock.mockResolvedValue({ ok: true, value: 2 });
    setClaims({ amr: [{ method: 'passkey', timestamp: nowSec() - 30 }] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('reauth');
  });

  test('DD-AUTH-056 5分より古い入り直し（301秒前）で窓も閉じていれば 403', async () => {
    windowMock.mockResolvedValue({ ok: true, value: false });
    setClaims({ amr: [{ method: 'passkey', timestamp: nowSec() - 301 }] });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(optionsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 お客さんは窓・本数を引かず、10分以内のメールのコードで 200（mode は customer）', async () => {
    staffMock.mockResolvedValue({ ok: true, value: false });
    setClaims({ amr: [{ method: 'otp', timestamp: nowSec() - 100 }] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('customer');
    expect(windowMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
    expect(liveness).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 お客さんが10分より古い・oauth だけなら 403 reauth_required', async () => {
    staffMock.mockResolvedValue({ ok: true, value: false });
    setClaims({ amr: [{ method: 'oauth', timestamp: nowSec() }] });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'reauth_required' });
  });

  test('DD-AUTH-056 店員の結び付かないセッションは、旗が切れていても（authenticateRequest が通しても）401 で GoTrue を呼ばない', async () => {
    liveness.mockResolvedValue('revoked');
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(optionsMock).not.toHaveBeenCalled();
    expect(windowMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 店員のセッションの生存が確かめられなければ 503', async () => {
    liveness.mockResolvedValue('unavailable');
    expect((await POST(req())).status).toBe(503);
    expect(optionsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 旗 AUTH_REQUIRE_APP_SESSION を切っても、店員は結び付き込みで確かめる（第2引数 true）', async () => {
    const original = process.env.AUTH_REQUIRE_APP_SESSION;
    process.env.AUTH_REQUIRE_APP_SESSION = 'false';
    try {
      liveness.mockResolvedValue('revoked');
      const res = await POST(req());
      expect(res.status).toBe(401);
      expect(liveness).toHaveBeenCalledWith(SESSION_ID, true);
      expect(optionsMock).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.AUTH_REQUIRE_APP_SESSION;
      else process.env.AUTH_REQUIRE_APP_SESSION = original;
    }
  });

  test('DD-AUTH-056 店員かの確かめ・窓・本数のどれかが読めなければ 503（閉じる側）', async () => {
    staffMock.mockResolvedValue({ ok: false });
    expect((await POST(req())).status).toBe(503);
    staffMock.mockResolvedValue({ ok: true, value: true });
    windowMock.mockResolvedValue({ ok: false });
    expect((await POST(req())).status).toBe(503);
    windowMock.mockResolvedValue({ ok: true, value: true });
    countMock.mockResolvedValue({ ok: false });
    expect((await POST(req())).status).toBe(503);
    expect(optionsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 認証に失敗したら 401、CSRF が外れたら 403 で、どちらも店員の確かめより前に止まる', async () => {
    authenticate.mockResolvedValue({ ok: false, reason: 'missing' });
    expect((await POST(req())).status).toBe(401);
    expect(staffMock).not.toHaveBeenCalled();

    setClaims();
    csrf.mockResolvedValue(new Response('{}', { status: 403 }));
    expect((await POST(req())).status).toBe(403);
    expect(staffMock).not.toHaveBeenCalled();
    expect(optionsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 IP の回数の制限は認証より前、本人の回数の制限は CSRF の後（subject は利用者の ID）', async () => {
    rateLimit.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await POST(req())).status).toBe(429);
    expect(authenticate).not.toHaveBeenCalled();

    rateLimit.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await POST(req())).status).toBe(429);
    expect(rateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 20, windowSeconds: 600 }));
    expect(rateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 10, windowSeconds: 600, subject: USER_ID }));
    expect(staffMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 GoTrue の失敗・形の違う応答は 502 passkey_register_failed', async () => {
    optionsMock.mockResolvedValue({ ok: false, status: 500 });
    let res = await POST(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'passkey_register_failed' });
    optionsMock.mockResolvedValue({ ok: true, data: { challenge_id: 'c', expires_at: 1, options: {} } });
    res = await POST(req());
    expect(res.status).toBe(502);
  });

  test.each([
    ['data が null', null],
    ['challenge_id が空', { challenge_id: '', expires_at: 1, options: { challenge: 'c' } }],
    ['expires_at が数でない', { challenge_id: 'c', expires_at: 'x', options: { challenge: 'c' } }],
    ['options が配列', { challenge_id: 'c', expires_at: 1, options: [] }],
    ['options が無い', { challenge_id: 'c', expires_at: 1 }],
  ])('DD-AUTH-056 GoTrue の応答の形が違う（%s）と 502', async (_label, data) => {
    optionsMock.mockResolvedValue({ ok: true, data });
    expect((await POST(req())).status).toBe(502);
  });

  test('DD-AUTH-056 authenticatorSelection が配列など object でなければ捨てて userVerification だけ入れる', async () => {
    optionsMock.mockResolvedValue({
      ok: true,
      data: { challenge_id: 'c', expires_at: 1, options: { challenge: 'abc', authenticatorSelection: [] } },
    });
    const body = await (await POST(req())).json();
    expect(body.options.authenticatorSelection).toEqual({ userVerification: 'required' });
  });

  test('DD-AUTH-056 sub が無い・通行証の文字列が取れない要求は 401 で、店員の確かめより前に止まる', async () => {
    setClaims({ sub: undefined });
    expect((await POST(req())).status).toBe(401);
    setClaims();
    expect((await POST(req({}))).status).toBe(401);
    expect(staffMock).not.toHaveBeenCalled();
    expect(optionsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-056 断りの監査には固定の符号と行為者だけを残し、トークンを残さない', async () => {
    windowMock.mockResolvedValue({ ok: true, value: false });
    await POST(req());
    const calls = audit.mock.calls.map(([event]) => event);
    expect(calls).toContainEqual(
      expect.objectContaining({ action: 'auth.passkey.register.start', outcome: 'failure', actor_id: USER_ID }),
    );
    expect(JSON.stringify(calls)).not.toContain('tok-abc');
  });
});
