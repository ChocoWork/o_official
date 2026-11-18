/** @jest-environment node */
/**
 * DD-AUTH-079 guardPasskeyRegistration の招待の窓の枝（src/lib/auth/passkey-registration-guard.ts）の単体テスト。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
  authFailureResponse: () => new Response('{}', { status: 401 }),
}));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({
  isStaff: jest.fn(),
  hasOpenInvite: jest.fn(),
  windowIsOpen: jest.fn(),
  approvedCount: jest.fn(),
}));

import { guardPasskeyRegistration } from '@/lib/auth/passkey-registration-guard';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { authenticateRequest, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { approvedCount, hasOpenInvite, isStaff, windowIsOpen } from '@/lib/auth/passkey-approval-rpc';

const m = (fn: unknown) => fn as jest.Mock;
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const run = () =>
  guardPasskeyRegistration(new Request('http://localhost/x', { method: 'POST', headers: { authorization: 'Bearer t' } }), {
    auditAction: 'a',
    endpoint: 'e',
  });

beforeEach(() => {
  jest.clearAllMocks();
  m(enforceRateLimit).mockResolvedValue(null);
  m(requireCsrfOrDeny).mockResolvedValue(undefined);
  m(checkAuthSessionLiveness).mockResolvedValue('active');
  m(isStaff).mockResolvedValue({ ok: true, value: false });
  m(hasOpenInvite).mockResolvedValue({ ok: true, value: true });
  m(windowIsOpen).mockResolvedValue({ ok: true, value: true });
  m(approvedCount).mockResolvedValue({ ok: true, value: 1 });
  m(authenticateRequest).mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: SESSION_ID, amr: [] } });
});

describe('DD-AUTH-079 guardPasskeyRegistration（招待の窓）', () => {
  test('DD-AUTH-079 役割が無く窓が開いた人は mode window・isStaff 偽', async () => {
    expect(await run()).toMatchObject({ ok: true, userId: USER_ID, isStaff: false, mode: 'window' });
  });

  test('DD-AUTH-079 窓が閉じていれば 403 で、お客さんの道に落ちない', async () => {
    m(windowIsOpen).mockResolvedValue({ ok: true, value: false });
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  test('DD-AUTH-079 窓・本数が読めなければ 503', async () => {
    m(approvedCount).mockResolvedValue({ ok: false });
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });
});
