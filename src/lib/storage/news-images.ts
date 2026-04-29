import type { SupabaseClient } from '@supabase/supabase-js';

const NEWS_IMAGES_BUCKET = 'news-images';
const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

function normalizeObjectPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, '');
  if (trimmed.startsWith(`${NEWS_IMAGES_BUCKET}/`)) {
    return trimmed.slice(NEWS_IMAGES_BUCKET.length + 1);
  }

  return trimmed;
}

export function extractNewsImageObjectPath(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return null;
  }

  const value = rawUrl.trim();

  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return normalizeObjectPath(value);
  }

  try {
    const parsed = new URL(value);
    const candidates = [
      `/storage/v1/object/public/${NEWS_IMAGES_BUCKET}/`,
      `/storage/v1/object/sign/${NEWS_IMAGES_BUCKET}/`,
      `/storage/v1/object/authenticated/${NEWS_IMAGES_BUCKET}/`,
    ];

    for (const marker of candidates) {
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex < 0) {
        continue;
      }

      const rawPath = parsed.pathname.slice(markerIndex + marker.length);
      if (rawPath.length === 0) {
        return null;
      }

      return normalizeObjectPath(decodeURIComponent(rawPath));
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
  const { data, error } = await supabase.storage
    .from(NEWS_IMAGES_BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

export async function signNewsImageUrl(
  supabase: SupabaseClient,
  rawUrl: string | null | undefined,
  expiresIn: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string | null> {
  if (!rawUrl) {
    return null;
  }

  const path = extractNewsImageObjectPath(rawUrl);
  if (!path) {
    return rawUrl;
  }

  const signedUrl = await createSignedUrlByPath(supabase, path, expiresIn);
  return signedUrl ?? rawUrl;
}

export async function signNewsImageFields<T extends { image_url?: string | null }>(
  supabase: SupabaseClient,
  row: T,
): Promise<T> {
  return {
    ...row,
    image_url: await signNewsImageUrl(supabase, row.image_url ?? null),
  };
}