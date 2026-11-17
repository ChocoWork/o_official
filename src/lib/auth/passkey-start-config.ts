import 'server-only';
import { isIP } from 'node:net';

/**
 * パスキーのログインの始め (a) が使う鍵と、手元の開発の IP の設定。クライアントの束に入れない。
 *
 * @packageDocumentation
 */

const SECRET_PREFIX = 'sb_secret_';

/**
 * 前後の空白を除いた値が `sb_secret_` で始まり、`sb_secret_` だけではないか。
 *
 * @impl IMPL-AUTH-251
 * @design DD-AUTH-051
 */
export function isSbSecretKey(value: string | undefined): value is string {
  const trimmed = value?.trim();
  return !!trimmed && trimmed.startsWith(SECRET_PREFIX) && trimmed.length > SECRET_PREFIX.length;
}

/**
 * 始め (a) で GoTrue を呼ぶ鍵を決める。`SUPABASE_SECRET_KEY` を先に、無ければ `SUPABASE_SERVICE_ROLE_KEY` を見る。
 * 先に見つかった値が `sb_secret_` の形でなければ、後ろの変数には倒さず `bad_shape`。値は戻り値にしか出さない。
 *
 * @impl IMPL-AUTH-252
 * @design DD-AUTH-051
 */
export function resolveStartSecretKey(
  env: Record<string, string | undefined> = process.env,
): { ok: true; key: string } | { ok: false; reason: 'missing' | 'bad_shape' } {
  const candidate = env.SUPABASE_SECRET_KEY?.trim() ? env.SUPABASE_SECRET_KEY : env.SUPABASE_SERVICE_ROLE_KEY;
  if (!candidate?.trim()) return { ok: false, reason: 'missing' };
  return isSbSecretKey(candidate) ? { ok: true, key: candidate.trim() } : { ok: false, reason: 'bad_shape' };
}

function isLocalSupabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * 手元の開発で、お客さんの IP の代わりに使う IP。`PASSKEY_START_DEV_IP` が IP の形で、手元の Supabase の住所で、
 * `VERCEL` が `1` でなく `VERCEL_ENV` が空の時だけ返す。それ以外は `null`。
 *
 * @impl IMPL-AUTH-253
 * @design DD-AUTH-051
 */
export function resolvePasskeyStartDevIp(env: Record<string, string | undefined> = process.env): string | null {
  const ip = env.PASSKEY_START_DEV_IP?.trim();
  if (!ip || isIP(ip) === 0) return null;
  if (!isLocalSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL)) return null;
  if (env.VERCEL === '1' || env.VERCEL_ENV?.trim()) return null;
  return ip;
}
