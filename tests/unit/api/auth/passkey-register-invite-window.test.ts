/** @jest-environment node */
/**
 * DD-AUTH-079 招待の窓の中の人（役割が無い案 B）を、登録の窓口が window として扱うことの単体テスト。
 * 始め・終わりを、DB の関数と GoTrue を差し替えて確かめる。
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
  hasOpenInvite: jest.fn(),
  windowIsOpen: jest.fn(),
  approvedCount: jest.fn(),
  approve: jest.fn(),
}));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ registrationVerify: jest.fn(), registrationOptions: jest.fn() }));
jest.mock('@/lib/auth/passkey-uv', () => ({ readAttestationUserVerified: jest.fn() }));

import { POST as finish } from '@/app/api/auth/passkey/register/finish/route';
import { POST as start } from '@/app/api/auth/passkey/register/start/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { authenticateRequest, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { approve, approvedCount, hasOpenInvite, isStaff, windowIsOpen } from '@/lib/auth/passkey-approval-rpc';
import { registrationOptions, registrationVerify } from '@/lib/auth/passkey-gotrue';
import { readAttestationUserVerified } from '@/lib/auth/passkey-uv';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const PASSKEY_ID = '44444444-4444-4444-8444-444444444444';
const nowSec = () => Math.floor(Date.now() / 1000);

const m = (fn: unknown) => fn as jest.Mock;

function startReq() {
  return new Request('http://localhost/api/auth/passkey/register/start', {
    method: 'POST',
    headers: { authorization: 'Bearer tok-abc' },
  });
}
function finishReq() {
  return new Request('http://localhost/api/auth/passkey/register/finish', {
    method: 'POST',
    headers: { authorization: 'Bearer tok-abc', 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge_id: CHALLENGE_ID,
      credential: {
        id: 'AAECAw',
        rawId: 'AAECAw',
        type: 'public-key',
        response: { clientDataJSON: 'eyJ4IjoxfQ', attestationObject: 'o2NmbXRkbm9uZQ' },
      },
    }),
  });
}

function setAmrAgo(seconds: number) {
  m(authenticateRequest).mockResolvedValue({
    ok: true,
    claims: { sub: USER_ID, session_id: SESSION_ID, amr: [{ method: 'otp', timestamp: nowSec() - seconds }] },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  m(enforceRateLimit).mockResolvedValue(null);
  m(requireCsrfOrDeny).mockResolvedValue(undefined);
  m(checkAuthSessionLiveness).mockResolvedValue('active');
  m(isStaff).mockResolvedValue({ ok: true, value: false });
  m(hasOpenInvite).mockResolvedValue({ ok: true, value: true });
  m(windowIsOpen).mockResolvedValue({ ok: true, value: true });
  m(approvedCount).mockResolvedValue({ ok: true, value: 0 });
  m(approve).mockResolvedValue({ ok: true });
  m(readAttestationUserVerified).mockReturnValue(true);
  setAmrAgo(1800); // お客さんの10分の道なら通らない古さ
  m(registrationOptions).mockResolvedValue({
    ok: true,
    data: { challenge_id: 'c-1', expires_at: 123, options: { challenge: 'abc' } },
  });
  m(registrationVerify).mockResolvedValue({
    ok: true,
    data: { id: PASSKEY_ID, friendly_name: 'k', created_at: '2026-11-18T00:00:00Z' },
  });
});

describe('DD-AUTH-079 招待の窓の人の登録（役割が無い案 B）', () => {
  test('DD-AUTH-079 始め: 役割が無く窓が開いた人は 200 で mode は window、生きたセッションも求める', async () => {
    const res = await start(startReq());
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('window');
    expect(checkAuthSessionLiveness).toHaveBeenCalledWith(SESSION_ID, true);
    expect(windowIsOpen).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  test('DD-AUTH-079 終わり: window で鍵を認める（otp が30分前でもお客さんの10分の確かめは効かない）', async () => {
    const res = await finish(finishReq());
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(USER_ID, PASSKEY_ID, 'window');
  });

  test('DD-AUTH-079 窓が閉じた・別のセッションの人は、お客さんの道に落ちず 403 window_closed で GoTrue を呼ばない', async () => {
    m(windowIsOpen).mockResolvedValue({ ok: true, value: false });
    setAmrAgo(5);
    const res = await start(startReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
    expect(registrationOptions).not.toHaveBeenCalled();
    const fin = await finish(finishReq());
    expect(fin.status).toBe(403);
    expect(registrationVerify).not.toHaveBeenCalled();
  });

  test('DD-AUTH-079 窓の中でも認めた鍵が2本なら 403 reauth_required（3本目は認めない）', async () => {
    m(approvedCount).mockResolvedValue({ ok: true, value: 2 });
    setAmrAgo(5); // 旧コード（お客さんの道）なら 200 になる新しさ
    const res = await start(startReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'reauth_required' });
  });

  test('DD-AUTH-079 結び付いた生きたセッションでなければ 401、確かめられなければ 503', async () => {
    m(checkAuthSessionLiveness).mockResolvedValue('inactive');
    expect((await start(startReq())).status).toBe(401);
    m(checkAuthSessionLiveness).mockResolvedValue('unavailable');
    expect((await start(startReq())).status).toBe(503);
    expect(registrationOptions).not.toHaveBeenCalled();
  });

  test('DD-AUTH-079 招待の確かめが読めなければ 503（閉じる側）', async () => {
    m(hasOpenInvite).mockResolvedValue({ ok: false });
    expect((await start(startReq())).status).toBe(503);
  });

  test('DD-AUTH-079 招待が無いお客さんは窓・本数・生存を引かず、今までどおり customer', async () => {
    m(hasOpenInvite).mockResolvedValue({ ok: true, value: false });
    m(windowIsOpen).mockResolvedValue({ ok: true, value: false });
    setAmrAgo(5);
    const res = await start(startReq());
    expect((await res.json()).mode).toBe('customer');
    expect(approvedCount).not.toHaveBeenCalled();
    expect(checkAuthSessionLiveness).not.toHaveBeenCalled();
    await finish(finishReq());
    expect(approve).not.toHaveBeenCalled();
  });
});
