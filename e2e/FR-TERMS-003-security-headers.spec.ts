import { expect, test } from '@playwright/test';

test.describe('FR-TERMS-003 security headers', () => {
  test('/terms に共通セキュリティヘッダーを付与する', async ({ request }) => {
    const response = await request.get('/terms');

    expect(response.status()).toBe(200);

    const headers = response.headers();
    const csp = headers['content-security-policy'];

    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);

    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toContain('max-age=63072000');
    expect(headers['x-nonce']).toMatch(/^[0-9a-f]{24}$/);
  });
});