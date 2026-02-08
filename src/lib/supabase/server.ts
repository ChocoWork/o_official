import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

// ブラウザ/Edge ランタイム向けに Cookie を使ってユーザセッションを復元するクライアント
export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const authToken = cookieStore.get('sb-access-token')?.value;

  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
      global: authToken
        ? {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          }
        : {},
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
