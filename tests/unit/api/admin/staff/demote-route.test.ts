/** @jest-environment node */
/**
 * DD-AUTH-077 店員をお客さんに戻す窓口（src/app/api/admin/staff/[id]/demote/route.ts）の単体テスト。
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
jest.mock('@/features/auth/staff/staff-invite-store', () => ({ demoteStaff: jest.fn() }));

import { POST } from '@/app/api/admin/staff/[id]/demote/route';
import { demoteStaff } from '@/features/auth/staff/staff-invite-store';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const service = { rpc: jest.fn() };
const request = () => new Request(`https://example.test/api/admin/staff/${TARGET}/demote`, { method: 'POST' });
const context = (id: string = TARGET) => ({ params: Promise.resolve({ id }) });

describe('POST /api/admin/staff/[id]/demote', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    (demoteStaff as jest.Mock).mockResolvedValue({ ok: true, value: undefined });
    (revokeAllSessionsForUser as jest.Mock).mockResolvedValue({ authSessionsDeleted: 1 });
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('DD-AUTH-077 staff_demote（招待も取り消す道）で降格し、その後にログインを全部終わらせる', async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(demoteStaff).toHaveBeenCalledWith(service, ACTOR, TARGET);
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
    expect((demoteStaff as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((revokeAllSessionsForUser as jest.Mock).mock.invocationCallOrder[0]);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.staff.demote', resource_id: TARGET, outcome: 'success' }));
  });

  it.each([
    ['forbidden', 403],
    ['not_found', 404],
    ['last_admin', 409],
    ['self', 403],
    ['failed', 500],
  ] as const)('DD-AUTH-077 降格の理由 %s は %i で、ログインを終わらせない', async (reason, status) => {
    (demoteStaff as jest.Mock).mockResolvedValue({ ok: false, reason });

    const response = await POST(request(), context());

    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(reason);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('DD-AUTH-077 ログインの終了に失敗したら 500 で、監査に error を残す', async () => {
    (revokeAllSessionsForUser as jest.Mock).mockRejectedValue(new Error('auth_session_revocation_failed'));

    const response = await POST(request(), context());

    expect(response.status).toBe(500);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'session_revocation_failed' }));
  });

  it('DD-AUTH-077 id が UUID でなければ 400 で、降格を呼ばない', async () => {
    const response = await POST(request(), context('x'));

    expect(response.status).toBe(400);
    expect(demoteStaff).not.toHaveBeenCalled();
  });

  it('DD-AUTH-077 権限・CSRF・回数の枠のどれかで止まれば、降格を呼ばない', async () => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValueOnce({ ok: false, response: new Response('d', { status: 403 }) });
    expect((await POST(request(), context())).status).toBe(403);
    (requireCsrfOrDeny as jest.Mock).mockResolvedValueOnce(new Response('c', { status: 403 }));
    expect((await POST(request(), context())).status).toBe(403);
    (enforceRateLimit as jest.Mock).mockResolvedValueOnce(new Response('s', { status: 429 }));
    expect((await POST(request(), context())).status).toBe(429);

    expect(demoteStaff).not.toHaveBeenCalled();
  });
});
