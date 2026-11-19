/** @jest-environment node */
/**
 * DD-AUTH-078 店員の招待のリンクの受け口（src/app/api/auth/staff/invite/start/route.ts）の単体テスト。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), createPublicClient: jest.fn() }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/lib/auth/passkey-auth-session-end', () => ({ endAuthSession: jest.fn().mockResolvedValue(true) }));

import { POST } from '@/app/api/auth/staff/invite/start/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { endAuthSession } from '@/lib/auth/passkey-auth-session-end';
import { logAudit } from '@/lib/audit';

const rateLimit = enforceRateLimit as jest.Mock;
const persist = persistSessionAndCookies as jest.Mock;
const endSession = endAuthSession as jest.Mock;
const audit = logAudit as jest.Mock;

const TOKEN = 'B'.repeat(43);
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const INVITE_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS = `h.${Buffer.from(JSON.stringify({ session_id: SESSION_ID })).toString('base64url')}.s`;

let rpc: jest.Mock;
let getUserById: jest.Mock;
let generateLink: jest.Mock;
let verifyOtp: jest.Mock;

const req = (body: unknown) =>
  new Request('http://localhost/api/auth/staff/invite/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit.mockResolvedValue(undefined);
  rpc = jest.fn(async (name: string) => {
    if (name === 'staff_invite_consume') {
      return { data: [{ invite_id: INVITE_ID, user_id: USER_ID, role_code: 'admin' }], error: null };
    }
    return { data: null, error: null };
  });
  getUserById = jest.fn().mockResolvedValue({ data: { user: { email: 'a@example.com' } }, error: null });
  generateLink = jest.fn().mockResolvedValue({ data: { properties: { hashed_token: 'hashed' } }, error: null });
  verifyOtp = jest.fn().mockResolvedValue({
    data: { session: { access_token: ACCESS, refresh_token: 'r' }, user: { id: USER_ID, email: 'a@example.com' } },
    error: null,
  });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc, auth: { admin: { getUserById, generateLink } } });
  (createPublicClient as jest.Mock).mockResolvedValue({ auth: { verifyOtp } });
  persist.mockResolvedValue({ ok: true });
});

describe('DD-AUTH-078 招待の受け口', () => {
  test('DD-AUTH-078 成功: 消費 → セッション作成 → session_id で結ぶ → 結び付け → redirectTo、no-store', async () => {
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: '/staff/register' });
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'a@example.com' });
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'magiclink', token_hash: 'hashed' });
    expect(rpc).toHaveBeenCalledWith('staff_invite_bind_window', { p_invite_id: INVITE_ID, p_session_id: SESSION_ID });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(endSession).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.mock.calls)).not.toContain(TOKEN);
  });

  test('DD-AUTH-078 使用済み・期限切れ・取り消し・不明（消費が0行）は同じ本文の400で、セッションを作らない', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invite_invalid' });
    expect(generateLink).not.toHaveBeenCalled();
    const bad = await POST(req({ token: 'short' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invite_invalid' });
    const broken = await POST(req('{'));
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'invite_invalid' });
  });

  test('DD-AUTH-078 回数の制限は応答をそのまま返し、消費しない', async () => {
    const limited = new Response('{}', { status: 429 });
    rateLimit.mockResolvedValueOnce(limited);
    expect(await POST(req({ token: TOKEN }))).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 IP の枠（20回/10分）と合言葉のハッシュごとの枠（5回/10分）を使う', async () => {
    await POST(req({ token: TOKEN }));
    expect(rateLimit.mock.calls[0][0]).toMatchObject({ limit: 20, windowSeconds: 600 });
    expect(rateLimit.mock.calls[1][0]).toMatchObject({ limit: 5, windowSeconds: 600 });
    expect(rateLimit.mock.calls[1][0].subject).toMatch(/^[0-9a-f]{64}$/);
  });

  test('DD-AUTH-078 GoTrue の失敗（generateLink）は500で、窓は開かず、結び付けもしない', async () => {
    generateLink.mockResolvedValue({ data: null, error: { message: 'x' } });
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalledWith('staff_invite_bind_window', expect.anything());
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 結びの失敗は、作ったセッションを終わらせて500', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'staff_invite_consume'
        ? { data: [{ invite_id: INVITE_ID, user_id: USER_ID, role_code: 'admin' }], error: null }
        : { data: null, error: { message: 'STAFF_INVITE_ALREADY_BOUND' } },
    );
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(endSession).toHaveBeenCalledWith(ACCESS);
    expect(persist).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 作ったセッションを終わらせるのに失敗したら、session_revoke_failed を監査に残し、合言葉は残さない', async () => {
    persist.mockResolvedValue({ ok: false });
    endSession.mockResolvedValueOnce(false);
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'session_revoke_failed', actor_id: USER_ID }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(TOKEN);
  });

  test('DD-AUTH-078 作ったセッションを終わらせるのに成功した時は、session_revoke_failed を監査に残さない', async () => {
    persist.mockResolvedValue({ ok: false });
    endSession.mockResolvedValueOnce(true);
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(endSession).toHaveBeenCalledWith(ACCESS);
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ detail: 'session_revoke_failed' }));
  });

  test('DD-AUTH-078 アプリの結び付けの失敗は、セッションを終わらせて500', async () => {
    persist.mockResolvedValue({ ok: false });
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(endSession).toHaveBeenCalledWith(ACCESS);
  });

  test('DD-AUTH-078 session_id が読めない時は、結ばずに500', async () => {
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'x.y.z', refresh_token: 'r' }, user: { id: USER_ID } },
      error: null,
    });
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalledWith('staff_invite_bind_window', expect.anything());
  });

  test('DD-AUTH-078 本文が null でも 400 invite_invalid', async () => {
    const res = await POST(req('null'));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 合言葉のハッシュごとの枠が尽きたら、消費せずその応答を返す', async () => {
    const limited = new Response('{}', { status: 429 });
    rateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);
    expect(await POST(req({ token: TOKEN }))).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 アプリの保存が結果を返さない時も、セッションを終わらせて500', async () => {
    persist.mockResolvedValue(undefined);
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(endSession).toHaveBeenCalledWith(ACCESS);
  });
});
