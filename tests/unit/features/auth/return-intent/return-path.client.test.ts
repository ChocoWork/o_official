/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-032 戻り先の確かめを、ブラウザの環境（jsdom）で import して window.location.origin を基準に使えること。
 */
import { validateReturnPath } from '@/features/auth/return-intent/return-path';

describe('DD-AUTH-032 ブラウザの環境', () => {
  it('DD-AUTH-032 import でき、window.location.origin を基準にして動く', () => {
    expect(validateReturnPath('/stockist?from=e2e', { origin: window.location.origin })).toEqual({
      ok: true,
      path: '/stockist?from=e2e',
    });
    expect(validateReturnPath('//evil.example', { origin: window.location.origin })).toEqual({
      ok: false,
      reason: 'not_relative',
    });
  });
});
