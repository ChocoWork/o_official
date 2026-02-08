import { cookieOptionsForRefresh, cookieOptionsForCsrf } from '@/lib/cookie';

describe('cookie helpers', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  test('refresh cookie options: HttpOnly true, SameSite lax, secure in production', () => {
    process.env.NODE_ENV = 'production';
    const opts = cookieOptionsForRefresh(60 * 60 * 24);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.secure).toBe(true);
  });

  test('csrf cookie options: HttpOnly false, SameSite lax', () => {
    process.env.NODE_ENV = 'development';
    const opts = cookieOptionsForCsrf(3600);
    expect(opts.httpOnly).toBe(false);
    expect(opts.sameSite).toBe('lax');
    // secure should be false in development by default
    expect(opts.secure).toBe(false);
  });
});
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
