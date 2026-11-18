/**
 * DD-AUTH-082 店員の一覧・名前・削除の入口が、無操作1時間と24時間を通す（src/lib/auth/passkey-manage-guard.ts）。
 */
jest.mock('next/server', () => {
  class FakeResponse {
    status: number;
    body: unknown;
    headers: Headers;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
  }
  return { NextResponse: FakeResponse };
});
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/http/no-store', () => ({ withNoStore: (r: unknown) => r }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn().mockResolvedValue({}) }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn((reason: string) => ({ status: 401, body: { error: reason } })),
}));
jest.mock('@/lib/auth/request-token', () => ({ extractAuthToken: jest.fn().mockReturnValue('access-token') }));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ isStaff: jest.fn() }));
jest.mock('@/lib/auth/staff-passkey-idle-rpc', () => ({ staffIdleCheck: jest.fn(), staffIdlePeek: jest.fn() }));
jest.mock('@/lib/auth/passkey-auth-session-end', () => ({ endAuthSessionById: jest.fn().mockResolvedValue(true) }));

import { guardPasskeyManage } from '@/lib/auth/passkey-manage-guard';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { isStaff } from '@/lib/auth/passkey-approval-rpc';
import { staffIdleCheck } from '@/lib/auth/staff-passkey-idle-rpc';
import { endAuthSessionById } from '@/lib/auth/passkey-auth-session-end';

const request = { headers: new Headers() } as unknown as Request;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const claimsAt = (passkeyAt: number | null) => ({
  sub: 'user-1',
  session_id: 'session-1',
  amr: passkeyAt === null ? [{ method: 'otp', timestamp: nowSeconds() }] : [{ method: 'passkey', timestamp: passkeyAt }],
});
const statusOf = (response: unknown) => (response as { status: number }).status;
const bodyOf = (response: unknown) => (response as { body: string }).body;

describe('guardPasskeyManage の店員の無操作の確かめ', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (authenticateRequest as jest.Mock).mockResolvedValue({ ok: true, claims: claimsAt(nowSeconds()) });
    (isStaff as jest.Mock).mockResolvedValue({ ok: true, value: true });
    (staffIdleCheck as jest.Mock).mockResolvedValue({ ok: true, value: true });
  });
  afterEach(() => jest.restoreAllMocks());

  it('DD-AUTH-082 お客さんは無操作の確かめを通らずに通る', async () => {
    (isStaff as jest.Mock).mockResolvedValue({ ok: true, value: false });
    const result = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(result.ok).toBe(true);
    expect(staffIdleCheck).not.toHaveBeenCalled();
  });

  it('DD-AUTH-082 店員で1時間以内なら通り、時刻を進める確かめ（staff_idle_check）を呼ぶ', async () => {
    const result = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(result.ok).toBe(true);
    expect(staffIdleCheck).toHaveBeenCalledWith('session-1', 'user-1');
  });

  it('DD-AUTH-082 店員が無操作を過ぎたら 401 session_idle で、そのセッションを終わらせる', async () => {
    (staffIdleCheck as jest.Mock).mockResolvedValue({ ok: true, value: false });
    const result = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(statusOf(result.response)).toBe(401);
      expect(bodyOf(result.response)).toContain('session_idle');
    }
    expect(endAuthSessionById).toHaveBeenCalledWith('session-1');
  });

  it('DD-AUTH-082 店員でパスキーのログインから24時間を過ぎていたら 401（終わらせる）', async () => {
    (authenticateRequest as jest.Mock).mockResolvedValue({ ok: true, claims: claimsAt(nowSeconds() - 25 * 3600) });
    const result = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(statusOf(result.response)).toBe(401);
    expect(endAuthSessionById).toHaveBeenCalledWith('session-1');
  });

  it('DD-AUTH-082 パスキーの印が無い店員（招待の窓の中のセッション）は24時間の確かめの対象にしない', async () => {
    (authenticateRequest as jest.Mock).mockResolvedValue({ ok: true, claims: claimsAt(null) });
    const result = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(result.ok).toBe(true);
  });

  it('DD-AUTH-082 店員の通行証に session_id が無ければ 401（無操作を確かめられないので通さない）', async () => {
    (authenticateRequest as jest.Mock).mockResolvedValue({ ok: true, claims: { sub: 'user-1', amr: [] } });
    const result = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(statusOf(result.response)).toBe(401);
    expect(staffIdleCheck).not.toHaveBeenCalled();
  });

  it('DD-AUTH-082 確かめの失敗（RPC・店員かの判定）は 503 で、終わらせない', async () => {
    (staffIdleCheck as jest.Mock).mockResolvedValue({ ok: false });
    const failed = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(statusOf(failed.response)).toBe(503);

    (isStaff as jest.Mock).mockResolvedValue({ ok: false });
    const unknown = await guardPasskeyManage(request, { endpoint: 'x', csrf: false });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(statusOf(unknown.response)).toBe(503);
    expect(endAuthSessionById).not.toHaveBeenCalled();
  });
});
