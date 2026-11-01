/** @jest-environment node */
/**
 * DD-AUTH-040 E2E・DB 結合の補助 captcha-test-utils が、Supabase の captcha 用のダミーのトークンを本文に足すかを確かめる。
 * 元の本文を保つこと、元のオブジェクトを書き換えないこと、トークンが Cloudflare の公開のテスト用の値であること。
 */
import { DUMMY_CAPTCHA_TOKEN, withDummyCaptcha } from '../../../e2e/captcha-test-utils';

describe('DD-AUTH-040 captcha-test-utils', () => {
  it('DD-AUTH-040 ダミーのトークンは Cloudflare の公開のテスト用の値である', () => {
    expect(DUMMY_CAPTCHA_TOKEN).toBe('XXXX.DUMMY.TOKEN.XXXX');
  });

  it('DD-AUTH-040 withDummyCaptcha は元の本文を保ち gotrue_meta_security.captcha_token を足す', () => {
    const body = { email: 'a@example.com', password: 'pw' };

    expect(withDummyCaptcha(body)).toEqual({
      email: 'a@example.com',
      password: 'pw',
      gotrue_meta_security: { captcha_token: DUMMY_CAPTCHA_TOKEN },
    });
  });

  it('DD-AUTH-040 withDummyCaptcha は元のオブジェクトを書き換えない', () => {
    const body = { email: 'a@example.com' };

    const result = withDummyCaptcha(body);

    expect(body).toEqual({ email: 'a@example.com' });
    expect(result).not.toBe(body);
  });
});
