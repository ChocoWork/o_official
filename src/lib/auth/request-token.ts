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

/** 送信中に exp をまたいで弾かれないための猶予。supabase-js の EXPIRY_MARGIN と同じ考え方。 */
const TOKEN_EXPIRY_MARGIN_SECONDS = 5;

/** JWT の exp（秒）を読む。署名は見ない。読めなければ null。 */
function readJwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) {
    return null;
  }

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // 日本語を含むクレームがあるので latin1 のままではなく UTF-8 として読む。
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };

    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

/**
 * Supabase へ Authorization ヘッダーとして転送してよい access token だけを返す。
 *
 * 期限切れのトークンを転送すると PostgREST は**そのリクエスト全体**を 401 で落とす。
 * ゲストの session_id だけで通るはずの操作（ウィッシュリスト追加やカート操作）まで
 * 巻き添えで失敗し、ルート側からは DB エラーと区別がつかないので 500 になる。
 * クライアントの 401 → refresh → 再送（@/lib/client-fetch）も発火しない。
 *
 * そこで「サーバーが確実に拒否すると分かっているトークン」は最初から載せない。
 * 落とした場合は anon として叩くだけなので、権限は増えない（RLS の auth.uid() は
 * NULL になり、認証必須の経路は authenticateRequest が別途 401 を返す）。
 *
 * 検証ではなく転送の可否判定なので署名は見ない。署名検証は @/lib/auth/authenticate と
 * PostgREST の担当。
 */
export function extractForwardableAuthToken(request?: Request): string | null {
  const token = extractAuthToken(request);
  if (!token) {
    return null;
  }

  const expiry = readJwtExpiry(token);
  if (expiry === null || expiry <= Date.now() / 1000 + TOKEN_EXPIRY_MARGIN_SECONDS) {
    return null;
  }

  return token;
}
