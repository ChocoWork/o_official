/** @jest-environment node */
/**
 * DD-AUTH-077 店員の招待を取り消す窓口（src/app/api/admin/staff/[id]/invite/cancel/route.ts）の単体テスト。
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
jest.mock('@/features/auth/staff/staff-invite-store', () => ({ cancelStaffInvite: jest.fn() }));

import { POST } from '@/app/api/admin/staff/[id]/invite/cancel/route';
import { cancelStaffInvite } from '@/features/auth/staff/staff-invite-store';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const service = { rpc: jest.fn() };
const request = () => new Request(`https://example.test/api/admin/staff/${TARGET}/invite/cancel`, { method: 'POST' });
const context = (id: string = TARGET) => ({ params: Promise.resolve({ id }) });

describe('POST /api/admin/staff/[id]/invite/cancel', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    (cancelStaffInvite as jest.Mock).mockResolvedValue({ ok: true, value: { cancelled: true } });
    (revokeAllSessionsForUser as jest.Mock).mockResolvedValue({ authSessionsDeleted: 0 });
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('DD-AUTH-077 招待を取り消してから、招待のセッションも終わらせる', async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, cancelled: true });
    expect(cancelStaffInvite).toHaveBeenCalledWith(service, ACTOR, TARGET);
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
    expect((cancelStaffInvite as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((revokeAllSessionsForUser as jest.Mock).mock.invocationCallOrder[0]);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.staff.invite_cancel', resource_id: TARGET, outcome: 'success' }));
  });

  it('DD-AUTH-091 取り消す物が無い時は、ログインを終わらせず 200 の cancelled: false で、監査は noop', async () => {
    (cancelStaffInvite as jest.Mock).mockResolvedValue({ ok: true, value: { cancelled: false } });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, cancelled: false });
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.staff.invite_cancel', resource_id: TARGET, outcome: 'noop' }));
  });

  it.each([
    ['forbidden', 403],
    ['failed', 500],
  ] as const)('DD-AUTH-077 取り消しの理由 %s は %i で、ログインを終わらせない', async (reason, status) => {
    (cancelStaffInvite as jest.Mock).mockResolvedValue({ ok: false, reason });

    const response = await POST(request(), context());

    expect(response.status).toBe(status);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('DD-AUTH-077 ログインの終了に失敗したら 500', async () => {
    (revokeAllSessionsForUser as jest.Mock).mockRejectedValue(new Error('x'));

    const response = await POST(request(), context());

    expect(response.status).toBe(500);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('DD-AUTH-077 id が UUID でなければ 400', async () => {
    expect((await POST(request(), context('x'))).status).toBe(400);
    expect(cancelStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-077 権限・CSRF・回数の枠のどれかで止まれば、取り消さない', async () => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValueOnce({ ok: false, response: new Response('d', { status: 401 }) });
    expect((await POST(request(), context())).status).toBe(401);
    (requireCsrfOrDeny as jest.Mock).mockResolvedValueOnce(new Response('c', { status: 403 }));
    expect((await POST(request(), context())).status).toBe(403);
    (enforceRateLimit as jest.Mock).mockResolvedValueOnce(new Response('s', { status: 429 }));
    expect((await POST(request(), context())).status).toBe(429);

    expect(cancelStaffInvite).not.toHaveBeenCalled();
  });
});
