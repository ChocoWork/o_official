/** @jest-environment node */
/**
 * API-AUTH-036 POST /api/admin/staff/[id]/invite/cancel（招待の取り消し）の結合テスト。
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

import { POST } from '@/app/api/admin/staff/[id]/invite/cancel/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const rpc = jest.fn();
const service = { rpc };
const post = (id: string = TARGET) =>
  POST(new Request(`http://localhost:3000/api/admin/staff/${id}/invite/cancel`, { method: 'POST' }), { params: Promise.resolve({ id }) });

describe('API-AUTH-036 招待の取り消し', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    rpc.mockResolvedValue({ data: true, error: null });
    (revokeAllSessionsForUser as jest.Mock).mockResolvedValue({ authSessionsDeleted: 0 });
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('API-AUTH-036 staff_invite_cancel を操作者と対象で呼び、招待のセッションも終わらせる', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('staff_invite_cancel', { p_actor_id: ACTOR, p_user_id: TARGET });
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
  });

  it('API-AUTH-036 取り消す招待が無ければ（DB が false）、200 の cancelled: false で、ログインは終わらせない', async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, cancelled: false });
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('API-AUTH-036 操作者が今の店長でなければ DB が断り 403、ログインは終わらせない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'ROLE_PERMISSION_FORBIDDEN', code: '42501' } });

    const response = await post();

    expect(response.status).toBe(403);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('API-AUTH-036 DB の知らない失敗は 500 で、内部の文を返さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'secret_detail', code: 'XX000' } });

    const response = await post();

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret_detail');
  });

  it('API-AUTH-036 権限が無ければ 403 で、DB を呼ばない', async () => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('{}', { status: 403 }) });

    expect((await post()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
