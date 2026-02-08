import { cookieOptionsForRefresh, cookieOptionsForCsrf, clearCookieOptions, refreshCookieName, csrfCookieName } from '../../../src/lib/cookie';

describe('cookie helpers', () => {
  test('refresh options include httpOnly true', () => {
    const opts = cookieOptionsForRefresh(60 * 60 * 24);
    expect(opts.httpOnly).toBe(true);
    expect(opts.maxAge).toBe(60 * 60 * 24);
  });

  test('csrf options are not httpOnly', () => {
    const opts = cookieOptionsForCsrf(60 * 60);
    expect(opts.httpOnly).toBe(false);
  });

  test('clear cookie sets maxAge 0', () => {
    const opts = clearCookieOptions();
    expect(opts.maxAge).toBe(0);
  });
});
