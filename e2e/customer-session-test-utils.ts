/**
 * お客さん（会員）の JWT を、パスワード無しで取る試験の手助け。手元の Supabase だけ。
 *
 * auth.admin.generateLink の magiclink の hashed_token を、匿名の鍵の verifyOtp に渡して session を得る。
 * GoTrue の authentication_method は password 以外になるので、旗 reject_customer_password が真でも通る。
 * JWT・token・鍵は失敗の文面に出さない。製品のコードではないので @impl は付けない。
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';

function localEnv(): { url: string; anonKey: string; serviceKey: string } {
  // E2E は NEXT_PUBLIC_*、DB 結合は LOCAL_SUPABASE_*（調整役が環境から渡す）で手元の値を受ける
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.LOCAL_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.LOCAL_SUPABASE_ANON_KEY || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !anonKey || !serviceKey || !isLocalUrl(url)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この手助けは手元の Supabase だけで使う）');
  }
  return { url, anonKey, serviceKey };
}

/** Auth の回数の制限は送り元ごとに数える。呼ぶごとに別の送り元にする */
function sourceIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

function client(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-forwarded-for': sourceIp() } },
  });
}

export async function signInCustomerWithoutPassword(email: string): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const { url, anonKey, serviceKey } = localEnv();
  const link = await client(url, serviceKey).auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) {
    throw new Error(`手元の会員のログインのリンクを作れない（status: ${link.error?.status ?? '不明'}）`);
  }
  const verified = await client(url, anonKey).auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  const session = verified.data?.session;
  if (verified.error || !session?.access_token || !session.refresh_token || !verified.data?.user) {
    throw new Error(`手元の会員の session を得られない（status: ${verified.error?.status ?? '不明'}）`);
  }
  return { accessToken: session.access_token, refreshToken: session.refresh_token, userId: verified.data.user.id };
}
