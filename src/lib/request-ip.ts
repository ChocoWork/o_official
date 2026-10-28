/**
 * 要求の送り元 IP を取り出す共有の関数（src/lib/request-ip.ts）。回数の制限の鍵と監査の IP が使う。
 *
 * @packageDocumentation
 */
import { isIP } from 'node:net';

/** Vercel が付ける見出しを、強い順に並べる。`x-forwarded-for` は入れない。 */
const TRUSTED_IP_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip'] as const;

/** 見出しを信じてよい環境か。Vercel 上か、`CLIENT_IP_HEADER` が空でない（手元の E2E など）時だけ。 */
function trustsClientIpHeaders(): boolean {
  return process.env.VERCEL === '1' || (process.env.CLIENT_IP_HEADER ?? '') !== '';
}

/**
 * 送り元の IP を返す。信じてよい環境で、`x-vercel-forwarded-for` → `x-real-ip` の順に最初に在った見出しを読み、
 * IP の形（`isIP`）でなければ null。取れなければ null。
 *
 * @impl IMPL-AUTH-224
 * @design DD-AUTH-038
 * @remarks `x-forwarded-for` は誰でも付けられ、左端を信じると回数の制限と監査の IP を偽れるので読まない。
 * Vercel は `x-vercel-forwarded-for`・`x-real-ip` を上書きして付けるので、その環境の値だけを信じる。
 * 最初に在った見出しの値が不正なら次の見出しへ進まず null にする（上位の見出しが壊れている要求を、下位の見出しで救わない）。
 * `CLIENT_IP_HEADER` は旗で、値は見ない。`TRUST_PROXY_HEADERS` は `redirect.ts` のオリジンの決め方の別の意味なので読まない。
 */
export function getClientIp(request?: Request): string | null {
  if (!request || !trustsClientIpHeaders()) return null;
  for (const name of TRUSTED_IP_HEADERS) {
    const raw = request.headers.get(name);
    if (raw === null) continue;
    const value = raw.trim();
    return isIP(value) !== 0 ? value : null;
  }
  return null;
}

/**
 * 監査に載せる送り元の文脈を返す。`ip` は `getClientIp`、`user_agent` は `user-agent` の見出し（無い・空なら null）。
 *
 * @impl IMPL-AUTH-225
 * @design DD-AUTH-038
 * @remarks 取れない時は null のまま保存する（`unknown` などの偽の値を行に入れない）。
 */
export function getAuditRequestContext(request: Request): { ip: string | null; user_agent: string | null } {
  return {
    ip: getClientIp(request),
    user_agent: request.headers.get('user-agent') || null,
  };
}
