/** @jest-environment node */
/**
 * API-AUTH-038 POST /api/auth/staff/register/complete（2本の登録の終わり）の結合テスト。
 * 窓口・招待の部品（activateStaffRole）・理由の写しは本物で、境界（認証・CSRF・回数の枠・DB・GoTrue のセッションの終了）だけを差し替える。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/auth/request-token', () => ({ extractAuthToken: jest.fn().mockReturnValue('tok') }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  checkAuthSessionLiveness: jest.fn().mockResolvedValue('active'),
  authFailureResponse: jest.fn(() => new Response('{}', { status: 401 })),
}));
const revoked: string[] = [];
jest.mock('@/lib/auth/passkey-auth-session-end', () => ({
  endAuthSession: jest.fn(async () => {
    revoked.push('session');
    return true;
  }),
}));
jest.mock('@/lib/auth/revoke-user-sessions', () => ({
  revokeAllSessionsForUser: jest.fn(async (userId: string) => {
    revoked.push(userId);
    return { authSessionsDeleted: 1 };
  }),
}));

import { POST } from '@/app/api/auth/staff/register/complete/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const post = () => POST(new Request('http://localhost/api/auth/staff/register/complete', { method: 'POST' }));

function wire(outcome: { data: unknown; error: { message: string } | null }) {
  const rpc = jest.fn(async () => outcome);
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  return rpc;
}

beforeEach(() => {
  revoked.length = 0;
  (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
  (authenticateRequest as jest.Mock).mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: SESSION_ID } });
});

describe('API-AUTH-038 2本の登録の終わりの窓口', () => {
  test('API-AUTH-038 DB が役割を有効にしたら、全ログインを終わらせ、Cookie を消して /login へ（鍵の ID は載せない）', async () => {
    const rpc = wire({ data: { role: 'admin' }, error: null });
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ redirectTo: '/login' });
    expect(text).not.toMatch(/passkey|credential/i);
    expect(rpc).toHaveBeenCalledWith('staff_role_activate', { p_user_id: USER_ID, p_session_id: SESSION_ID });
    expect(revoked).toEqual(['session', USER_ID]);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/sb-access-token=;/);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  test.each([
    ['STAFF_ACTIVATE_KEYS_SHORT', 409, 'keys_short'],
    ['STAFF_ACTIVATE_KEYS_NOT_WINDOW', 409, 'keys_not_window'],
    ['STAFF_ACTIVATE_NO_WINDOW', 403, 'window_closed'],
    ['STAFF_ACTIVATE_INVITE_INVALID', 403, 'window_closed'],
    ['SOMETHING_ELSE', 500, 'register_complete_failed'],
  ])('API-AUTH-038 DB の %s は %i %s で、ログインは終わらせない', async (message, status, error) => {
    wire({ data: null, error: { message } });
    const res = await post();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(revoked).toEqual([]);
  });
});
