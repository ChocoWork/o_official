/**
 * DD-AUTH-076 店長の窓口の共通の部品（src/features/auth/staff/staff-invite-http.ts）の単体テスト。
 */

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

import {
  auditStaffAction,
  guardStaffAdminRequest,
  staffInviteReasonResponse,
  type StaffInviteHttpReason,
} from '@/features/auth/staff/staff-invite-http';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const request = () => new Request('https://example.test/api/admin/staff/invites', {
  method: 'POST',
  headers: { 'user-agent': 'jest', 'x-real-ip': '203.0.113.9' },
});
const limit = { endpoint: 'admin:staff:test', limit: 5, windowSeconds: 60 };

describe('staffInviteReasonResponse', () => {
  it.each([
    ['forbidden', 403],
    ['not_found', 404],
    ['last_admin', 409],
    ['self', 403],
    ['already_staff', 409],
    ['not_staff', 409],
    ['config', 503],
    ['revoke_failed', 500],
    ['mail_failed', 502],
    ['failed', 500],
  ] as Array<[StaffInviteHttpReason, number]>)('DD-AUTH-076 %s は %i で、no-store にして、符号を返す', async (reason, status) => {
    const response = staffInviteReasonResponse(reason);

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ code: reason });
  });

  it('DD-AUTH-076 already_staff の本文は、やり直しの入口を案内する', async () => {
    const body = await staffInviteReasonResponse('already_staff').json();
    expect(body.error).toBe('すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください。');
  });

  it('DD-AUTH-076 メール送信の失敗は、もう一度招待を出すよう案内する', async () => {
    const body = await staffInviteReasonResponse('mail_failed').json();
    expect(body.error).toBe('メールを送れませんでした。もう一度、招待を出してください。');
  });
});

describe('guardStaffAdminRequest', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
  });

  it('DD-AUTH-076 権限 → CSRF → IP の枠 → 店長の枠の順で確かめ、通れば操作者を返す', async () => {
    const req = request();

    const guard = await guardStaffAdminRequest(req, limit);

    expect(guard).toEqual({ ok: true, actorId: ACTOR, actorEmail: 'owner@example.com' });
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', req);
    expect(enforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, ...limit });
    expect(enforceRateLimit).toHaveBeenNthCalledWith(2, { request: req, ...limit, subject: ACTOR });
    const order = [authorizeAdminPermission, requireCsrfOrDeny, enforceRateLimit].map(
      (fn) => (fn as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each([401, 403, 503])('DD-AUTH-076 権限の拒否 %i は no-store で返し、CSRF と枠を見ない', async (status) => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('denied', { status }) });

    const guard = await guardStaffAdminRequest(request(), limit);

    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(status);
      expect(guard.response.headers.get('cache-control')).toBe('no-store');
    }
    expect(requireCsrfOrDeny).not.toHaveBeenCalled();
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 CSRF の拒否は、そのまま返し、枠を数えない', async () => {
    (requireCsrfOrDeny as jest.Mock).mockResolvedValue(new Response('csrf', { status: 403 }));

    const guard = await guardStaffAdminRequest(request(), limit);

    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(await guard.response.text()).toBe('csrf');
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it.each(['ip', 'actor'] as const)('DD-AUTH-076 %s の枠を使い切ったら 429 をそのまま返す', async (stage) => {
    const limited = new Response('slow', { status: 429, headers: { 'retry-after': '60' } });
    (enforceRateLimit as jest.Mock)
      .mockResolvedValueOnce(stage === 'ip' ? limited : undefined)
      .mockResolvedValueOnce(stage === 'actor' ? limited : undefined);

    const guard = await guardStaffAdminRequest(request(), limit);

    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(429);
      expect(guard.response.headers.get('retry-after')).toBe('60');
      expect(guard.response.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('auditStaffAction', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('DD-AUTH-076 操作者・対象・IP・ブラウザ・固定の詳細だけを1行書く', async () => {
    await auditStaffAction(request(), { actorId: ACTOR, actorEmail: 'owner@example.com' }, {
      action: 'admin.staff.redo', resourceId: 'target-id', outcome: 'success', detail: 'Staff redo invite sent', metadata: { reason_length: 12 },
    });

    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin.staff.redo',
      actor_id: ACTOR,
      actor_email: 'owner@example.com',
      resource: 'users',
      resource_id: 'target-id',
      outcome: 'success',
      detail: 'Staff redo invite sent',
      ip: '203.0.113.9',
      user_agent: 'jest',
      metadata: { reason_length: 12 },
    });
  });

  it('DD-AUTH-076 監査が例外を投げても呼び手へ伝えない', async () => {
    (logAudit as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(
      auditStaffAction(request(), { actorId: ACTOR, actorEmail: null }, { action: 'a', resourceId: null, outcome: 'failure', detail: 'd' }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[admin.staff] audit failed');
  });
});
