/**
 * 認証の応答に `Cache-Control: no-store` を付ける道を決める（src/lib/auth-no-store-policy.ts）。共有の `src/proxy.ts` が呼ぶ。
 *
 * @packageDocumentation
 */

const NO_STORE_PATH_PREFIX = '/api/auth';

/**
 * `/api/auth` か `/api/auth/…` の道なら true（セグメントの境目で見る）。
 *
 * @impl IMPL-AUTH-223
 * @design DD-AUTH-037
 * @remarks トークン・確認コード・TOTP の秘密を含む応答が共有の端末や中継に残らないよう、窓口ごとの付け忘れに頼らず道筋でまとめて付ける。
 * 素の `startsWith` だと `/api/authx` まで当たるので、境目（完全一致か `<prefix>/`）で見る。
 */
export function shouldSetNoStore(pathname: string): boolean {
  return pathname === NO_STORE_PATH_PREFIX || pathname.startsWith(`${NO_STORE_PATH_PREFIX}/`);
}
