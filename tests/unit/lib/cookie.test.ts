import {
  clearCookieOptions,
  cookieOptionsForCsrf,
  cookieOptionsForRefresh,
  cookieOptionsForReturnIntent,
  returnIntentCookieName,
} from '@/lib/cookie';

describe('cookie helpers', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  test('refresh cookie options: HttpOnly true, SameSite lax, secure in production', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const options = cookieOptionsForRefresh(60 * 60 * 24);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.secure).toBe(true);
    expect(options.maxAge).toBe(60 * 60 * 24);
  });

  test('csrf cookie options: HttpOnly false, SameSite lax', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    const options = cookieOptionsForCsrf(3600);
    expect(options.httpOnly).toBe(false);
    expect(options.sameSite).toBe('lax');
    expect(options.secure).toBe(false);
  });

  test('DD-AUTH-034 return intent cookie options: HttpOnly, SameSite lax, Path /, secure only in production', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(cookieOptionsForReturnIntent(900)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 900,
    });
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    expect(cookieOptionsForReturnIntent(3600).secure).toBe(false);
    expect(returnIntentCookieName).toBe('sb-return-intent');
  });

  test('clear cookie sets maxAge 0', () => {
    const options = clearCookieOptions();
    expect(options.maxAge).toBe(0);
  });
});
