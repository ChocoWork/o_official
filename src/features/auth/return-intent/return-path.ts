/**
 * 戻り先の確かめ（src/features/auth/return-intent/return-path.ts）。
 *
 * @packageDocumentation
 * @remarks ログインの後の行き先は入口と出口の両方でこの 1 つの確かめを通す。単位は export した 3 つの関数で、
 * それぞれに `@impl`・`@design` を付ける（`.ts` の単位は関数）。
 */
import { getSiteUrl } from '@/lib/redirect';

export const RETURN_PATH_MAX_LENGTH = 512;

export type ReturnPathRejectReason =
  | 'empty'
  | 'too_long'
  | 'forbidden_char'
  | 'decode_failed'
  | 'not_relative'
  | 'origin_mismatch'
  | 'userinfo'
  | 'excluded_path'
  | 'not_allowed_path'
  | 'resolved_not_local'
  | 'admin_requires_privileged_aal2';

export type ReturnViewer = {
  role: 'admin' | 'supporter' | 'user';
  /** 'aal2' のときだけ管理者・サポーターに /admin を許す */
  aal: string | null;
};

export type ValidateReturnPathOptions = {
  /** 解釈の基準の origin。省略時は getSiteUrl()（環境変数）の origin。要求の見出しは使わない */
  origin?: string;
  /** 出口の確かめで渡す。渡さない（入口）と /admin は許す */
  viewer?: ReturnViewer;
};

export type ValidateReturnPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: ReturnPathRejectReason };

const FORBIDDEN_CHAR = /[\s\\]|\p{Cc}|\p{Cf}/u;

/** 戻ってよい頁の先頭の道筋。`/` だけは完全一致（ほかは `/x` か `/x/...`）。 */
const ALLOWED_PREFIXES = [
  '/item',
  '/look',
  '/news',
  '/stockist',
  '/about',
  '/search',
  '/privacy',
  '/contact',
  '/account',
  '/wishlist',
  '/cart',
  '/checkout',
  '/admin',
] as const;

const EXCLUDED_PREFIXES = ['/login', '/register', '/auth', '/api'] as const;

const matchesPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const fail = (reason: ReturnPathRejectReason): ValidateReturnPathResult => ({ ok: false, reason });

/**
 * 役割が管理者かサポーターか。
 *
 * @impl IMPL-AUTH-212
 * @design DD-AUTH-032
 * @remarks `/admin` を出口で通す条件（役割と aal2）の役割の側を、入口・出口・窓口で同じ判定にそろえる。
 */
export function isPrivilegedRole(role: unknown): role is 'admin' | 'supporter' {
  return role === 'admin' || role === 'supporter';
}

function resolveBaseOrigin(origin: string | undefined): string | null {
  try {
    return new URL(origin ?? getSiteUrl()).origin;
  } catch {
    return null;
  }
}

/** 空白・制御文字・書式文字・円記号を含むか。 */
const hasForbiddenChar = (value: string): boolean => FORBIDDEN_CHAR.test(value);

/** 「/」で始まり 2 文字目が「/」でも「\」でもないか。 */
const isSingleSlashRelative = (value: string): boolean =>
  value.startsWith('/') && value[1] !== '/' && value[1] !== '\\';

/**
 * 戻り先の候補を確かめ、解釈し直した `pathname + search` だけを返す。
 *
 * @impl IMPL-AUTH-206
 * @design DD-AUTH-032
 * @remarks 文字の頭を見る確かめは URL パーサーとの食い違い（タブ・改行の除去、円記号の読み替え、`..` の解決）で抜ける。
 * 解釈した結果の道筋で許可リストと比べ、fragment は捨てる。
 */
export function validateReturnPath(raw: unknown, options: ValidateReturnPathOptions = {}): ValidateReturnPathResult {
  if (typeof raw !== 'string' || raw.length === 0) return fail('empty');
  if (raw.length > RETURN_PATH_MAX_LENGTH) return fail('too_long');
  if (hasForbiddenChar(raw)) return fail('forbidden_char');

  // %09・%5C・%2F%2F など、1 回のデコードで姿を変える物を同じ検査にかけ直す。
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fail('decode_failed');
  }
  if (decoded.length > RETURN_PATH_MAX_LENGTH) return fail('too_long');
  if (hasForbiddenChar(decoded)) return fail('forbidden_char');
  if (!isSingleSlashRelative(decoded)) return fail('not_relative');

  if (!isSingleSlashRelative(raw)) return fail('not_relative');

  const origin = resolveBaseOrigin(options.origin);
  if (!origin) return fail('origin_mismatch');

  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return fail('origin_mismatch');
  }
  if (url.origin !== origin) return fail('origin_mismatch');
  if (url.username || url.password) return fail('userinfo');

  const out = url.pathname + url.search;
  if (out.startsWith('//') || out.startsWith('/\\')) return fail('resolved_not_local');
  if (out.length > RETURN_PATH_MAX_LENGTH) return fail('too_long');
  try {
    if (new URL(out, origin).origin !== origin) return fail('resolved_not_local');
  } catch {
    return fail('resolved_not_local');
  }

  const { pathname } = url;
  if (EXCLUDED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return fail('excluded_path');
  if (pathname !== '/' && !ALLOWED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return fail('not_allowed_path');
  }

  if (matchesPrefix(pathname, '/admin') && options.viewer) {
    const { role, aal } = options.viewer;
    if (!isPrivilegedRole(role) || aal !== 'aal2') return fail('admin_requires_privileged_aal2');
  }

  return { ok: true, path: out };
}

/**
 * 確かめに外れたら fallback（既定 `/`）を返す。
 *
 * @impl IMPL-AUTH-211
 * @design DD-AUTH-032
 * @remarks fallback は確かめない。`/auth/verified` のように戻り先には許さない行き先を、呼び出し側が既定として渡せる。
 */
export function sanitizeReturnPath(
  raw: unknown,
  fallback: string = '/',
  options?: ValidateReturnPathOptions,
): string {
  const result = validateReturnPath(raw, options);
  return result.ok ? result.path : fallback;
}
