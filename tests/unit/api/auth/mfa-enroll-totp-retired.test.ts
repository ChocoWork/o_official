/**
 * DD-AUTH-083 TOTP の登録の窓口は、店員（`passkey_is_staff`）には 410 `totp_retired` を返す。
 * 認証・アプリの結び付きの確かめの後に返し、お客さんの断り（403）は変えない。
 */
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn((reason: string) => ({ status: 401, json: async () => ({ error: reason }) })),
}));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ isStaff: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createClient } from '@/lib/supabase/server';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { isStaff } from '@/lib/auth/passkey-approval-rpc';
import { logAudit } from '@/lib/audit';
import { POST } from '@/app/api/auth/mfa/enroll-totp/route';

const enroll = jest.fn();
const listFactors = jest.fn();
const staffMock = isStaff as jest.Mock;
const authMock = authenticateRequest as jest.Mock;

function request() {
  return new Request('http://localhost/api/auth/mfa/enroll-totp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
  (createClient as jest.Mock).mockResolvedValue({ auth: { mfa: { listFactors, enroll, unenroll: jest.fn() } } });
  authMock.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: { role: 'admin' }, amr: [{ method: 'otp', timestamp: 0 }] },
  });
  listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
  enroll.mockResolvedValue({
    data: { id: 'f', friendly_name: null, totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'S', uri: 'u' } },
    error: null,
  });
  staffMock.mockResolvedValue({ ok: true, value: false });
});

describe('DD-AUTH-083 店員の TOTP の登録を断る', () => {
  it('DD-AUTH-083 店員には 410 totp_retired を返し、要素の一覧も登録も呼ばず、断りを監査に残す', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });

    const res = await POST(request());

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'totp_retired' });
    expect(staffMock).toHaveBeenCalledWith('user-1');
    expect(listFactors).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({ action: 'mfa_enroll', actor_id: 'user-1', outcome: 'denied', detail: 'totp_retired' });
  });

  it('DD-AUTH-083 店員の判定の DB が使えない時は 503 で閉じる（登録しない）', async () => {
    staffMock.mockResolvedValue({ ok: false });
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(enroll).not.toHaveBeenCalled();
  });

  it('DD-AUTH-083 認証に通らない時は 401 のまま（店員の判定を呼ばない。FR-LOGIN-031 の 401 を変えない）', async () => {
    authMock.mockResolvedValue({ ok: false, reason: 'invalid' });
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(staffMock).not.toHaveBeenCalled();
  });

  it('DD-AUTH-083 お客さん（役割が user）は今までどおり 403 で、店員の判定を呼ばない', async () => {
    authMock.mockResolvedValue({ ok: true, claims: { sub: 'user-2', app_metadata: { role: 'user' }, amr: [] } });
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(staffMock).not.toHaveBeenCalled();
  });

  it('DD-AUTH-083 店員でない管理の役割（判定が偽）は今までどおり登録できる', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(enroll).toHaveBeenCalled();
  });
});
