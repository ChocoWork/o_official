/** @jest-environment node */
/**
 * DD-AUTH-080 2本の登録の終わりの窓口（src/app/api/auth/staff/register/complete/route.ts）の単体テスト。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/auth/request-token', () => ({ extractAuthToken: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
  authFailureResponse: jest.fn(
    (reason: string) =>
      new Response(JSON.stringify({ error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' }), {
        status: reason === 'unavailable' ? 503 : 401,
      }),
  ),
}));
jest.mock('@/lib/auth/passkey-auth-session-end', () => ({ endAuthSession: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/auth/revoke-user-sessions', () => ({
  revokeAllSessionsForUser: jest.fn().mockResolvedValue({ authSessionsDeleted: 1 }),
}));

import { POST } from '@/app/api/auth/staff/register/complete/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { extractAuthToken } from '@/lib/auth/request-token';
import { authenticateRequest, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { endAuthSession } from '@/lib/auth/passkey-auth-session-end';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';

const rateLimit = enforceRateLimit as jest.Mock;
const csrf = requireCsrfOrDeny as jest.Mock;
const authenticate = authenticateRequest as jest.Mock;
const liveness = checkAuthSessionLiveness as jest.Mock;
const endSession = endAuthSession as jest.Mock;
const revokeAll = revokeAllSessionsForUser as jest.Mock;
const audit = logAudit as jest.Mock;

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS = 'access.token.value';

let rpc: jest.Mock;

const req = () => new Request('http://localhost/api/auth/staff/register/complete', { method: 'POST' });

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit.mockResolvedValue(undefined);
  csrf.mockResolvedValue(undefined);
  authenticate.mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: SESSION_ID } });
  liveness.mockResolvedValue('active');
  (extractAuthToken as jest.Mock).mockReturnValue(ACCESS);
  rpc = jest.fn().mockResolvedValue({ data: { role: 'admin' }, error: null });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  endSession.mockResolvedValue(true);
  revokeAll.mockResolvedValue({ authSessionsDeleted: 1 });
});

describe('DD-AUTH-080 2本の登録の終わりの窓口', () => {
  test('DD-AUTH-080 成功: 役割を有効にし、全ログインを終わらせ、Cookie を消して /login へ。鍵の ID は載せない', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: '/login' });
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(rpc).toHaveBeenCalledWith('staff_role_activate', { p_user_id: USER_ID, p_session_id: SESSION_ID });
    expect(endSession).toHaveBeenCalledWith(ACCESS);
    expect(revokeAll).toHaveBeenCalledWith(USER_ID);
    const setCookie = res.headers.get('set-cookie') ?? '';
    for (const name of ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token', 'session_id']) {
      expect(setCookie).toMatch(new RegExp(`${name}=;`));
    }
    expect(setCookie).toMatch(/Max-Age=0/i);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(SESSION_ID);
  });

  test('DD-AUTH-080 1本だけ（keys_short）は 409 で、役割もログインも変えない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_ACTIVATE_KEYS_SHORT' } });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'keys_short' });
    expect(endSession).not.toHaveBeenCalled();
    expect(revokeAll).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/sb-access-token/);
  });

  test('DD-AUTH-080 窓の外で登録した鍵がある（keys_not_window）は 409', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_ACTIVATE_KEYS_NOT_WINDOW' } });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'keys_not_window' });
    expect(revokeAll).not.toHaveBeenCalled();
  });

  test.each(['STAFF_ACTIVATE_NO_WINDOW', 'STAFF_ACTIVATE_INVITE_INVALID'])(
    'DD-AUTH-080 窓が閉じたセッション（%s）は 403 window_closed',
    async (message) => {
      rpc.mockResolvedValue({ data: null, error: { message } });
      const res = await POST(req());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'window_closed' });
      expect(revokeAll).not.toHaveBeenCalled();
    },
  );

  test('DD-AUTH-080 DB の知らない失敗・例外は 500 で、役割もログインも変えない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'something' } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'register_complete_failed' });
    rpc.mockRejectedValue(new Error('down'));
    expect((await POST(req())).status).toBe(500);
    expect(revokeAll).not.toHaveBeenCalled();
  });

  test('DD-AUTH-080 ログインの終了が落ちても、役割は有効なので 200 で Cookie は消し、監査に残す', async () => {
    revokeAll.mockRejectedValue(new Error('x'));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/sb-access-token=;/);
    expect(audit.mock.calls.some(([entry]) => entry.outcome === 'error' && entry.detail === 'session_revocation_failed')).toBe(true);
  });

  test('DD-AUTH-080 未認証は 401、確認できない時は 503 で、DB を呼ばない', async () => {
    authenticate.mockResolvedValueOnce({ ok: false, reason: 'missing' });
    expect((await POST(req())).status).toBe(401);
    authenticate.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    expect((await POST(req())).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-080 アプリに結び付いた生きたセッションでなければ 401、確認できなければ 503', async () => {
    liveness.mockResolvedValueOnce('revoked');
    expect((await POST(req())).status).toBe(401);
    liveness.mockResolvedValueOnce('unavailable');
    expect((await POST(req())).status).toBe(503);
    expect(liveness).toHaveBeenCalledWith(SESSION_ID, true);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-080 session_id の無いトークンは 401', async () => {
    authenticate.mockResolvedValueOnce({ ok: true, claims: { sub: USER_ID } });
    expect((await POST(req())).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-080 CSRF の拒否・回数の制限は、その応答をそのまま返し、DB を呼ばない', async () => {
    const denied = new Response('{}', { status: 403 });
    csrf.mockResolvedValueOnce(denied);
    expect(await POST(req())).toBe(denied);
    const limited = new Response('{}', { status: 429 });
    rateLimit.mockResolvedValueOnce(limited);
    expect(await POST(req())).toBe(limited);
    rateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);
    expect(await POST(req())).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-080 想定外の例外は 500', async () => {
    authenticate.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(req());
    expect(res.status).toBe(500);
  });
});
