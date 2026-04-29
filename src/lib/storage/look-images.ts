// Utilities for generating signed URLs for the private look-images bucket.
// The bucket is private (migration 030), so all image access goes through
// time-limited signed URLs generated server-side with the service role client.
//
// Handles both legacy public URLs (stored before migration 030) and
// plain file paths (stored after migration 030), so the transition is transparent.

import type { SupabaseClient } from '@supabase/supabase-js';

const LOOK_IMAGES_BUCKET = 'look-images';

// 1-hour expiry is sufficient for a single page render; short enough to limit
// the exposure window if a URL leaks for an unpublished look.
export const DEFAULT_LOOK_IMAGE_SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

/**
 * Extract the storage object path from either a legacy public URL or a plain
 * file path (e.g. "looks/2024-01-01/uuid.jpg").
 * Returns null when the input cannot be resolved to a valid path.
 */
export function extractLookImageObjectPath(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return null;
  }

  const value = rawUrl.trim();

  // Plain file path (stored after migration 030)
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return value.replace(/^\/+/, '');
  }

  // Legacy public URL – extract the object path from the Supabase storage URL
  try {
    const parsed = new URL(value);
    const candidates = [
      `/storage/v1/object/public/${LOOK_IMAGES_BUCKET}/`,
      `/storage/v1/object/sign/${LOOK_IMAGES_BUCKET}/`,
      `/storage/v1/object/authenticated/${LOOK_IMAGES_BUCKET}/`,
    ];

    for (const marker of candidates) {
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex >= 0) {
        const rawPath = parsed.pathname.slice(markerIndex + marker.length);
        if (rawPath.length === 0) {
          return null;
        }
        return decodeURIComponent(rawPath);
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
  const { data, error } = await supabase.storage
    .from(LOOK_IMAGES_BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

/**
 * Generate a signed URL for a single look image.
 * Falls back to the original value when path extraction or signing fails,
 * so callers never receive a broken reference.
 */
export async function signLookImageUrl(
  supabase: SupabaseClient,
  rawUrl: string | null | undefined,
  expiresIn: number = DEFAULT_LOOK_IMAGE_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string | null> {
  if (!rawUrl) {
    return null;
  }

  const path = extractLookImageObjectPath(rawUrl);
  if (!path) {
    return rawUrl;
  }

  const signedUrl = await createSignedUrlByPath(supabase, path, expiresIn);
  return signedUrl ?? rawUrl;
}

/**
 * Generate signed URLs for an array of look image paths/URLs.
 * Preserves array length; nulls and empty strings remain null.
 */
export async function signLookImageUrls(
  supabase: SupabaseClient,
  rawUrls: Array<string | null | undefined>,
  expiresIn: number = DEFAULT_LOOK_IMAGE_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string[]> {
  const results = await Promise.all(
    rawUrls.map((url) => signLookImageUrl(supabase, url, expiresIn)),
  );
  return results.filter((url): url is string => url !== null);
}
