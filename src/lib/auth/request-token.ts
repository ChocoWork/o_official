import { accessCookieName, sessionCookieName } from '@/lib/cookie';

/**
 * Request からトークンとセッション ID を取り出すだけの層。
 *
 * Supabase にも DB にも依存しない。ここを独立させているのは、クライアント生成
 * （@/lib/supabase/server）と認証ポリシー（./authenticate）の両方がこれを必要とし、
 * 1 つにまとめると両者が循環参照になるため。
 * 依存の向きは request-token ← supabase/server ← authenticate の一方向に保つこと。
 */

// Authorization Header から Bearer token を抽出する。
// Cookie を見ないためこれ単体で認可判定に使うと Cookie 認証を取りこぼす。
// 外部へは公開せず、必ず extractAuthToken / verifyAccessToken 経由で使うこと。
export function extractBearerToken(request?: Request): string | null {
  if (!request) return null;

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  return authHeader.substring(7);
}

export function extractCookieValue(cookieHeader: string | null, cookieName: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookiePairs = cookieHeader.split(';');
  for (const pair of cookiePairs) {
    const trimmed = pair.trim();
    const prefix = `${cookieName}=`;

    if (!trimmed.startsWith(prefix)) {
      continue;
    }

    const rawValue = trimmed.slice(prefix.length);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
}

export function extractAccessTokenFromCookie(request?: Request): string | null {
  if (!request) {
    return null;
  }

  return extractCookieValue(request.headers.get('cookie'), accessCookieName);
}

export function extractAuthToken(request?: Request): string | null {
  return extractBearerToken(request) ?? extractAccessTokenFromCookie(request);
}

export function extractSessionIdFromCookie(request?: Request): string | null {
  if (!request) {
    return null;
  }

  return extractCookieValue(request.headers.get('cookie'), sessionCookieName);
}
