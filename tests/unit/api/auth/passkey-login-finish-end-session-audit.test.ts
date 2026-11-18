/** @jest-environment node */
/**
 * DD-AUTH-083 パスキーのログインの終わりで、GoTrue のセッションを終わらせる呼び出し（`endAuthSession`）が失敗した時に、
 * 監査へ固定の符号だけを残し、応答は変えない（1b の M-2）。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ isStaff: jest.fn(), isCredentialApproved: jest.fn() }));
jest.mock('@/lib/auth/staff-passkey-idle-rpc', () => ({ staffSessionTouch: jest.fn().mockResolvedValue({ ok: true, value: true }) }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/features/cart/services/guest-shopping-token', () => ({ readGuestShoppingTokens: jest.fn(() => ({})) }));
jest.mock('@/lib/orders/link-guest-orders', () => ({ linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  issueReturnIntent: jest.fn(),
  applyReturnIntentCookie: jest.fn(),
}));

import { POST } from '@/app/api/auth/passkey/login/finish/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isCredentialApproved, isStaff } from '@/lib/auth/passkey-approval-rpc';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { logAudit } from '@/lib/audit';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS_TOKEN = `h.${Buffer.from(JSON.stringify({ session_id: SESSION_ID })).toString('base64url')}.s`;
const END_ACTION = 'auth.passkey.login.end_session_failed';

const audit = logAudit as jest.Mock;
const staffMock = isStaff as jest.Mock;
const approvedMock = isCredentialApproved as jest.Mock;
let rpc: jest.Mock;
let verify: jest.Mock;

function authData(flags: number): string {
  const bytes = Buffer.alloc(37);
  bytes[32] = flags;
  return bytes.toString('base64url');
}

function req() {
  return new Request('http://localhost/api/auth/passkey/login/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge_id: CHALLENGE_ID,
      credential: {
        id: 'AAECAw',
        rawId: 'AAECAw',
        type: 'public-key',
        response: { clientDataJSON: 'eyJ4IjoxfQ', authenticatorData: authData(0x05), signature: 'c2ln' },
      },
    }),
  });
}

function endAudits() {
  return audit.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((c) => c.action === END_ACTION);
}

beforeEach(() => {
  jest.clearAllMocks();
  (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
  verify = jest.fn().mockResolvedValue({
    data: {
      session: { access_token: ACCESS_TOKEN, refresh_token: 'r' },
      user: { id: USER_ID, email: 'a@example.com', app_metadata: {} },
    },
    error: null,
  });
  (createPublicClient as jest.Mock).mockResolvedValue({ auth: { passkey: { verifyAuthentication: verify } } });
  rpc = jest.fn().mockResolvedValue({ error: { code: 'x' } });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  staffMock.mockResolvedValue({ ok: true, value: true });
  approvedMock.mockResolvedValue({ ok: true, value: false });
  (persistSessionAndCookies as jest.Mock).mockResolvedValue({ ok: true });
});

describe('DD-AUTH-083 endAuthSession の失敗の監査（1b M-2）', () => {
  test('DD-AUTH-083 認めていない鍵でセッションを終わらせるのに失敗したら、固定の符号だけを監査に残し、応答は 403 のまま', async () => {
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'passkey_not_approved' });
    expect(endAudits()).toEqual([
      { action: END_ACTION, outcome: 'error', detail: 'revoke_failed:passkey_not_approved', actor_id: USER_ID },
    ]);
  });

  test('DD-AUTH-083 店員の判定の DB が落ちた時の終わらせる失敗も残し、応答は 503 のまま', async () => {
    staffMock.mockResolvedValue({ ok: false });
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(endAudits()).toEqual([
      { action: END_ACTION, outcome: 'error', detail: 'revoke_failed:staff_check_unavailable', actor_id: USER_ID },
    ]);
  });

  test('DD-AUTH-083 利用者が読めない応答でセッションを終わらせるのに失敗したら、利用者なしで符号だけを残し、応答は 401 のまま', async () => {
    verify.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN, refresh_token: 'r' }, user: {} }, error: null });
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(endAudits()).toEqual([{ action: END_ACTION, outcome: 'error', detail: 'revoke_failed:gotrue_bad_response' }]);
  });

  test('DD-AUTH-083 終わらせるのに成功したら、この監査は残さない', async () => {
    rpc.mockResolvedValue({ error: null });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(endAudits()).toEqual([]);
  });

  test('DD-AUTH-083 監査にトークン・session_id・利用者のメールを残さない', async () => {
    await POST(req());
    const text = JSON.stringify(endAudits());
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(SESSION_ID);
    expect(text).not.toContain('a@example.com');
  });
});
