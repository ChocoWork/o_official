/**
 * E2E・DB 結合の補助。Supabase の captcha（Turnstile）が有効な手元の Auth に、anon の鍵で直に叩く時のダミーのトークン。
 *
 * captcha が切れている間は GoTrue が余分な gotrue_meta_security を無視するので、付けても害は無い。
 * 手元の Auth の secret は Cloudflare の公開のテスト用（1x0000000000000000000000000000000AA）で、このトークンの検証を常に通す。本番の secret は拒む。
 *
 * @design DD-AUTH-040
 */

/** Cloudflare の公開のテスト用トークン。テスト用の secret の検証を常に通る。本番の secret は拒む */
export const DUMMY_CAPTCHA_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** 生の fetch の本文に足す。supabase-js なら options: { captchaToken: DUMMY_CAPTCHA_TOKEN } を使う */
export function withDummyCaptcha<T extends Record<string, unknown>>(body: T): T & { gotrue_meta_security: { captcha_token: string } } {
  return { ...body, gotrue_meta_security: { captcha_token: DUMMY_CAPTCHA_TOKEN } };
}
