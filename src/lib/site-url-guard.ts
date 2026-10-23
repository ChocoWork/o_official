import 'server-only';
import { getSiteUrl } from '@/lib/redirect';

/** メールに実際に入る住所を確認する。手元・preview の localhost は従来どおり使える。 */
export function isEmailOriginAllowed(origin: string): boolean {
  if (process.env.VERCEL_ENV !== 'production') return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return url.protocol === 'https:'
      && host !== 'localhost'
      && !host.endsWith('.localhost')
      && !/^127(?:\.\d{1,3}){3}$/.test(host)
      && host !== '[::1]'
      && host !== '0.0.0.0';
  } catch {
    return false;
  }
}

/** 設定値や URL をエラーに載せず、既存の一時停止へ渡せる固定の記号を返す。 */
export function checkSiteUrlForEmail(): { ok: true; origin: string } | { ok: false; code: 'config_site_url' } {
  const origin = getSiteUrl();
  return isEmailOriginAllowed(origin) ? { ok: true, origin } : { ok: false, code: 'config_site_url' };
}
