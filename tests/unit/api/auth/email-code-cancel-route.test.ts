/** @jest-environment node */
/**
 * DD-AUTH-059 メールのコードの取りやめの窓口（src/app/api/auth/email-code/cancel/route.ts）の単体テスト。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/email-code/cancel/route';
import { logAudit } from '@/lib/audit';
import { createEmailCodeSessionToken } from '@/features/auth/services/email-code-session';

const audit = logAudit as jest.Mock;
const ORIGINAL_ENV = { ...process.env };

function req(cookie?: string) {
  return new Request('http://localhost/api/auth/email-code/cancel', { method: 'POST', headers: cookie ? { cookie } : {} });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '' };
  audit.mockClear();
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('DD-AUTH-059 POST /api/auth/email-code/cancel', () => {
  test('DD-AUTH-059 204 で保留の Cookie と戻り先の控えを消し、no-store。実際に捨てた時だけ監査に残す', async () => {
    const cookie = `sb-email-code-session=${encodeURIComponent(createEmailCodeSessionToken({ email: 'a@example.com' }))}`;
    const res = await POST(req(cookie));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/sb-email-code-session=;/);
    expect(setCookie).toMatch(/sb-return-intent=;/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.email_code.cancel', outcome: 'cancelled' }));
  });

  test('DD-AUTH-059 Cookie が無くても 204。監査には書かない', async () => {
    const res = await POST(req());
    expect(res.status).toBe(204);
    expect(audit).not.toHaveBeenCalled();
  });
});
