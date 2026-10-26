/**
 * DD-AUTH-030 通行証の amr から 2 段目を通ったかを読む部品（src/lib/auth/amr.ts）の単体テスト。
 */

import { hasSecondFactorAmr, SECOND_FACTOR_AMR_METHODS } from '@/lib/auth/amr';

describe('hasSecondFactorAmr', () => {
  it.each(['otp', 'magiclink', 'totp', 'oauth', 'sso/saml', 'email/signup'])(
    'DD-AUTH-030 %s が amr にあれば真',
    (method) => {
      expect(hasSecondFactorAmr({ amr: [{ method, timestamp: 0 }] })).toBe(true);
    },
  );

  it.each(['password', 'recovery', 'invite', 'email_change', 'token_refresh', 'anonymous', 'unknown-method'])(
    'DD-AUTH-030 %s だけなら偽',
    (method) => {
      expect(hasSecondFactorAmr({ amr: [{ method, timestamp: 0 }] })).toBe(false);
    },
  );

  it('DD-AUTH-030 password と otp が並ぶなら真', () => {
    expect(hasSecondFactorAmr({ amr: [{ method: 'password' }, { method: 'otp' }] })).toBe(true);
  });

  it('DD-AUTH-030 token_refresh と password だけなら偽', () => {
    expect(hasSecondFactorAmr({ amr: [{ method: 'token_refresh' }, { method: 'password' }] })).toBe(false);
  });

  it('DD-AUTH-030 要素が文字列の古い形も method とみなす', () => {
    expect(hasSecondFactorAmr({ amr: ['otp'] })).toBe(true);
    expect(hasSecondFactorAmr({ amr: ['password'] })).toBe(false);
  });

  it.each([
    ['配列でない', { amr: 'otp' }],
    ['オブジェクト', { amr: { method: 'otp' } }],
    ['空の配列', { amr: [] }],
    ['null の amr', { amr: null }],
    ['未定義の amr', {}],
    ['null の claims', null],
    ['未定義の claims', undefined],
    ['method が文字でない要素', { amr: [{ method: 1 }, null, 3] }],
  ])('DD-AUTH-030 %s は偽', (_label, claims) => {
    expect(hasSecondFactorAmr(claims as { amr?: unknown } | null | undefined)).toBe(false);
  });

  it('DD-AUTH-030 数える方法の一覧に password を含めない', () => {
    expect(SECOND_FACTOR_AMR_METHODS).not.toContain('password');
  });
});
