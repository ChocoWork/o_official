import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { accessCookieName } from '@/lib/cookie';

type AuthUserResponse = Awaited<ReturnType<SupabaseClient['auth']['getUser']>>;

// Authorization Header から Bearer token を抽出する
export function extractBearerToken(request?: Request): string | null {
  if (!request) return null;

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.substring(7);
  console.log('[Supabase] Bearer token found in Authorization header');
  return token;
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
  
  // Request がある場合はそこから Cookie を読み取る、なければ next/headers を使う
  const cookieHeader = request ? request.headers.get('cookie') : headersList.get('cookie');

  console.log('[Supabase] Cookie header present:', Boolean(cookieHeader));

  if (authToken) {
    console.log('[Supabase.Session] Using request-scoped Authorization for Supabase client');
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
                } catch (e) {
                  console.warn(`[Supabase.Cookie] Failed to decode cookie value: ${e}`);
                }

                result.push({ name, value: decodedValue });
              }
            }
          } else {
            // Fallback：next/headers から
            console.log('[Supabase.Cookie] No cookieHeader from Request, falling back to next/headers');
            return cookieStore.getAll();
          }

          console.log(`[Supabase.Cookie] Parsed ${result.length} cookie(s) from header`);
          return result;
        },
        setAll(cookiesToSet) {
          try {
            let count = 0;
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
              count += 1;
            }
            console.log(`[Supabase.Cookie.setAll] Set ${count} cookie(s)`);
          } catch (error) {
            console.warn('[Supabase.Cookie.setAll] Failed:', error);
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
