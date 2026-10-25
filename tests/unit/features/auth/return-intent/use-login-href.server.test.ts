/**
 * @jest-environment node
 */
/**
 * DD-AUTH-036 サーバーの描画（window が無い環境）でも、origin を省いたログインの URL を作れること。
 */
import { buildLoginHref } from '@/features/auth/return-intent/use-login-href';

describe('DD-AUTH-036 buildLoginHref（window が無い環境）', () => {
  it('DD-AUTH-036 window が無くても、道筋は相対なのでブラウザと同じ URL になる', () => {
    expect(typeof window).toBe('undefined');
    expect(buildLoginHref('/stockist?from=e2e')).toBe('/login?next=%2Fstockist%3Ffrom%3De2e');
    expect(buildLoginHref('//evil.example')).toBe('/login');
  });
});
