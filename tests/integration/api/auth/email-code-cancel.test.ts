/** @jest-environment node */
export {};

// API-AUTH-032 メールのコードの取りやめの窓口。保留の Cookie と戻り先の控えの Cookie を消して 204。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/email-code/cancel/route';

describe('API-AUTH-032 POST /api/auth/email-code/cancel', () => {
  test('API-AUTH-032 Cookie が無くても 204 で、保留と戻り先の Cookie を消し、no-store', async () => {
    const res = await POST(new Request('http://localhost/api/auth/email-code/cancel', { method: 'POST' }));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/sb-email-code-session=;/);
    expect(setCookie).toMatch(/sb-return-intent=;/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
