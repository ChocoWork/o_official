/** @jest-environment node */
export {};

// API-AUTH-030 メールのコードの確定の窓口。窓口・回数の制限の本体・zod の形・保留の Cookie・フックの拒否の見分けは本物を通し、
// 外へ出る物（回数の表・監査・GoTrue・セッションの保存・注文の引き継ぎ・鍵の一覧）だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createPublicClient: jest.fn(), createServiceRoleClient: jest.fn() }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/lib/orders/link-guest-orders', () => ({ linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ listPasskeys: jest.fn() }));

import { POST } from '@/app/api/auth/email-code/verify/route';
import { incrementCounter } from '@/features/auth/ratelimit';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { listPasskeys } from '@/lib/auth/passkey-gotrue';
import { createEmailCodeSessionToken } from '@/features/auth/services/email-code-session';

const counter = incrementCounter as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
let verifyOtp: jest.Mock;

const cookie = (jti = 'jti-1') => `sb-email-code-session=${encodeURIComponent(createEmailCodeSessionToken({ email: 'new@example.com', jti }))}`;
function req(withCookie = true, jti?: string) {
  return new Request('http://localhost/api/auth/email-code/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.41', ...(withCookie ? { cookie: cookie(jti) } : {}) },
    body: JSON.stringify({ code: '12345678' }),
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '', CLIENT_IP_HEADER: 'x-real-ip' };
  counter.mockReset().mockResolvedValue(1);
  verifyOtp = jest.fn().mockResolvedValue({
    data: {
      session: { access_token: 'acc', refresh_token: 'r' },
      user: { id: 'u1', email: 'new@example.com', email_confirmed_at: 'x', app_metadata: { email_code_signup_pending: true } },
    },
    error: null,
  });
  (createPublicClient as jest.Mock).mockReset().mockResolvedValue({ auth: { verifyOtp } });
  (createServiceRoleClient as jest.Mock)
    .mockReset()
    .mockResolvedValue({ auth: { admin: { updateUserById: jest.fn().mockResolvedValue({ error: null }) } } });
  (persistSessionAndCookies as jest.Mock).mockReset().mockResolvedValue({ ok: true });
  (listPasskeys as jest.Mock).mockReset().mockResolvedValue({ ok: true, data: [] });
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('API-AUTH-030 POST /api/auth/email-code/verify', () => {
  test('API-AUTH-030 Cookie が無ければ 401', async () => {
    expect((await POST(req(false))).status).toBe(401);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-030 成功は 200 と offerPasskey、保留の Cookie を消す', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: 'u1', role: 'user' }, offerPasskey: true });
    expect(res.headers.get('set-cookie') ?? '').toMatch(/sb-email-code-session=;/);
  });

  test('API-AUTH-030 Cookie ごとの枠は 5 回まで。6回目は 429 で Cookie を消し、確かめない', async () => {
    counter.mockImplementation(async ({ subject }: { subject: string | null }) => (subject === 'new@example.com:jti-1' ? 6 : 1));
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/sb-email-code-session=;/);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-030 別の Cookie（別の jti）の失敗は本人の Cookie の枠を使わない', async () => {
    const used: string[] = [];
    counter.mockImplementation(async ({ subject }: { subject: string | null }) => {
      if (subject) used.push(subject);
      return 1;
    });
    await POST(req(true, 'jti-attacker'));
    await POST(req(true, 'jti-owner'));
    expect(used).toEqual(expect.arrayContaining(['new@example.com:jti-attacker', 'new@example.com:jti-owner']));
    expect(new Set(used.filter((s) => s.includes(':'))).size).toBe(2);
  });

  test('API-AUTH-030 店員（フックの拒否の印）は 403 staff_passkey_required で、セッションも Cookie も作らない', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { status: 403, message: '[staff-passkey-required] ng' } });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
  });

  test('API-AUTH-030 コード違いは 401', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { status: 403, message: 'Token has expired or is invalid' } });
    expect((await POST(req())).status).toBe(401);
  });
});
