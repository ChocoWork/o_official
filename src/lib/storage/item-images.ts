import type { SupabaseClient } from '@supabase/supabase-js';

const ITEM_IMAGES_BUCKET = 'item-images';
const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 7;
const SIGNED_URL_CACHE_BUFFER_SECONDS = 60;

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

  const { data, error } = await supabase.storage
    .from(ITEM_IMAGES_BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    return null;
  }

  const safeTtlSeconds = Math.max(1, expiresIn - SIGNED_URL_CACHE_BUFFER_SECONDS);
  signedUrlCache.set(cacheKey, {
    signedUrl: data.signedUrl,
    expiresAtMs: Date.now() + safeTtlSeconds * 1000,
  });

  return data.signedUrl;
}

export async function signItemImageUrl(
  supabase: SupabaseClient,
  rawUrl: string | null | undefined,
  expiresIn: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string | null> {
  if (!rawUrl) {
    return null;
  }

  const path = extractItemImageObjectPath(rawUrl);
  if (!path) {
    return rawUrl;
  }

  const signedUrl = await createSignedUrlByPath(supabase, path, expiresIn);
  return signedUrl ?? rawUrl;
}

export async function signItemImageUrls(
  supabase: SupabaseClient,
  rawUrls: Array<string | null | undefined>,
  expiresIn: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string[]> {
  if (rawUrls.length === 0) {
    return [];
  }

  const uniquePaths = Array.from(
    new Set(
      rawUrls
        .map((rawUrl) => extractItemImageObjectPath(rawUrl ?? null))
        .filter((path): path is string => Boolean(path)),
    ),
  );

  const signedUrlEntries = await Promise.all(
    uniquePaths.map(async (path) => {
      const signedUrl = await createSignedUrlByPath(supabase, path, expiresIn);
      return signedUrl ? [path, signedUrl] as const : null;
    }),
  );

  const signedUrlByPath = new Map<string, string>(
    signedUrlEntries.filter((entry): entry is readonly [string, string] => entry !== null),
  );

  return rawUrls
    .map((rawUrl) => {
      if (!rawUrl) {
        return null;
      }

      const path = extractItemImageObjectPath(rawUrl);
      if (!path) {
        return rawUrl;
      }

      return signedUrlByPath.get(path) ?? rawUrl;
    })
    .filter((url): url is string => Boolean(url));
}

export async function signItemImageFields<T extends { image_url?: string | null; image_urls?: string[] | null }>(
  supabase: SupabaseClient,
  row: T,
): Promise<T> {
  const sourceImageUrls = Array.isArray(row.image_urls) ? row.image_urls : [];
  const [nextImageUrl = null, ...nextImageUrls] = await signItemImageUrls(
    supabase,
    [row.image_url ?? null, ...sourceImageUrls],
  );

  return {
    ...row,
    image_url: nextImageUrl,
    image_urls: nextImageUrls,
  };
}
