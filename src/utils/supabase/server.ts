import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();
  
  // 認証トークンを条件付きで取得
  const authToken = cookieStore.get('sb-access-token')?.value;
  
  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
      global: authToken ? {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      } : {},
    }
  );

  return supabase;
}