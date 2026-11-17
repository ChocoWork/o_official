/** @jest-environment node */
export {};

// パスキーのログインの終わりの窓口（API-AUTH-023）。窓口・回数の制限の本体（enforceRateLimit）・zod の形・UV の読み取り・
// 認めの RPC の部品（passkey-approval-rpc）は本物を通し、外へ出る物（回数の表 incrementCounter・監査・GoTrue・DB の RPC・セッションの保存・注文の引き継ぎ）だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createPublicClient: jest.fn(), createServiceRoleClient: jest.fn() }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/lib/orders/link-guest-orders', () => ({ linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/passkey/login/finish/route';
import { incrementCounter } from '@/features/auth/ratelimit';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { persistSessionAndCookies } from '@/features/auth/services/register';

const counter = incrementCounter as jest.Mock;
const persist = persistSessionAndCookies as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
const IP = '203.0.113.30';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACCESS_TOKEN = `h.${Buffer.from(JSON.stringify({ session_id: SESSION_ID })).toString('base64url')}.s`;

let verify: jest.Mock;
let rpc: jest.Mock;
let isStaff: boolean;
let approved: boolean;

function body(flags = 0x05) {
  const data = Buffer.alloc(37);
  data[32] = flags;
  return {
    challenge_id: '33333333-3333-4333-8333-333333333333',
    credential: {
      id: 'AAECAw',
      rawId: 'AAECAw',
      type: 'public-key',
      response: { clientDataJSON: 'eyJ4IjoxfQ', authenticatorData: data.toString('base64url'), signature: 'c2ln' },
    },
  };
}

function req(payload: unknown, headers: Record<string, string> = { 'x-real-ip': IP }) {
  return new Request('http://localhost/api/auth/passkey/login/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, CLIENT_IP_HEADER: 'x-real-ip' };
  counter.mockReset().mockResolvedValue(1);
  persist.mockReset().mockResolvedValue({ ok: true });
  isStaff = false;
  approved = true;
  verify = jest.fn().mockResolvedValue({
    data: {
      session: { access_token: ACCESS_TOKEN, refresh_token: 'r' },
      user: { id: USER_ID, email: 'a@example.com', email_confirmed_at: null, app_metadata: {} },
    },
    error: null,
  });
  (createPublicClient as jest.Mock).mockResolvedValue({ auth: { passkey: { verifyAuthentication: verify } } });
  rpc = jest.fn(async (name: string) => {
    if (name === 'passkey_is_staff') return { data: isStaff, error: null };
    if (name === 'passkey_credential_is_approved') return { data: approved, error: null };
    return { data: null, error: null };
  });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('API-AUTH-023 POST /api/auth/passkey/login/finish', () => {
  test('API-AUTH-023 本物の回数の制限と IP の取り出しを通り、お客さんは 200 で認めの表を引かない', async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(counter).toHaveBeenCalledWith(expect.objectContaining({ ip: IP, endpoint: 'auth:passkey:login:finish' }));
    expect(rpc).toHaveBeenCalledWith('passkey_is_staff', { p_user_id: USER_ID });
    expect(rpc).not.toHaveBeenCalledWith('passkey_credential_is_approved', expect.anything());
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-023 回数の表が上限（31回目）を超えたら 429 で、GoTrue を呼ばない', async () => {
    counter.mockResolvedValue(31);
    const res = await POST(req(body()));
    expect(res.status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
  });

  test('API-AUTH-023 UV の印が無い応答は 400 uv_required で、GoTrue を呼ばない', async () => {
    const res = await POST(req(body(0x01)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'uv_required' });
    expect(verify).not.toHaveBeenCalled();
  });

  test('API-AUTH-023 店員が認めた鍵なら 200。rawId を bytea（16進）に直して認めの表を引く', async () => {
    isStaff = true;
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('passkey_credential_is_approved', {
      p_user_id: USER_ID,
      p_credential_id: '\\x000102' + '03',
    });
  });

  test('API-AUTH-023 店員が認めていない鍵なら 403 で、セッションを終わらせ、保存しない', async () => {
    isStaff = true;
    approved = false;
    const res = await POST(req(body()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'passkey_not_approved' });
    expect(rpc).toHaveBeenCalledWith('revoke_auth_session', { p_session_id: SESSION_ID });
    expect(persist).not.toHaveBeenCalled();
  });
});
