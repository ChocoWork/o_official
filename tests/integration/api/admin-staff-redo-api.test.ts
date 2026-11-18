/** @jest-environment node */
/**
 * API-AUTH-034 POST /api/admin/staff/[id]/redo（パスキーを全部消してやり直す）の結合テスト。
 * 窓口・共通の流れ・DB を呼ぶ部品は本物で、境界だけを差し替える。
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
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  checkOrderEmailSendConfig: jest.fn(() => null),
  sendOrderEmailMessage: jest.fn(),
}));

import { POST } from '@/app/api/admin/staff/[id]/redo/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';
import { checkOrderEmailSendConfig, sendOrderEmailMessage } from '@/lib/orders/email/order-email-sender';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';
const SITE = 'https://configured.example';
const REASON = '端末を紛失したため、やり直します';

const rpc = jest.fn();
const getUserById = jest.fn();
const or = jest.fn();
const eq = jest.fn();
const select = jest.fn();
const from = jest.fn();
const service = { rpc, from, auth: { admin: { getUserById } } };
const send = sendOrderEmailMessage as jest.Mock;

const post = (body: unknown = { confirm: 'やり直し', reason: REASON }, id: string = TARGET) =>
  POST(
    new Request(`http://localhost:3000/api/admin/staff/${id}/redo`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );

describe('API-AUTH-034 店員のパスキーを全部消してやり直す', () => {
  const saved = { ...process.env };
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    delete process.env.VERCEL_ENV;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: 'staff@example.com' } }, error: null });
    from.mockReturnValue({ select });
    select.mockReturnValue({ eq });
    eq.mockReturnValue({ eq, or });
    or.mockResolvedValue({ data: [{ roles: { code: 'supporter' } }], error: null });
    rpc.mockResolvedValue({ data: INVITE_ID, error: null });
    (revokeAllSessionsForUser as jest.Mock).mockResolvedValue({ authSessionsDeleted: 2 });
    send.mockResolvedValue({ ok: true, providerMessageId: null });
    (checkOrderEmailSendConfig as jest.Mock).mockReturnValue(null);
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.env = { ...saved };
  });

  it('API-AUTH-034 成功すると redo の発行・ログインの終了・メール1通が、その順で行われ、メールの冒頭に削除の知らせが入る', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_kind: 'redo', p_role_code: 'supporter', p_issued_by: ACTOR, p_user_id: TARGET, p_reason: REASON });
    expect(send).toHaveBeenCalledTimes(1);
    const text: string = send.mock.calls[0][0].text;
    expect(text.startsWith('これまでのパスキーはすべて削除されました。')).toBe(true);
    expect(text).toContain('サポーターとして');
    expect(text).toContain(`${SITE}/staff/invite#`);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan((revokeAllSessionsForUser as jest.Mock).mock.invocationCallOrder[0]);
    expect((revokeAllSessionsForUser as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it.each([
    ['確認の語が違う', { confirm: 'RESET_MFA', reason: REASON }],
    ['理由が9字', { confirm: 'やり直し', reason: '123456789' }],
  ])('API-AUTH-034 %sと 400 で、DB を呼ばない', async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('API-AUTH-034 自分自身は 403 で、DB を呼ばない', async () => {
    const response = await post(undefined, ACTOR);

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('API-AUTH-034 最後の店長は DB が断り、409 になる。ログインは終わらせず、メールも送らない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'LAST_ADMIN_REQUIRED', code: 'P0001' } });

    const response = await post();

    expect(response.status).toBe(409);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('API-AUTH-034 店員でない人は 409 not_staff で、DB の発行を呼ばない', async () => {
    or.mockResolvedValue({ data: [], error: null });

    const response = await post();

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not_staff');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('API-AUTH-034 メールを送れなければ 502 で、もう一度出すよう案内する', async () => {
    send.mockResolvedValue({ ok: false, failure: { category: 'permanent', code: 'invalid_recipient', retryAfterSeconds: null } });

    const response = await post();

    expect(response.status).toBe(502);
  });

  it('API-AUTH-034 監査に理由の本文もメールも合言葉も載せない', async () => {
    await post();

    const logged = JSON.stringify((logAudit as jest.Mock).mock.calls);
    expect(logged).not.toContain(REASON);
    expect(logged).not.toContain('staff@example.com');
    expect(logged).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
