/** @jest-environment node */
/**
 * DD-AUTH-076 店員の招待の窓口（src/app/api/admin/staff/invites/route.ts）の単体テスト。
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
jest.mock('@/features/auth/services/auth-admin-user', () => ({ findAuthUserIdByEmail: jest.fn() }));
jest.mock('@/features/auth/staff/staff-invite-send', () => ({ issueAndSendStaffInvite: jest.fn(), isStaffInviteMailReady: jest.fn() }));

import { POST } from '@/app/api/admin/staff/invites/route';
import { findAuthUserIdByEmail } from '@/features/auth/services/auth-admin-user';
import { isStaffInviteMailReady, issueAndSendStaffInvite } from '@/features/auth/staff/staff-invite-send';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const createUser = jest.fn();
const listPasskeys = jest.fn();
const service = { auth: { admin: { createUser, passkey: { listPasskeys } } } };
const request = (body: unknown = { email: 'New.Staff@Example.com', role: 'admin' }) =>
  new Request('https://example.test/api/admin/staff/invites', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('POST /api/admin/staff/invites', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'not_found' });
    createUser.mockResolvedValue({ data: { user: { id: TARGET } }, error: null });
    listPasskeys.mockResolvedValue({ data: [], error: null });
    (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: true });
    (isStaffInviteMailReady as jest.Mock).mockReturnValue(true);
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('DD-AUTH-076 アカウントが無ければ、パスワード無し・確認済みで作って招待し、{ success: true } だけを返す', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(findAuthUserIdByEmail).toHaveBeenCalledWith(service, 'new.staff@example.com');
    expect(createUser).toHaveBeenCalledWith({ email: 'new.staff@example.com', email_confirm: true });
    expect(issueAndSendStaffInvite).toHaveBeenCalledWith(service, {
      userId: TARGET, email: 'new.staff@example.com', role: 'admin', kind: 'invite', issuedBy: ACTOR, reason: null, hadPasskeys: false,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.staff.invite', resource_id: TARGET, outcome: 'success', actor_id: ACTOR,
    }));
  });

  it('DD-AUTH-076 メールの設定が壊れていたら、アカウントを作らず 503 で断り、監査に残す', async () => {
    (isStaffInviteMailReady as jest.Mock).mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(createUser).not.toHaveBeenCalled();
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.staff.invite', outcome: 'failure', detail: 'mail_config_invalid' }));
  });

  it('DD-AUTH-076 お客さんのアカウントが在っても同じ応答で、作らず、既存の鍵の有無をメールに渡す', async () => {
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'found', userId: TARGET });
    listPasskeys.mockResolvedValue({ data: [{ id: 'k1' }], error: null });

    const response = await POST(request({ email: 'customer@example.com', role: 'supporter' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(createUser).not.toHaveBeenCalled();
    expect(listPasskeys).toHaveBeenCalledWith({ userId: TARGET });
    expect(issueAndSendStaffInvite).toHaveBeenCalledWith(service, expect.objectContaining({ userId: TARGET, role: 'supporter', hadPasskeys: true }));
  });

  it.each([
    ['鍵が0本', { data: [], error: null }, false],
    ['読めない（誤り）', { data: null, error: { message: 'x' } }, true],
  ])('DD-AUTH-076 既存のアカウントの鍵が %s の時の hadPasskeys は %s', async (_label, listed, expected) => {
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'found', userId: TARGET });
    listPasskeys.mockResolvedValue(listed);

    await POST(request());

    expect(issueAndSendStaffInvite).toHaveBeenCalledWith(service, expect.objectContaining({ hadPasskeys: expected }));
  });

  it('DD-AUTH-076 鍵の一覧の呼びが例外でも知らせる側に倒す', async () => {
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'found', userId: TARGET });
    listPasskeys.mockRejectedValue(new Error('network'));

    await POST(request());

    expect(issueAndSendStaffInvite).toHaveBeenCalledWith(service, expect.objectContaining({ hadPasskeys: true }));
  });

  it('DD-AUTH-076 今の有効な店員は 409 already_staff で、本文は「すでに店員です。」で始まる', async () => {
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'found', userId: TARGET });
    (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: false, reason: 'already_staff' });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/^すでに店員です。/);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'conflict', resource_id: TARGET }));
  });

  it('DD-AUTH-076 メールの送りに失敗したら 502 で、もう一度出すよう案内する', async () => {
    (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: false, reason: 'mail_failed' });

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('メールを送れませんでした。もう一度、招待を出してください。');
  });

  it.each([null, {}, { email: 'not-an-email', role: 'admin' }, { email: 'a@example.com', role: 'user' }, { email: 'a@example.com' }])(
    'DD-AUTH-076 不正な本文 %j は 400 で、何も作らない',
    async (body) => {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect(createUser).not.toHaveBeenCalled();
      expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])('DD-AUTH-076 権限が無い（%i）と、何も呼ばない', async (status) => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('denied', { status }) });

    const response = await POST(request());

    expect(response.status).toBe(status);
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 CSRF の拒否は 403 のまま返し、何も呼ばない', async () => {
    (requireCsrfOrDeny as jest.Mock).mockResolvedValue(new Response('csrf', { status: 403 }));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 回数の枠を使い切ったら 429 で、何も呼ばない', async () => {
    (enforceRateLimit as jest.Mock).mockResolvedValue(new Response('slow', { status: 429 }));

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 アカウントを引けない時は 500 で、作らず、招待もしない', async () => {
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'error', message: 'rpc_failed' });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(createUser).not.toHaveBeenCalled();
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 アカウントの作成に失敗したら 500 で、招待しない', async () => {
    createUser.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['利用者が返らない', { data: { user: null }, error: null }],
    ['データが無い', { data: null, error: null }],
  ])('DD-AUTH-076 アカウントの作成で %s 時は 500 で、招待しない', async (_label, created) => {
    createUser.mockResolvedValue(created);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 監査にメールアドレスと合言葉を載せない', async () => {
    await POST(request());

    expect(JSON.stringify((logAudit as jest.Mock).mock.calls)).not.toContain('new.staff@example.com');
  });
});
