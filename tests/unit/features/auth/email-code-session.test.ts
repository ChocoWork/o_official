/** @jest-environment node */
/**
 * DD-AUTH-059 メールのコードの保留の Cookie（src/features/auth/services/email-code-session.ts）の単体テスト。
 */
import {
  createEmailCodeSessionToken,
  verifyEmailCodeSessionToken,
  readEmailCodeSessionFromCookieHeader,
  emailCodeSessionAbsoluteMaxAgeSeconds,
} from '@/features/auth/services/email-code-session';
import { createLoginTwoFactorSessionToken, verifyLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';

const ORIGINAL_ENV = { ...process.env };
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '' };
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.useRealTimers();
});

describe('DD-AUTH-059 emailCodeSession', () => {
  test('DD-AUTH-059 署名した Cookie を読み戻せる。userId を持たず、乱数の jti を持つ', () => {
    const token = createEmailCodeSessionToken({ email: 'a@example.com' });
    const session = verifyEmailCodeSessionToken(token);
    expect(session).toMatchObject({ purpose: 'email_code', email: 'a@example.com' });
    expect(session?.jti.length).toBeGreaterThan(10);
    expect(session).not.toHaveProperty('userId');
    const other = verifyEmailCodeSessionToken(createEmailCodeSessionToken({ email: 'a@example.com' }));
    expect(other?.jti).not.toBe(session?.jti);
  });

  test('DD-AUTH-059 再発行で iat と jti を引き継げる', () => {
    const session = verifyEmailCodeSessionToken(
      createEmailCodeSessionToken({ email: 'a@example.com', issuedAt: now() - 100, jti: 'fixed-jti' }),
    );
    expect(session?.jti).toBe('fixed-jti');
    expect(session?.iat).toBe(now() - 100);
  });

  test('DD-AUTH-059 署名の改ざん・空・形の違いは null', () => {
    const token = createEmailCodeSessionToken({ email: 'a@example.com' });
    const [payload, sig] = token.split('.');
    expect(verifyEmailCodeSessionToken(null)).toBeNull();
    expect(verifyEmailCodeSessionToken('')).toBeNull();
    expect(verifyEmailCodeSessionToken('abc')).toBeNull();
    expect(verifyEmailCodeSessionToken(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ purpose: 'email_code', email: 'b@example.com', jti: 'x', iat: now(), exp: now() + 60 })).toString('base64url');
    expect(verifyEmailCodeSessionToken(`${forged}.${sig}`)).toBeNull();
  });

  test('DD-AUTH-059 期限切れは null', () => {
    const token = createEmailCodeSessionToken({ email: 'a@example.com', expiresInSeconds: 60 });
    jest.useFakeTimers().setSystemTime(Date.now() + 61_000);
    expect(verifyEmailCodeSessionToken(token)).toBeNull();
  });

  test('DD-AUTH-059 絶対の上限を超えたら、exp が先でも null（再送で延ばせない）', () => {
    const token = createEmailCodeSessionToken({
      email: 'a@example.com',
      issuedAt: now() - emailCodeSessionAbsoluteMaxAgeSeconds - 1,
      expiresInSeconds: 300,
    });
    expect(verifyEmailCodeSessionToken(token)).toBeNull();
  });

  test('DD-AUTH-059 旧い保留の Cookie の値は新しい窓口で null、新しい値は旧で null', () => {
    const legacy = createLoginTwoFactorSessionToken({ userId: 'u1', email: 'a@example.com' });
    const fresh = createEmailCodeSessionToken({ email: 'a@example.com' });
    expect(verifyEmailCodeSessionToken(legacy)).toBeNull();
    expect(verifyLoginTwoFactorSessionToken(fresh)).toBeNull();
  });

  test('DD-AUTH-059 Cookie の見出しから読める。名前が違う・無い時は null', () => {
    const token = createEmailCodeSessionToken({ email: 'a@example.com' });
    expect(readEmailCodeSessionFromCookieHeader(`x=1; sb-email-code-session=${encodeURIComponent(token)}`)?.email).toBe('a@example.com');
    expect(readEmailCodeSessionFromCookieHeader(`sb-login-2fa-session=${token}`)).toBeNull();
    expect(readEmailCodeSessionFromCookieHeader(null)).toBeNull();
  });

  test('DD-AUTH-059 署名の鍵が無ければ throw する', () => {
    process.env = { ...ORIGINAL_ENV, JWT_SECRET: '', LOGIN_2FA_SESSION_SECRET: '' };
    expect(() => createEmailCodeSessionToken({ email: 'a@example.com' })).toThrow();
  });
});
