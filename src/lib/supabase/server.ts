import type { JwtPayload, SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { accessCookieName, sessionCookieName } from '@/lib/cookie';

type AuthUserResponse = Awaited<ReturnType<SupabaseClient['auth']['getUser']>>;

export type VerifiedAccessToken =
  | { ok: true; claims: JwtPayload }
  | { ok: false; reason: 'missing' | 'invalid' };

// Authorization Header から Bearer token を抽出する。
// Cookie を見ないためこれ単体で認可判定に使うと Cookie 認証を取りこぼす。
// 外部へは公開せず、必ず extractAuthToken / verifyAccessToken 経由で使うこと。
function extractBearerToken(request?: Request): string | null {
  if (!request) return null;

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  return authHeader.substring(7);
}

function extractCookieValue(cookieHeader: string | null, cookieName: string): string | null {
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

// JWKS のキャッシュ（TTL 10 分）はクライアントインスタンス単位なので、検証専用クライアントは
// モジュールレベルで 1 個だけ作って使い回す。getClaims に JWT を明示的に渡す限り
// セッションストレージには触れないため、リクエスト間で共有しても状態は混ざらない。
let tokenVerifierClient: SupabaseClient | null = null;

async function getTokenVerifierClient(): Promise<SupabaseClient> {
  if (!tokenVerifierClient) {
    const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');

    tokenVerifierClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      },
    );
  }

  return tokenVerifierClient;
}

function hasAuthenticatedAudience(aud: string | string[]): boolean {
  return Array.isArray(aud) ? aud.includes('authenticated') : aud === 'authenticated';
}

async function resolveAccessToken(request?: Request): Promise<string | null> {
  const fromRequest = extractAuthToken(request);
  if (fromRequest) {
    return fromRequest;
  }

  if (request) {
    return null;
  }

  const cookieStore = await cookies();
  return cookieStore.get(accessCookieName)?.value ?? null;
}

/**
 * Access token を検証して claims を返す。認可判定はこの関数だけを入口にする。
 *
 * getClaims は非対称鍵（本プロジェクトは ES256）なら JWKS でローカル検証し、署名と exp を確認する。
 * ただし iss / aud は検証しないため、ここで明示的に突き合わせる。
 */
export async function verifyAccessToken(request?: Request): Promise<VerifiedAccessToken> {
  const token = await resolveAccessToken(request);
  if (!token) {
    return { ok: false, reason: 'missing' };
  }

  const verifier = await getTokenVerifierClient();
  const { data, error } = await verifier.auth.getClaims(token);

  if (error || !data?.claims) {
    return { ok: false, reason: 'invalid' };
  }

  const claims = data.claims;
  const expectedIssuer = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`;

  if (claims.iss !== expectedIssuer || !hasAuthenticatedAudience(claims.aud)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, claims };
}

export async function resolveRequestUser(
  supabase: SupabaseClient,
  request?: Request,
): Promise<AuthUserResponse> {
  const bearerToken = extractBearerToken(request);
  const cookieToken = extractAccessTokenFromCookie(request);

  if (bearerToken) {
    const bearerResult = await supabase.auth.getUser(bearerToken);
    if (bearerResult.data.user) {
      return bearerResult;
    }
  }

  if (cookieToken && cookieToken !== bearerToken) {
    const cookieResult = await supabase.auth.getUser(cookieToken);
    if (cookieResult.data.user) {
      return cookieResult;
    }
  }

  return supabase.auth.getUser();
}

// API ルート向け：Request オブジェクトから Cookie または Authorization ヘッダーを読み取りセッション復元
export async function createClient(request?: Request): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const headersList = await headers();

  const { createServerClient } = await import('@supabase/ssr');
  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');

  const authToken = extractAuthToken(request);
  const sessionId = request
    ? extractSessionIdFromCookie(request)
    : cookieStore.get(sessionCookieName)?.value ?? extractCookieValue(headersList.get('cookie'), sessionCookieName);
  const sessionContextHeaders: Record<string, string> = {};
  if (sessionId) {
    sessionContextHeaders['x-session-id'] = sessionId;
  }
  
  // Request がある場合はそこから Cookie を読み取る、なければ next/headers を使う
  const cookieHeader = request ? request.headers.get('cookie') : headersList.get('cookie');

  if (authToken) {
    return createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        global: {
          headers: {
            Authorization: `Bearer ${authToken}`,
            ...sessionContextHeaders,
          },
        },
      },
    );
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: true,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: sessionContextHeaders,
      },
      cookies: {
        getAll() {
          const result: Array<{ name: string; value: string }> = [];
          
          if (cookieHeader) {
            // Cookie ヘッダーから手動で解析
            const cookiePairs = cookieHeader.split(';');
            for (const pair of cookiePairs) {
              const trimmed = pair.trim();
              const eqIndex = trimmed.indexOf('=');
              if (eqIndex > 0) {
                const name = trimmed.substring(0, eqIndex);
                const rawValue = trimmed.substring(eqIndex + 1);
                
                // URL デコード
                let decodedValue = rawValue;
                try {
                  decodedValue = decodeURIComponent(rawValue);
                } catch {
                  // Intentionally omit error details to avoid leaking raw cookie value fragments in logs
                  console.warn('[Supabase.Cookie] Failed to decode cookie value');
                }

                result.push({ name, value: decodedValue });
              }
            }
          } else {
            // Fallback：next/headers から
            return cookieStore.getAll();
          }

          return result;
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Parameters<typeof cookieStore.set>[2] }>) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Avoid logging runtime error objects because some platforms may include request metadata.
            console.warn('[Supabase.Cookie.setAll] Failed');
          }
        },
      },
    }
  );

  return supabase;
}

// 公開ページ用：閲覧者セッションを引き継がない匿名クライアント
export async function createPublicClient(): Promise<SupabaseClient> {
  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');

  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}

// サーバサイドの管理操作（マイグレーションやユーザ管理等）に使うサービスロールキーを用いたクライアント
// SUPABASE_SERVICE_ROLE_KEY を必ず環境変数で設定して使用してください（Secrets 管理下に置くこと）。
export async function createServiceRoleClient(): Promise<SupabaseClient> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL must be set for service role client');
  }

  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
  return createSupabaseClient(url, serviceKey, {
    auth: {
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
