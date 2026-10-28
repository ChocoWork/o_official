// 画像の置き場（Supabase Storage）の値から、決まった接頭辞の下の安全な道筋だけを取り出す共有の関数。

export const SAFE_OBJECT_PATH_BODY = '[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*';

const STORAGE_OBJECT_KINDS = ['public', 'sign', 'authenticated'] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 「<prefix>/ の下の安全な文字だけ」の道筋なら true（URL は受けない）。
 *
 * @impl IMPL-SEARCH-129
 * @design DD-SEARCH-011
 * @remarks 署名の前に、表の値が決まった場所の下の道筋かを文字だけで確かめる。URL の確かめは parseOwnObjectPath が受け持つ。
 * LOOK・NEWS・ITEM の署名も通す共有の部品だが、最初の利用者の SEARCH の項目につなぐ（SEC-SEARCH-016）。
 */
export function isSafeObjectPath(path: string, prefix: string): boolean {
  return new RegExp(`^${escapeRegExp(prefix)}/${SAFE_OBJECT_PATH_BODY}$`).test(path);
}

/** 信頼する origin は 1 つだけ（CSP の supabaseOrigin と同じ `||` の順）。無い・壊れていれば空。 */
function trustedOrigin(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!url) return '';

  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function stripBucket(path: string, bucket: string): string {
  return path.startsWith(`${bucket}/`) ? path.slice(bucket.length + 1) : path;
}

/**
 * 画像の値（素の道筋 / バケット名つきの道筋 / 自分のプロジェクトの Storage の URL）から、<prefix>/ の下の安全な道筋を取り出す。
 * URL は origin が NEXT_PUBLIC_SUPABASE_URL（無ければ SUPABASE_URL）の origin 1 つと一致し、パスが
 * /storage/v1/object/(public|sign|authenticated)/<bucket>/ の下の時だけ。decodeURIComponent の後にも式に合うこと。
 * 取り出せない物（外の host・別のバケット・.. ・// ・他の接頭辞・壊れた %・空）は null。
 * 素の道筋の先頭の / は 1 つだけ外して通す。
 *
 * @impl IMPL-SEARCH-130
 * @design DD-SEARCH-011
 * @remarks 署名は service role で行うので置き場の方針が効かない。表に外の URL や .. を含む道が入っても別の物を署名しないよう、
 * 署名の前に信頼する origin 1 つ・決まった接頭辞・安全な文字だけを通し、取り出せなければ null を返す（SEC-SEARCH-016）。
 */
export function parseOwnObjectPath(
  raw: string | null | undefined,
  options: { bucket: string; prefix: string },
): string | null {
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (value === '') return null;

  const { bucket, prefix } = options;
  let candidate: string;

  if (value.startsWith('http://') || value.startsWith('https://')) {
    const origin = trustedOrigin();
    if (!origin) return null;

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.origin !== origin) return null;

    const marker = STORAGE_OBJECT_KINDS.map((kind) => `/storage/v1/object/${kind}/${bucket}/`).find((m) =>
      parsed.pathname.startsWith(m),
    );
    if (!marker) return null;

    try {
      candidate = decodeURIComponent(parsed.pathname.slice(marker.length));
    } catch {
      return null;
    }
  } else {
    candidate = value.replace(/^\//, '');
  }

  const path = stripBucket(candidate, bucket);
  return isSafeObjectPath(path, prefix) ? path : null;
}
