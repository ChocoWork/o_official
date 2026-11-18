/** @jest-environment node */
/**
 * API-AUTH-033 POST /api/admin/staff/invites（店員の招待）の結合テスト。
 * 窓口・共通の流れ・DB を呼ぶ部品は本物で、境界（権限・CSRF・回数・監査・Supabase・メールの送り手）だけを差し替える。
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
jest.mock('@/lib/auth/revoke-user-sessions', () => ({ revokeAllSessionsForUser: jest.fn() }));
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  checkOrderEmailSendConfig: jest.fn(() => null),
  sendOrderEmailMessage: jest.fn(),
}));

import { createHash } from 'node:crypto';
import { POST } from '@/app/api/admin/staff/invites/route';
import { findAuthUserIdByEmail } from '@/features/auth/services/auth-admin-user';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';
import { checkOrderEmailSendConfig, sendOrderEmailMessage } from '@/lib/orders/email/order-email-sender';
import { createServiceRoleClient } from '@/lib/supabase/server';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';
const SITE = 'https://configured.example';

const rpc = jest.fn();
const createUser = jest.fn();
const listPasskeys = jest.fn();
const service = { rpc, auth: { admin: { createUser, passkey: { listPasskeys } } } };
const send = sendOrderEmailMessage as jest.Mock;

const post = (headers: Record<string, string> = {}, body: unknown = { email: 'staff@example.com', role: 'admin' }) =>
  POST(new Request('http://localhost:3000/api/admin/staff/invites', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  }));

describe('API-AUTH-033 店員の招待', () => {
  const saved = { ...process.env };
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    delete process.env.VERCEL_ENV;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, actorEmail: 'owner@example.com' });
    (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'not_found' });
    createUser.mockResolvedValue({ data: { user: { id: TARGET } }, error: null });
    listPasskeys.mockResolvedValue({ data: [], error: null });
    rpc.mockResolvedValue({ data: INVITE_ID, error: null });
    (revokeAllSessionsForUser as jest.Mock).mockResolvedValue({ authSessionsDeleted: 0 });
    send.mockResolvedValue({ ok: true, providerMessageId: null });
    (checkOrderEmailSendConfig as jest.Mock).mockReturnValue(null);
    (logAudit as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.env = { ...saved };
  });

  it('API-AUTH-033 新しい店員への招待は、メールが1通だけで、リンクは /staff/invite#合言葉、DB には合言葉の SHA-256 が \\x 形の bytea で渡る', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.to).toBe('staff@example.com');
    const token = new RegExp(`${SITE.replace(/\./g, '\\.')}/staff/invite#([A-Za-z0-9_-]{43})`).exec(message.text)?.[1];
    expect(token).toBeDefined();
    expect(message.text).not.toContain('?token=');
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe('staff_invite_issue');
    expect(args.p_token_hash).toBe(`\\x${createHash('sha256').update(token as string, 'utf8').digest('hex')}`);
    expect(args).toMatchObject({ p_user_id: TARGET, p_role_code: 'admin', p_kind: 'invite', p_issued_by: ACTOR });
    expect(JSON.stringify((logAudit as jest.Mock).mock.calls)).not.toContain(token as string);
  });

  it.each([
    ['Host を偽る', { host: 'evil.example' }],
    ['Origin を偽る', { origin: 'https://evil.example' }],
    ['Referer と x-forwarded-host を偽る', { referer: 'https://evil.example/x', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }],
  ])('API-AUTH-033 要求の %s と、メールのリンクの元は設定したサイトの住所のままで変わらない', async (_label, headers) => {
    await post(headers);

    const text: string = send.mock.calls[0][0].text;
    expect(text).toContain(`${SITE}/staff/invite#`);
    expect(text).not.toContain('evil.example');
  });

  it('API-AUTH-033 お客さんのアカウントが在る場合と無い場合で、応答の本文・状態は同じ', async () => {
    const fresh = await post();
    const freshBody = await fresh.json();
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'found', userId: TARGET });
    const existing = await post();

    expect(existing.status).toBe(fresh.status);
    expect(await existing.json()).toEqual(freshBody);
  });

  it('API-AUTH-033 パスキーを持っていた既存のお客さんには、メールの冒頭で削除を知らせる', async () => {
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'found', userId: TARGET });
    listPasskeys.mockResolvedValue({ data: [{ id: 'k1' }], error: null });

    await post();

    expect(send.mock.calls[0][0].text.startsWith('これまでのパスキーはすべて削除されました。')).toBe(true);
  });

  it('API-AUTH-033 今の有効な店員は 409 already_staff で、ログインを終わらせず、メールも送らない', async () => {
    (findAuthUserIdByEmail as jest.Mock).mockResolvedValue({ status: 'found', userId: TARGET });
    rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_ALREADY_STAFF', code: 'P0001' } });

    const response = await post();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/^すでに店員です。やり直しは/);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('API-AUTH-033 発行の後に古いログインを終わらせ、メールはその後に送る', async () => {
    await post();

    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
    expect((revokeAllSessionsForUser as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it('API-AUTH-033 メールを送れなければ 502 で、行は消さず、もう一度出すよう案内する', async () => {
    send.mockResolvedValue({ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null } });

    const response = await post();

    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('メールを送れませんでした。もう一度、招待を出してください。');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('API-AUTH-033 サイトの住所が本番で使えない設定なら、鍵を消す前に 503 で断る', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';

    const response = await post();

    expect(response.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('API-AUTH-033 権限が無ければ 403 で何も触らない', async () => {
    (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('{}', { status: 403 }) });

    const response = await post();

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
