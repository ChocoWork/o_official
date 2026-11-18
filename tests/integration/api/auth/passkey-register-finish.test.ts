/** @jest-environment node */
export {};

// パスキーの登録の終わりの窓口（API-AUTH-025）。窓口・確かめの部品・zod の形・UV の読み取り（本物の認証器の応答を使う）・認めの RPC の部品は本物を通し、
// 外へ出る物（回数の表・監査・認証の確かめ・CSRF・GoTrue の検証・DB の RPC・管理 API）だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ registrationVerify: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => {
  const actual = jest.requireActual('@/lib/auth/authenticate');
  return { ...actual, authenticateRequest: jest.fn(), checkAuthSessionLiveness: jest.fn() };
});

import { POST } from '@/app/api/auth/passkey/register/finish/route';
import { incrementCounter } from '@/features/auth/ratelimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { registrationVerify } from '@/lib/auth/passkey-gotrue';
import { authenticateRequest, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { createSoftAuthenticator } from '../../../../e2e/passkey-soft-authenticator';

const counter = incrementCounter as jest.Mock;
const verifyMock = registrationVerify as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
const IP = '203.0.113.41';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const PASSKEY_ID = '44444444-4444-4444-8444-444444444444';

let rpc: jest.Mock;
let deletePasskey: jest.Mock;
let isStaff: boolean;
let windowOpen: boolean;
let approveError: { code: string } | null;

function credential(userVerified = true) {
  const authenticator = createSoftAuthenticator({ origin: 'http://localhost:3000', rpId: 'localhost' });
  return authenticator.register(
    { challenge: 'abc', rp: { id: 'localhost', name: 'x' }, user: { id: 'dXNlcg', name: 'u', displayName: 'u' }, pubKeyCredParams: [] } as never,
    { userVerified },
  );
}

function req(cred: unknown = credential()) {
  return new Request('http://localhost/api/auth/passkey/register/finish', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'x-real-ip': IP, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge_id: CHALLENGE_ID, credential: cred }),
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, CLIENT_IP_HEADER: 'x-real-ip' };
  counter.mockReset().mockResolvedValue(1);
  (requireCsrfOrDeny as jest.Mock).mockReset().mockResolvedValue(undefined);
  (checkAuthSessionLiveness as jest.Mock).mockReset().mockResolvedValue('active');
  (authenticateRequest as jest.Mock).mockReset().mockResolvedValue({
    ok: true,
    claims: { sub: USER_ID, session_id: SESSION_ID, amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) - 5 }] },
  });
  verifyMock.mockReset().mockResolvedValue({ ok: true, data: { id: PASSKEY_ID, friendly_name: 'k', created_at: '2026-11-17T00:00:00Z' } });
  isStaff = true;
  windowOpen = true;
  approveError = null;
  rpc = jest.fn(async (name: string) => {
    if (name === 'passkey_is_staff') return { data: isStaff, error: null };
    if (name === 'staff_invite_open') return { data: false, error: null };
    if (name === 'passkey_window_is_open') return { data: windowOpen, error: null };
    if (name === 'passkey_approved_count') return { data: 1, error: null };
    if (name === 'passkey_approve') return { data: null, error: approveError };
    return { data: null, error: null };
  });
  deletePasskey = jest.fn().mockResolvedValue({ data: null, error: null });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc, auth: { admin: { passkey: { deletePasskey } } } });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('API-AUTH-025 POST /api/auth/passkey/register/finish', () => {
  test('API-AUTH-025 窓の中の店員は 200 で、passkey_approve を via=window で呼び、approvedCount を返す', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passkey: { id: PASSKEY_ID }, approvedCount: 1 });
    expect(rpc).toHaveBeenCalledWith('passkey_approve', { p_user_id: USER_ID, p_passkey_id: PASSKEY_ID, p_via: 'window' });
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test('API-AUTH-025 終わりでも窓が閉じていれば 403 で、GoTrue の検証を呼ばない', async () => {
    windowOpen = false;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test('API-AUTH-025 UV の印が無い本物の形の attestationObject は 400 uv_required で、検証を呼ばない', async () => {
    const res = await POST(req(credential(false)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'uv_required' });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test('API-AUTH-025 認めが 55000（窓の上限）で落ちたら、管理 API で鍵を消して 500', async () => {
    approveError = { code: '55000' };
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'passkey_approve_failed' });
    expect(deletePasskey).toHaveBeenCalledWith({ userId: USER_ID, passkeyId: PASSKEY_ID });
  });

  test('API-AUTH-025 お客さんは passkey_approve を呼ばず 200', async () => {
    isStaff = false;
    windowOpen = false;
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalledWith('passkey_approve', expect.anything());
  });
});
