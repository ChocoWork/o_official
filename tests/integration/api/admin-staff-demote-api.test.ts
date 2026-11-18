/** @jest-environment node */
/**
 * API-AUTH-035 POST /api/admin/staff/[id]/demote（店員をお客さんに戻す）の結合テスト。
 * 窓口・DB を呼ぶ部品は本物で、境界だけを差し替える。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/revoke-user-sessions', () => ({ revokeAllSessionsForUser: jest.fn() }));

import { POST } from '@/app/api/admin/staff/[id]/demote/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const rpc = jest.fn();
const service = { rpc };
const post = (id: string = TARGET) =>
  POST(new Request(`http://localhost:3000/api/admin/staff/${id}/demote`, { method: 'POST' }), { params: Promise.resolve({ id }) });

describe('API-AUTH-035 店員をお客さんに戻す', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    rpc.mockResolvedValue({ data: null, error: null });
    (revokeAllSessionsForUser as jest.Mock).mockResolvedValue({ authSessionsDeleted: 1 });
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('API-AUTH-035 staff_demote だけを呼び（admin_set_user_role は呼ばない）、その人のログインを全部終わらせる', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('staff_demote', { p_actor_id: ACTOR, p_user_id: TARGET });
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
  });

  it.each([
    ['LAST_ADMIN_REQUIRED', 409],
    ['SELF_ROLE_CHANGE_FORBIDDEN', 403],
    ['ROLE_PERMISSION_FORBIDDEN', 403],
    ['USER_NOT_FOUND', 404],
  ])('API-AUTH-035 DB が %s で断ると %i で、ログインは終わらせない', async (message, status) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const response = await post();

    expect(response.status).toBe(status);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('API-AUTH-035 DB の知らない失敗は 500 で、内部の文を返さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'duplicate key value violates "secret_detail"', code: '23505' } });

    const response = await post();

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret_detail');
  });

  it('API-AUTH-035 権限が無ければ 403 で、DB を呼ばない', async () => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('{}', { status: 403 }) });

    expect((await post()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
