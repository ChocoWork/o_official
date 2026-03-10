import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';

// Authorization Header から Bearer token を抽出する
export function extractBearerToken(request?: Request): string | null {
  if (!request) return null;

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.substring(7);
  console.log('[Supabase] Bearer token found in Authorization header');
  return token;
}

// API ルート向け：Request オブジェクトから Cookie または Authorization ヘッダーを読み取りセッション復元
export async function createClient(request?: Request): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const headersList = await headers();

  const { createServerClient } = await import('@supabase/ssr');

  // Authorization header から Bearer token を取得（優先順位：Authorization > Cookie）
  const bearerToken = extractBearerToken(request);
  
  // Request がある場合はそこから Cookie を読み取る、なければ next/headers を使う
  const cookieHeader = request ? request.headers.get('cookie') : headersList.get('cookie');

  console.log('[Supabase] Cookie header:', cookieHeader?.substring(0, 100));

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
          // Authorization header に Bearer token がある場合は synthetic session を返す
          if (bearerToken) {
            console.log('[Supabase.Session] Using Bearer token from Authorization header');
            return [
              {
                name: 'sb-access-token',
                value: bearerToken,
              },
            ];
          }

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
                  console.warn(`[Supabase.Cookie] Failed to decode ${name}: ${e}`);
                }
                
                result.push({ name, value: decodedValue });
                
                // トークン関連の Cookie は詳しくログ
                if (name.includes('sb-') || name.includes('refresh') || name.includes('access') || name.includes('session')) {
                  console.log(`[Supabase.Cookie] ${name}:`);
                  console.log(`  Raw: ${rawValue.substring(0, 60)}`);
                  console.log(`  Decoded: ${decodedValue.substring(0, 60)}`);
                  console.log(`  Length: ${decodedValue.length}`);
                }
              }
            }
          } else {
            // Fallback：next/headers から
            console.log('[Supabase.Cookie] No cookieHeader from Request, falling back to next/headers');
            return cookieStore.getAll();
          }

          console.log(`[Supabase.Cookie] Total ${result.length} cookies parsed from header`);
          return result;
        },
        setAll(cookiesToSet) {
          if (bearerToken) {
            // Bearer token を使っている場合は setAll を無視（Cookie を設定しない）
            console.log('[Supabase.Session] Ignoring setAll when using Bearer token');
            return;
          }

          try {
            for (const { name, value, options } of cookiesToSet) {
              console.log(`[Supabase.Cookie.setAll] Setting ${name}`);
              cookieStore.set(name, value, options);
            }
          } catch (error) {
            console.warn('[Supabase.Cookie.setAll] Failed:', error);
          }
        },
      },
    }
  );

  return supabase;
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
