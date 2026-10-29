/**
 * アプリの session への結び付け（自前の sessions に GoTrue の session_id を残す）で使う、旗と session_id の読み取り（src/lib/auth/app-session.ts）。
 *
 * @packageDocumentation
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 結び付きを求めるか。
 *
 * AUTH_REQUIRE_APP_SESSION が off・0・false（大小文字を区別せず、前後の空白は無視）の時だけ偽。
 * 未設定・空・その他は真。
 *
 * @impl IMPL-AUTH-226
 * @design DD-AUTH-039
 * @remarks 公開の anon キーで password や OTP の通行証が取れ、amr ではアプリのログインを通ったかを区別できない。
 * 既定で有効にするのは、設定し忘れで穴が開いたままになるのを避けるため（ADR-0419）。旗は読む側（生存の確認と refresh の強制）だけを切り替え、書く側は旗に関係なく常に書く。
 */
export function isAppSessionRequired(): boolean {
  const value = process.env.AUTH_REQUIRE_APP_SESSION?.trim().toLowerCase();
  return !(value === 'off' || value === '0' || value === 'false');
}

/**
 * GoTrue から直に受けた access token の session_id を、uuid の形の時だけ小文字で返す。
 * 無い・形が悪い・壊れている token は null。
 *
 * @impl IMPL-AUTH-227
 * @design DD-AUTH-039
 * @remarks 署名は見ない。GoTrue の応答（verifyOtp・token 交換・mfa.verify）にだけ使い、
 * リクエストの Cookie や本文から来た token には使わない（検証は verifyAccessToken が行う）。
 * 外から来た token の値を保存すると、結び付いていない session を結び付けた session に洗えてしまう。
 */
export function readAuthSessionId(accessToken: string | null | undefined): string | null {
  if (!accessToken) {
    return null;
  }
  const segments = accessToken.split('.');
  if (segments.length < 2) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const sessionId = (payload as { session_id?: unknown }).session_id;
    return typeof sessionId === 'string' && UUID_PATTERN.test(sessionId) ? sessionId.toLowerCase() : null;
  } catch {
    return null;
  }
}
