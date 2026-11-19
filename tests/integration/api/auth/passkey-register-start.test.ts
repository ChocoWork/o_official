/** @jest-environment node */
export {};

// パスキーの登録の始めの窓口（API-AUTH-024）。窓口・確かめの部品（passkey-registration-guard）・登録の条件の判定・回数の制限の本体（enforceRateLimit）・
// 認めの RPC の部品（passkey-approval-rpc）は本物を通し、外へ出る物（回数の表 incrementCounter・監査・認証の確かめ・CSRF・GoTrue・DB の RPC）だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ registrationOptions: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => {
  const actual = jest.requireActual('@/lib/auth/authenticate');
  return { ...actual, authenticateRequest: jest.fn(), checkAuthSessionLiveness: jest.fn() };
});

import { POST } from '@/app/api/auth/passkey/register/start/route';
import { incrementCounter } from '@/features/auth/ratelimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { registrationOptions } from '@/lib/auth/passkey-gotrue';
import { authenticateRequest, checkAuthSessionLiveness } from '@/lib/auth/authenticate';

const counter = incrementCounter as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
const IP = '203.0.113.40';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

let rpc: jest.Mock;
let isStaff: boolean;
let windowOpen: boolean;
let approved: number;

function req() {
  return new Request('http://localhost/api/auth/passkey/register/start', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'x-real-ip': IP },
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
  (registrationOptions as jest.Mock).mockReset().mockResolvedValue({
    ok: true,
    data: { challenge_id: 'c-1', expires_at: 1, options: { challenge: 'abc' } },
  });
  isStaff = true;
  windowOpen = true;
  approved = 0;
  rpc = jest.fn(async (name: string) => {
    if (name === 'passkey_is_staff') return { data: isStaff, error: null };
    if (name === 'staff_invite_open') return { data: false, error: null };
    if (name === 'passkey_window_is_open') return { data: windowOpen, error: null };
    if (name === 'passkey_approved_count') return { data: approved, error: null };
    return { data: null, error: null };
  });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('API-AUTH-024 POST /api/auth/passkey/register/start', () => {
  test('API-AUTH-024 本物の回数の制限（IP・本人）と窓の確かめを通り、窓の中の店員は 200 で mode が window', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'window', options: { authenticatorSelection: { userVerification: 'required' } } });
    expect(counter).toHaveBeenCalledWith(expect.objectContaining({ ip: IP, endpoint: 'auth:passkey:register:start' }));
    expect(counter).toHaveBeenCalledWith(expect.objectContaining({ subject: USER_ID, endpoint: 'auth:passkey:register:start' }));
    expect(checkAuthSessionLiveness).toHaveBeenCalledWith(SESSION_ID, true);
    expect(rpc).toHaveBeenCalledWith('passkey_window_is_open', { p_user_id: USER_ID, p_session_id: SESSION_ID });
    expect(rpc).toHaveBeenCalledWith('passkey_approved_count', { p_user_id: USER_ID });
  });

  test('API-AUTH-024 窓が閉じていれば 403 で、GoTrue を呼ばない', async () => {
    windowOpen = false;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
    expect(registrationOptions).not.toHaveBeenCalled();
  });

  test('API-AUTH-024 窓の中でも認めた鍵が2本なら 403 reauth_required', async () => {
    approved = 2;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'registration_not_allowed', reason: 'reauth_required' });
  });

  test('API-AUTH-024 お客さんは窓・本数を引かず、10分以内のメールのコードで 200 の customer', async () => {
    isStaff = false;
    windowOpen = false;
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('customer');
    expect(body.mode).not.toBe('window');
    // 窓が無い人は window では認められず、窓の道（生きたセッションの確かめ・認めた鍵の数）にも入らない
    expect(rpc).not.toHaveBeenCalledWith('passkey_approved_count', expect.anything());
    expect(checkAuthSessionLiveness).not.toHaveBeenCalled();
  });

  test('API-AUTH-024 回数の表が上限（21回目）を超えたら 429 で、認証を呼ばない', async () => {
    counter.mockResolvedValue(21);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(authenticateRequest).not.toHaveBeenCalled();
  });
});
