import type { SupabaseClient } from '@supabase/supabase-js';
import { parseOwnObjectPath } from '@/lib/storage/safe-object-path';

const ITEM_IMAGES_BUCKET = 'item-images';
const ITEM_IMAGES_PREFIX = 'items';
export const DEFAULT_ITEM_IMAGE_SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

const signedUrlCache = new Map<string, { signedUrl: string; expiresAtMs: number }>();

function normalizeObjectPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, '');
  if (trimmed.startsWith(`${ITEM_IMAGES_BUCKET}/`)) {
    return trimmed.slice(ITEM_IMAGES_BUCKET.length + 1);
  }

  return trimmed;
}

export function extractItemImageObjectPath(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return null;
  }

  const value = rawUrl.trim();

  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return normalizeObjectPath(value);
  }

  try {
    const parsed = new URL(value);
    const candidates = [
      `/storage/v1/object/public/${ITEM_IMAGES_BUCKET}/`,
      `/storage/v1/object/sign/${ITEM_IMAGES_BUCKET}/`,
      `/storage/v1/object/authenticated/${ITEM_IMAGES_BUCKET}/`,
    ];

    for (const marker of candidates) {
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex >= 0) {
        const rawPath = parsed.pathname.slice(markerIndex + marker.length);
        if (rawPath.length === 0) {
          return null;
        }

        return normalizeObjectPath(decodeURIComponent(rawPath));
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function createSignedUrlByPath(
  supabase: SupabaseClient,
  path: string,
  expiresIn: number,
): Promise<string | null> {
  const cacheKey = `${path}:${expiresIn}`;
  const cachedEntry = signedUrlCache.get(cacheKey);
  if (cachedEntry && cachedEntry.expiresAtMs > Date.now()) {
    return cachedEntry.signedUrl;
  }

  let signedUrl: string | undefined;
  try {
    const { data, error } = await supabase.storage
      .from(ITEM_IMAGES_BUCKET)
      .createSignedUrl(path, expiresIn);
    signedUrl = error ? undefined : data?.signedUrl;
  } catch {
    signedUrl = undefined;
  }

  if (!signedUrl) {
    warnSigningFailure('sign_failed');
    return null;
  }

  // 使い回すのは残りが期限の半分以上ある間だけにする。頁に載せた URL が、遅延読み込みで画像を取る前に切れないため。
  const safeTtlSeconds = Math.max(1, expiresIn / 2);
  signedUrlCache.set(cacheKey, {
    signedUrl,
    expiresAtMs: Date.now() + safeTtlSeconds * 1000,
  });

  return signedUrl;
}

/** 失敗の種類だけを残す。道筋・URL・Supabase の誤りの文は書かない。 */
function warnSigningFailure(kind: 'invalid_path' | 'sign_failed'): void {
  console.warn(`[item-images] ${kind}`);
}

function parseItemImagePath(rawUrl: string | null | undefined): string | null {
  return parseOwnObjectPath(rawUrl, { bucket: ITEM_IMAGES_BUCKET, prefix: ITEM_IMAGES_PREFIX });
}

export async function signItemImageUrl(
  supabase: SupabaseClient,
  rawUrl: string | null | undefined,
  expiresIn: number = DEFAULT_ITEM_IMAGE_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string | null> {
  if (!rawUrl) {
    return null;
  }

  const path = parseItemImagePath(rawUrl);
  if (!path) {
    warnSigningFailure('invalid_path');
    return null;
  }

  return createSignedUrlByPath(supabase, path, expiresIn);
}

export async function signItemImageUrls(
  supabase: SupabaseClient,
  rawUrls: Array<string | null | undefined>,
  expiresIn: number = DEFAULT_ITEM_IMAGE_SIGNED_URL_EXPIRY_SECONDS,
): Promise<Array<string | null>> {
  if (rawUrls.length === 0) {
    return [];
  }

  const paths = rawUrls.map((rawUrl) => {
    if (!rawUrl) {
      return null;
    }

    const path = parseItemImagePath(rawUrl);
    if (!path) {
      warnSigningFailure('invalid_path');
    }
    return path;
  });

  const uniquePaths = Array.from(new Set(paths.filter((path): path is string => Boolean(path))));

  const signedUrlEntries = await Promise.all(
    uniquePaths.map(async (path) => {
      const signedUrl = await createSignedUrlByPath(supabase, path, expiresIn);
      return signedUrl ? [path, signedUrl] as const : null;
    }),
  );

  const signedUrlByPath = new Map<string, string>(
    signedUrlEntries.filter((entry): entry is readonly [string, string] => entry !== null),
  );

  // 位置を保つ。無効な要素を詰めると、image_url が無効の時に image_urls の先頭が image_url に繰り上がる。
  return paths.map((path) => (path ? signedUrlByPath.get(path) ?? null : null));
}

export type SignedItemImageFields<T> = Omit<T, 'image_url' | 'image_urls'> & {
  image_url: string | null;
  image_urls: string[];
};

export async function signItemImageFields<T extends { image_url?: string | null; image_urls?: string[] | null }>(
  supabase: SupabaseClient,
  row: T,
): Promise<SignedItemImageFields<T>> {
  const sourceImageUrls = Array.isArray(row.image_urls) ? row.image_urls : [];
  const [nextImageUrl = null, ...nextImageUrls] = await signItemImageUrls(
    supabase,
    [row.image_url ?? null, ...sourceImageUrls],
  );

  return {
    ...row,
    image_url: nextImageUrl,
    image_urls: nextImageUrls.filter((url): url is string => Boolean(url)),
  };
}
