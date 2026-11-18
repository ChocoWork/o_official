/** @jest-environment node */
/**
 * DD-AUTH-076 店員のパスキーをやり直させる窓口（src/app/api/admin/staff/[id]/redo/route.ts）の単体テスト。
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
jest.mock('@/features/auth/staff/staff-invite-send', () => ({ issueAndSendStaffInvite: jest.fn() }));

import { POST } from '@/app/api/admin/staff/[id]/redo/route';
import { issueAndSendStaffInvite } from '@/features/auth/staff/staff-invite-send';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const REASON = '端末を紛失したため、やり直します';
const getUserById = jest.fn();
const or = jest.fn();
const eq = jest.fn();
const select = jest.fn();
const from = jest.fn();
const service = { auth: { admin: { getUserById } }, from };
const request = (body: unknown = { confirm: 'やり直し', reason: REASON }) =>
  new Request(`https://example.test/api/admin/staff/${TARGET}/redo`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
const context = (id: string = TARGET) => ({ params: Promise.resolve({ id }) });

describe('POST /api/admin/staff/[id]/redo', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: 'staff@example.com' } }, error: null });
    from.mockReturnValue({ select });
    select.mockReturnValue({ eq });
    eq.mockReturnValue({ eq, or });
    or.mockResolvedValue({ data: [{ roles: { code: 'supporter' } }], error: null });
    (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: true });
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('DD-AUTH-076 今の役割を発行の前に読み、redo で発行して { success: true } を返す（理由は DB に渡し、監査には長さだけ）', async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(issueAndSendStaffInvite).toHaveBeenCalledWith(service, {
      userId: TARGET, email: 'staff@example.com', role: 'supporter', kind: 'redo', issuedBy: ACTOR, reason: REASON, hadPasskeys: true,
    });
    const audit = (logAudit as jest.Mock).mock.calls[0][0];
    expect(audit).toMatchObject({ action: 'admin.staff.redo', resource_id: TARGET, outcome: 'success', metadata: { reason_length: REASON.length } });
    expect(JSON.stringify(audit)).not.toContain(REASON);
    expect(JSON.stringify(audit)).not.toContain('staff@example.com');
  });

  it('DD-AUTH-076 店長と supporter の両方を持つ人は、店長として発行する', async () => {
    or.mockResolvedValue({ data: [{ roles: { code: 'supporter' } }, { roles: [{ code: 'admin' }] }], error: null });

    await POST(request(), context());

    expect(issueAndSendStaffInvite).toHaveBeenCalledWith(service, expect.objectContaining({ role: 'admin' }));
  });

  it.each([
    ['確認の語が違う', { confirm: 'RESET_MFA', reason: REASON }],
    ['確認の語が無い', { reason: REASON }],
    ['理由が9字', { confirm: 'やり直し', reason: '123456789' }],
    ['理由が501字', { confirm: 'やり直し', reason: 'あ'.repeat(501) }],
    ['本文が空', {}],
  ])('DD-AUTH-076 %s は 400 で、発行しない', async (_label, body) => {
    const response = await POST(request(body), context());

    expect(response.status).toBe(400);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 理由が10字ちょうどと500字ちょうどは通る', async () => {
    expect((await POST(request({ confirm: 'やり直し', reason: '1234567890' }), context())).status).toBe(200);
    expect((await POST(request({ confirm: 'やり直し', reason: 'あ'.repeat(500) }), context())).status).toBe(200);
  });

  it('DD-AUTH-076 id が UUID でなければ 400', async () => {
    const response = await POST(request(), context('not-a-uuid'));

    expect(response.status).toBe(400);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 自分自身は 403 self で、DB を呼ばない', async () => {
    const response = await POST(request(), context(ACTOR));

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('self');
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 最後の店長は 409 last_admin', async () => {
    (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: false, reason: 'last_admin' });

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('last_admin');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'conflict' }));
  });

  it('DD-AUTH-076 読んだ後に降格が先に通り、DB が店員でないと断った時も 409 not_staff', async () => {
    (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: false, reason: 'not_staff' });

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not_staff');
  });

  it.each([
    ['役割が無い（お客さん）', { data: [], error: null }],
    ['役割の行が admin でも supporter でもない', { data: [{ roles: { code: 'user' } }], error: null }],
  ])('DD-AUTH-076 %s人は 409 not_staff で、発行を呼ばない', async (_label, roles) => {
    or.mockResolvedValue(roles);

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not_staff');
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 役割を読めなければ 500 で、発行しない', async () => {
    or.mockResolvedValue({ data: null, error: { code: 'XX000' } });

    const response = await POST(request(), context());

    expect(response.status).toBe(500);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 対象のアカウントが無ければ 404', async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'not found' } });

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 役割の行の形が崩れていても、店員とは見なさず 409 not_staff にする', async () => {
    or.mockResolvedValue({
      data: [null, { roles: null }, { roles: [] }, { roles: [{}] }, { roles: { code: 5 } }],
      error: null,
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not_staff');
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 役割の読みが行の一覧を返さなければ、店員とは見なさず 409 not_staff にする', async () => {
    or.mockResolvedValue({ data: null, error: null });

    expect((await POST(request(), context())).status).toBe(409);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 対象の読みが誤りだけを返して利用者が無くても 404', async () => {
    getUserById.mockResolvedValue({ data: null, error: { message: 'gone' } });

    expect((await POST(request(), context())).status).toBe(404);
  });

  it('DD-AUTH-076 誤りが無くても利用者が返らなければ 404', async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(request(), context())).status).toBe(404);
    getUserById.mockResolvedValue({ data: null, error: null });
    expect((await POST(request(), context())).status).toBe(404);
  });

  it('DD-AUTH-076 アカウントにメールが無ければ店員とは見なさず 409 not_staff にする', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: undefined } }, error: null });

    expect((await POST(request(), context())).status).toBe(409);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 メールの送りに失敗したら 502 で、行は残す（再発行を促す）', async () => {
    (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: false, reason: 'mail_failed' });

    const response = await POST(request(), context());

    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('メールを送れませんでした。もう一度、招待を出してください。');
  });

  it('DD-AUTH-076 権限・CSRF・回数の枠のどれかで止まれば、何も読まない', async () => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValueOnce({ ok: false, response: new Response('d', { status: 403 }) });
    expect((await POST(request(), context())).status).toBe(403);

    (requireCsrfOrDeny as jest.Mock).mockResolvedValueOnce(new Response('c', { status: 403 }));
    expect((await POST(request(), context())).status).toBe(403);

    (enforceRateLimit as jest.Mock).mockResolvedValueOnce(new Response('s', { status: 429 }));
    expect((await POST(request(), context())).status).toBe(429);

    expect(getUserById).not.toHaveBeenCalled();
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });
});
