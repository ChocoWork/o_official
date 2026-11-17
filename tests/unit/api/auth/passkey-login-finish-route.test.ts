/** @jest-environment node */
/**
 * DD-AUTH-055 パスキーのログインの終わりの窓口（src/app/api/auth/passkey/login/finish/route.ts）の単体テスト。
 * GoTrue（supabase-js）・認めの RPC・セッションの保存・注文の引き継ぎ・戻り先の控えは差し替え、断りの順番と副作用の有無を確かめる。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ isStaff: jest.fn(), isCredentialApproved: jest.fn() }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/features/cart/services/guest-shopping-token', () => ({ readGuestShoppingTokens: jest.fn(() => ({})) }));
jest.mock('@/lib/orders/link-guest-orders', () => ({ linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  issueReturnIntent: jest.fn(),
  applyReturnIntentCookie: jest.fn(),
}));

import { POST } from '@/app/api/auth/passkey/login/finish/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isCredentialApproved, isStaff } from '@/lib/auth/passkey-approval-rpc';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';
import { applyReturnIntentCookie, issueReturnIntent } from '@/features/auth/return-intent/return-intent-service';
import { logAudit } from '@/lib/audit';

const rateLimit = enforceRateLimit as jest.Mock;
const publicClient = createPublicClient as jest.Mock;
const serviceClient = createServiceRoleClient as jest.Mock;
const staffMock = isStaff as jest.Mock;
const approvedMock = isCredentialApproved as jest.Mock;
const persist = persistSessionAndCookies as jest.Mock;
const linkOrders = linkGuestOrdersByEmail as jest.Mock;
const issueIntent = issueReturnIntent as jest.Mock;
const applyIntent = applyReturnIntentCookie as jest.Mock;
const audit = logAudit as jest.Mock;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS_TOKEN = `h.${Buffer.from(JSON.stringify({ session_id: SESSION_ID })).toString('base64url')}.s`;

function authData(flags: number, length = 37): string {
  const bytes = Buffer.alloc(length);
  if (length > 32) bytes[32] = flags;
  return bytes.toString('base64url');
}

function credential(overrides: Record<string, unknown> = {}, responseOverrides: Record<string, unknown> = {}) {
  return {
    id: 'AAECAw',
    rawId: 'AAECAw',
    type: 'public-key',
    response: {
      clientDataJSON: 'eyJ4IjoxfQ',
      authenticatorData: authData(0x05),
      signature: 'c2ln',
      ...responseOverrides,
    },
    ...overrides,
  };
}

function req(body: unknown) {
  return new Request('http://localhost/api/auth/passkey/login/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'x=1' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const goodBody = (extra: Record<string, unknown> = {}) => ({ challenge_id: CHALLENGE_ID, credential: credential(), ...extra });

let verify: jest.Mock;
let rpc: jest.Mock;

function gotrueOk(role?: string) {
  verify.mockResolvedValue({
    data: {
      session: { access_token: ACCESS_TOKEN, refresh_token: 'r' },
      user: { id: USER_ID, email: 'a@example.com', email_confirmed_at: '2026-01-01', app_metadata: role ? { role } : {} },
    },
    error: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit.mockResolvedValue(undefined);
  verify = jest.fn();
  publicClient.mockResolvedValue({ auth: { passkey: { verifyAuthentication: verify } } });
  rpc = jest.fn().mockResolvedValue({ error: null });
  serviceClient.mockResolvedValue({ rpc });
  staffMock.mockResolvedValue({ ok: true, value: false });
  approvedMock.mockResolvedValue({ ok: true, value: true });
  persist.mockResolvedValue({ ok: true });
  issueIntent.mockResolvedValue({ action: { kind: 'clear' }, outcome: 'cleared' });
  gotrueOk();
});

describe('DD-AUTH-055 ログインの終わりの入口（GoTrue を呼ぶ前の断り）', () => {
  test('DD-AUTH-055 回数の制限に掛かったら、その応答をそのまま返し GoTrue を呼ばない', async () => {
    rateLimit.mockResolvedValue(new Response('{}', { status: 429 }));
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
  });

  test.each([
    ['JSON でない本文', 'not json'],
    ['challenge_id が uuid でない', { challenge_id: 'x', credential: credential() }],
    ['credential が無い', { challenge_id: CHALLENGE_ID }],
  ])('DD-AUTH-055 本文が不正（%s）は 400 invalid_request で GoTrue 0回', async (_name, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(verify).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 id と rawId が違う応答は 400 invalid_request で GoTrue 0回（SEC-AUTH-044）', async () => {
    const res = await POST(req(goodBody({ credential: credential({ rawId: 'BBBBBB' }) })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(verify).not.toHaveBeenCalled();
  });

  test.each([
    ['UV の印が無い（UP だけ）', authData(0x01)],
    ['36バイトの authenticatorData', authData(0x05, 36)],
    ['壊れた base64url（長さが4で割って1余る）', 'AAAAA'],
  ])('DD-AUTH-055 %s は 400 uv_required で GoTrue 0回（SEC-AUTH-044）', async (_name, data) => {
    const res = await POST(req(goodBody({ credential: credential({}, { authenticatorData: data }) })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'uv_required' });
    expect(verify).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-055 GoTrue の失敗の写し方', () => {
  test('DD-AUTH-055 GoTrue の誤りは理由に関わらず 401 passkey_login_failed の同じ本文で、GoTrue の文を返さない', async () => {
    const bodies: unknown[] = [];
    for (const error of [
      { status: 400, message: 'credential not found' },
      { status: 400, message: 'signature invalid' },
      { status: 500, message: 'boom' },
    ]) {
      verify.mockResolvedValue({ data: { session: null, user: null }, error });
      const res = await POST(req(goodBody()));
      expect(res.status).toBe(401);
      bodies.push(await res.json());
    }
    expect(bodies).toEqual([
      { error: 'passkey_login_failed' },
      { error: 'passkey_login_failed' },
      { error: 'passkey_login_failed' },
    ]);
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 印つきの 403 は 403 staff_passkey_required', async () => {
    verify.mockResolvedValue({
      data: { session: null, user: null },
      error: { status: 403, message: '[staff-passkey-required] 店員はパスキーだけ' },
    });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'staff_passkey_required' });
  });

  test('DD-AUTH-055 印の無い 403 は 401 passkey_login_failed', async () => {
    verify.mockResolvedValue({ data: { session: null, user: null }, error: { status: 403, message: 'other' } });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(401);
  });

  test('DD-AUTH-055 GoTrue が 429 なら 429', async () => {
    verify.mockResolvedValue({ data: { session: null, user: null }, error: { status: 429, message: 'x' } });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(429);
  });

  test('DD-AUTH-055 GoTrue の成功の応答に session・user が無ければ閉じる（401・保存しない）', async () => {
    verify.mockResolvedValue({ data: { session: null, user: null }, error: null });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(401);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-055 店員の確かめ（SEC-AUTH-044）', () => {
  test('DD-AUTH-055 お客さんは認めの表を引かず 200・Cookie の保存・注文の引き継ぎ・role は user', async () => {
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: USER_ID, email: 'a@example.com', role: 'user' } });
    expect(approvedMock).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(linkOrders).toHaveBeenCalledWith({ userId: USER_ID, email: 'a@example.com', emailConfirmedAt: '2026-01-01' });
    expect(rpc).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  test('DD-AUTH-055 店員で認めた鍵は 200・role は app_metadata の値。rawId を渡して引く', async () => {
    gotrueOk('admin');
    staffMock.mockResolvedValue({ ok: true, value: true });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('admin');
    expect(approvedMock).toHaveBeenCalledWith(USER_ID, 'AAECAw');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 店員で認めていない鍵は 403 passkey_not_approved・セッションを1回終わらせ・保存0回・Cookie なし', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    approvedMock.mockResolvedValue({ ok: true, value: false });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'passkey_not_approved' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('revoke_auth_session', { p_session_id: SESSION_ID });
    expect(persist).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(linkOrders).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'passkey_not_approved' }));
  });

  test('DD-AUTH-055 店員の判定の RPC が落ちたら 503・セッションを終わらせ・保存0回', async () => {
    staffMock.mockResolvedValue({ ok: false });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 認めた鍵の確かめの RPC が落ちたら 503・セッションを終わらせ・保存0回', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    approvedMock.mockResolvedValue({ ok: false });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 セッションを終わらせる RPC が失敗しても、断りは変わらず 403', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    approvedMock.mockResolvedValue({ ok: true, value: false });
    rpc.mockResolvedValue({ error: { code: 'x' } });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(403);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-055 セッションの保存と戻り先', () => {
  test('DD-AUTH-055 保存が失敗したら 500 で、注文の引き継ぎをしない', async () => {
    persist.mockResolvedValue({ ok: false, error: 'x' });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(500);
    expect(linkOrders).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 next が不正なら控えは clear でログインは成功する', async () => {
    const res = await POST(req(goodBody({ next: 'https://evil.example/' })));
    expect(res.status).toBe(200);
    expect(issueIntent).toHaveBeenCalledWith({ rawNext: 'https://evil.example/', purpose: 'login' });
    expect(applyIntent).toHaveBeenCalledWith(expect.anything(), { kind: 'clear' });
  });

  test('DD-AUTH-055 next が正しければ控えの set の動作を応答に当てる', async () => {
    issueIntent.mockResolvedValue({ action: { kind: 'set', token: 't', maxAgeSeconds: 600 }, outcome: 'created' });
    const res = await POST(req(goodBody({ next: '/admin' })));
    expect(res.status).toBe(200);
    expect(applyIntent).toHaveBeenCalledWith(expect.anything(), { kind: 'set', token: 't', maxAgeSeconds: 600 });
  });

  test('DD-AUTH-055 監査にトークン・challenge_id・メールを残さない', async () => {
    await POST(req(goodBody()));
    const dump = JSON.stringify(audit.mock.calls);
    expect(dump).not.toContain(ACCESS_TOKEN);
    expect(dump).not.toContain(CHALLENGE_ID);
    expect(dump).not.toContain('a@example.com');
  });
});

describe('DD-AUTH-055 GoTrue の応答の形と欠けた項目', () => {
  test('DD-AUTH-055 GoTrue の応答の data が null でも閉じる（401）', async () => {
    verify.mockResolvedValue({ data: null, error: null });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(401);
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 session があって user が無い応答は、作られたセッションを終わらせて 401', async () => {
    verify.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN, refresh_token: 'r' }, user: null }, error: null });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(401);
    expect(rpc).toHaveBeenCalledWith('revoke_auth_session', { p_session_id: SESSION_ID });
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 認めていない店員でも、アクセストークンに session_id が無ければ終わらせられないが、断りは 403 のまま', async () => {
    verify.mockResolvedValue({
      data: { session: { access_token: 'h.e30.s', refresh_token: 'r' }, user: { id: USER_ID, email: 'a@example.com' } },
      error: null,
    });
    staffMock.mockResolvedValue({ ok: true, value: true });
    approvedMock.mockResolvedValue({ ok: true, value: false });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 セッションを終わらせる RPC が例外でも、断りは変わらない', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    approvedMock.mockResolvedValue({ ok: true, value: false });
    serviceClient.mockRejectedValue(new Error('x'));
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(403);
  });

  test('DD-AUTH-055 メールも app_metadata も確認日時も無い利用者は 200 で、email は null・role は user・注文の引き継ぎはしない', async () => {
    verify.mockResolvedValue({
      data: { session: { access_token: ACCESS_TOKEN, refresh_token: 'r' }, user: { id: USER_ID } },
      error: null,
    });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: USER_ID, email: null, role: 'user' } });
    expect(linkOrders).not.toHaveBeenCalled();
  });

  test('DD-AUTH-055 メールがあって確認日時が無い利用者の引き継ぎは emailConfirmedAt が null', async () => {
    verify.mockResolvedValue({
      data: { session: { access_token: ACCESS_TOKEN, refresh_token: 'r' }, user: { id: USER_ID, email: 'a@example.com' } },
      error: null,
    });
    await POST(req(goodBody()));
    expect(linkOrders).toHaveBeenCalledWith({ userId: USER_ID, email: 'a@example.com', emailConfirmedAt: null });
  });

  test('DD-AUTH-055 保存が結果を返さなくても失敗として 500', async () => {
    persist.mockResolvedValue(undefined);
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(500);
  });

  test('DD-AUTH-055 想定外の例外は 500 で、本文に例外の文を出さない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    publicClient.mockRejectedValue(new Error('secret detail'));
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
  });
});

describe('DD-AUTH-060 null の項目を GoTrue へ渡さない', () => {
  test('DD-AUTH-060 authenticatorAttachment: null の応答は 400 にならず、GoTrue へは null を落として渡す', async () => {
    const res = await POST(req(goodBody({ credential: credential({ authenticatorAttachment: null }) })));
    expect(res.status).toBe(200);
    const passed = verify.mock.calls[0][0].credential as Record<string, unknown>;
    expect('authenticatorAttachment' in passed).toBe(false);
    expect(passed.rawId).toBe('AAECAw');
  });
});
