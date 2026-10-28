/**
 * `session_id` の Cookie を発行する道を決める（src/lib/session-cookie-policy.ts）。共有の `src/proxy.ts` が呼ぶ。
 *
 * @packageDocumentation
 */

// session_id の読み手は決済の流れだけ（checkout-route-guard・create-session・complete・supabase/server.ts の x-session-id）。
// 発行もそこに限る。ログインの成功で回す src/features/auth/services/register.ts の発行は別の仕組みで、ここの対象外。
const SESSION_COOKIE_ISSUE_PATH_PREFIXES = ['/cart', '/checkout', '/api/checkout'] as const;

/**
 * `session_id` を発行してよい道なら true。許可リスト `/cart`・`/checkout`・`/api/checkout` のどれかに、セグメントの境目で当たる時だけ。
 *
 * @impl IMPL-PRIVACY-104
 * @design DD-PRIVACY-004
 * @remarks `session_id` を読むのは決済の流れだけなので、読み手のいない頁には配らない（既定は配らない）。
 * 素の `startsWith` だと `/cartx` や `/api/checkoutx` まで当たるので、境目（完全一致か `<prefix>/`）で見る。
 */
export function shouldIssueSessionCookie(pathname: string): boolean {
  return SESSION_COOKIE_ISSUE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
