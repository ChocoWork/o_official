/** @jest-environment node */
/**
 * DD-AUTH-059 メールのコードの確定の窓口（src/app/api/auth/email-code/verify/route.ts）の単体テスト。
 * 共有部品は差し替え、窓口の分岐を通す。保留の Cookie は本物。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createPublicClient: jest.fn(), createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/features/cart/services/guest-shopping-token', () => ({ readGuestShoppingTokens: jest.fn(() => ({})) }));
jest.mock('@/lib/orders/link-guest-orders', () => ({ linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ listPasskeys: jest.fn() }));

import { POST } from '@/app/api/auth/email-code/verify/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';
import { listPasskeys } from '@/lib/auth/passkey-gotrue';
import { logAudit } from '@/lib/audit';
import { createEmailCodeSessionToken } from '@/features/auth/services/email-code-session';

const rateLimit = enforceRateLimit as jest.Mock;
const publicClient = createPublicClient as jest.Mock;
const serviceClient = createServiceRoleClient as jest.Mock;
const persist = persistSessionAndCookies as jest.Mock;
const linkOrders = linkGuestOrdersByEmail as jest.Mock;
const list = listPasskeys as jest.Mock;
const audit = logAudit as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const EMAIL = 'new@example.com';
let verifyOtp: jest.Mock;
let updateUserById: jest.Mock;

function req(body: unknown = { code: '12345678' }, cookie?: string) {
  return new Request('http://localhost/api/auth/email-code/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
const pendingCookie = (jti = 'jti-1', email = EMAIL) =>
  `sb-email-code-session=${encodeURIComponent(createEmailCodeSessionToken({ email, jti }))}`;

function okVerify(over: { role?: string; pending?: boolean } = {}) {
  verifyOtp.mockResolvedValue({
    data: {
      session: { access_token: 'acc', refresh_token: 'ref' },
      user: {
        id: 'u1',
        email: EMAIL,
        email_confirmed_at: '2026-11-17T00:00:00Z',
        app_metadata: { ...(over.role ? { role: over.role } : {}), ...(over.pending === false ? {} : { email_code_signup_pending: true }) },
      },
    },
    error: null,
  });
}
const clearsCookie = (res: Response) => /sb-email-code-session=;/.test(res.headers.get('set-cookie') ?? '');

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '' };
  rateLimit.mockReset().mockResolvedValue(undefined);
  verifyOtp = jest.fn();
  updateUserById = jest.fn().mockResolvedValue({ error: null });
  publicClient.mockReset().mockResolvedValue({ auth: { verifyOtp } });
  serviceClient.mockReset().mockResolvedValue({ auth: { admin: { updateUserById } } });
  persist.mockReset().mockResolvedValue({ ok: true });
  linkOrders.mockClear();
  list.mockReset().mockResolvedValue({ ok: true, data: [] });
  audit.mockClear();
  okVerify();
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('DD-AUTH-059 POST /api/auth/email-code/verify', () => {
  test('DD-AUTH-059 Cookie が無ければ 401 で、確かめない', async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 旧い保留の Cookie（login_2fa）は 401', async () => {
    const legacy = `sb-login-2fa-session=${encodeURIComponent('legacy-pending-value')}`;
    expect((await POST(req({ code: '12345678' }, legacy))).status).toBe(401);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 コードの形が違えば 400', async () => {
    expect((await POST(req({ code: '123' }, pendingCookie()))).status).toBe(400);
  });

  test('DD-AUTH-059 宛先は Cookie 由来。本文の email は無視する', async () => {
    await POST(req({ code: '12345678', email: 'victim@example.com' }, pendingCookie()));
    expect(verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: '12345678', type: 'email' });
  });

  test('DD-AUTH-059 枠は Cookie ごと（email:jti・5回）と宛先ごと（20回）の2段。別の jti は別の枠', async () => {
    await POST(req({ code: '12345678' }, pendingCookie('jti-A')));
    await POST(req({ code: '12345678' }, pendingCookie('jti-B')));
    const subjects = rateLimit.mock.calls.map((c) => [c[0].limit, c[0].subject]);
    expect(subjects).toEqual([
      [30, undefined], [5, `${EMAIL}:jti-A`], [20, EMAIL],
      [30, undefined], [5, `${EMAIL}:jti-B`], [20, EMAIL],
    ]);
    expect(rateLimit.mock.calls.every((c) => c[0].endpoint === 'auth:email-code:verify')).toBe(true);
  });

  test('DD-AUTH-059 Cookie の枠を使い切ったら Cookie を消して 429（確かめない。宛先の枠は数えない）', async () => {
    rateLimit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '600' } }));
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(clearsCookie(res)).toBe(true);
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledTimes(2);
  });

  test('DD-AUTH-059 宛先ごとの上限を使い切っても Cookie を消して 429', async () => {
    rateLimit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect(res.status).toBe(429);
    expect(clearsCookie(res)).toBe(true);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 IP の枠が先。使い切れば Cookie を見ずに 429', async () => {
    rateLimit.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await POST(req({ code: '12345678' }, pendingCookie()))).status).toBe(429);
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  test('DD-AUTH-059 成功: 200 と user・offerPasskey、セッションを保存し、印を外し、注文を引き継ぎ、保留の Cookie を消す', async () => {
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: 'u1', email: EMAIL, role: 'user' },
      offerPasskey: true,
      message: '認証に成功しました。',
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(updateUserById).toHaveBeenCalledWith('u1', { app_metadata: { email_code_signup_pending: null } });
    expect(linkOrders).toHaveBeenCalledWith({ userId: 'u1', email: EMAIL, emailConfirmedAt: '2026-11-17T00:00:00Z' });
    expect(clearsCookie(res)).toBe(true);
  });

  test('DD-AUTH-059 印が無い登録済みの人では印を外す呼び出しをしない', async () => {
    okVerify({ pending: false });
    await POST(req({ code: '12345678' }, pendingCookie()));
    expect(updateUserById).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 印を外す失敗（返り値・例外）でもログインは成功し、監査に符号だけ残る', async () => {
    updateUserById.mockResolvedValueOnce({ error: { message: 'x' } });
    expect((await POST(req({ code: '12345678' }, pendingCookie()))).status).toBe(200);
    updateUserById.mockRejectedValueOnce(new Error('boom'));
    expect((await POST(req({ code: '12345678' }, pendingCookie()))).status).toBe(200);
    expect(audit.mock.calls.filter((c) => c[0].detail === 'signup_mark_clear_failed')).toHaveLength(2);
  });

  test('DD-AUTH-059 offerPasskey: 0本 true・1本 false・店員 false・一覧の失敗 false・例外 false', async () => {
    list.mockResolvedValueOnce({ ok: true, data: [{ id: 'k' }] });
    expect((await (await POST(req({ code: '12345678' }, pendingCookie()))).json()).offerPasskey).toBe(false);
    list.mockResolvedValueOnce({ ok: false, status: 500 });
    expect((await (await POST(req({ code: '12345678' }, pendingCookie()))).json()).offerPasskey).toBe(false);
    list.mockRejectedValueOnce(new Error('net'));
    expect((await (await POST(req({ code: '12345678' }, pendingCookie()))).json()).offerPasskey).toBe(false);
    okVerify({ role: 'admin' });
    list.mockClear();
    const staff = await (await POST(req({ code: '12345678' }, pendingCookie()))).json();
    expect(staff.offerPasskey).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 フックの拒否（印つき）は 403 staff_passkey_required。Cookie は消し、セッションを保存しない', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { status: 403, message: '[staff-passkey-required] x' } });
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'staff_passkey_required' });
    expect(clearsCookie(res)).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 コード違いは 401 で、Cookie は消さず、セッションを保存しない', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { status: 403, message: 'Token has expired or is invalid' } });
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: '認証コードが無効、または期限切れです。' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 サポーターの role をそのまま返し、鍵の一覧は呼ばない', async () => {
    okVerify({ role: 'supporter' });
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect((await res.json()).user.role).toBe('supporter');
    expect(list).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 利用者の email・app_metadata・email_confirmed_at が無い形でも、宛先は保留の Cookie のメールで続く', async () => {
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'acc', refresh_token: 'r' }, user: { id: 'u1' } },
      error: null,
    });
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe(EMAIL);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(linkOrders).toHaveBeenCalledWith({ userId: 'u1', email: EMAIL, emailConfirmedAt: null });
  });

  test('DD-AUTH-059 エラーが無くてもセッションか利用者が欠けた応答は 401', async () => {
    verifyOtp.mockResolvedValueOnce({ data: null, error: null });
    expect((await POST(req({ code: '12345678' }, pendingCookie()))).status).toBe(401);
    verifyOtp.mockResolvedValueOnce({ data: { session: null, user: { id: 'u1' } }, error: null });
    expect((await POST(req({ code: '12345678' }, pendingCookie()))).status).toBe(401);
    verifyOtp.mockResolvedValueOnce({ data: { session: { access_token: 'acc' }, user: null }, error: null });
    expect((await POST(req({ code: '12345678' }, pendingCookie()))).status).toBe(401);
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 セッションの保存が結果を返さない時も 500 で、利用者の email が無ければ宛先は Cookie のメール', async () => {
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'acc', refresh_token: 'r' }, user: { id: 'u1' } },
      error: null,
    });
    persist.mockResolvedValueOnce(undefined);
    expect((await POST(req({ code: '12345678' }, pendingCookie()))).status).toBe(500);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actor_email: EMAIL, detail: 'session_persist_failed: unknown' }));
  });

  test('DD-AUTH-059 セッションの保存の失敗は 500 で、印を外さず注文も引き継がない', async () => {
    persist.mockResolvedValueOnce({ ok: false, error: 'db' });
    const res = await POST(req({ code: '12345678' }, pendingCookie()));
    expect(res.status).toBe(500);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(linkOrders).not.toHaveBeenCalled();
  });
});
