// Utilities for generating signed URLs for the private look-images bucket.
// The bucket is private (migration 030), so all image access goes through
// time-limited signed URLs generated server-side with the service role client.

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseOwnObjectPath } from '@/lib/storage/safe-object-path';

const LOOK_IMAGES_BUCKET = 'look-images';
const LOOK_IMAGES_PREFIX = 'looks';

// 1-hour expiry is sufficient for a single page render; short enough to limit
// the exposure window if a URL leaks for an unpublished look.
export const DEFAULT_LOOK_IMAGE_SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

/**
 * 置き場の中の画像の道筋を、素の道筋か古い公開 URL から取り出す（例: looks/2024-01-01/uuid.jpg）。
 * 道筋に直せない入力には null を返す。
 *
 * @impl IMPL-LOOK-121
 * @design DD-LOOK-006
 * @remarks 置き場を非公開にする前（移行 030）に入れた公開 URL と、後に入れた素の道筋が DB に混ざっているため、
 * 両方を受けて呼び元に移り変わりを意識させない。
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

/** 失敗の種類だけを残す。道筋・URL・Supabase の誤りの文は書かない。 */
function warnSigningFailure(kind: 'invalid_path' | 'sign_failed'): void {
  console.warn(`[look-images] ${kind}`);
}

/**
 * 1枚の LOOK の画像から、期限つきの署名つき URL を作る。
 *
 * @impl IMPL-LOOK-122
 * @design DD-LOOK-006
 * @remarks 署名は service role で行うので置き場の方針が効かない。自分のプロジェクトの置き場の looks/ の下の安全な道筋だけを署名し、
 * 道筋が取れない時と署名に失敗した時は null を返して、外の URL や壊れた参照を元の値のまま呼び元へ渡さない（SEC-LOOK-007・008）。
 */
export async function signLookImageUrl(
  supabase: SupabaseClient,
  rawUrl: string | null | undefined,
  expiresIn: number = DEFAULT_LOOK_IMAGE_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string | null> {
  if (!rawUrl) {
    return null;
  }

  const path = parseOwnObjectPath(rawUrl, { bucket: LOOK_IMAGES_BUCKET, prefix: LOOK_IMAGES_PREFIX });
  if (!path) {
    warnSigningFailure('invalid_path');
    return null;
  }

  const signedUrl = await createSignedUrlByPath(supabase, path, expiresIn);
  if (!signedUrl) {
    warnSigningFailure('sign_failed');
  }
  return signedUrl;
}

/**
 * LOOK の画像の道筋・URL の配列を、まとめて署名つき URL にする。値が空・道筋にできない・署名に失敗したものは結果から除く。
 *
 * @impl IMPL-LOOK-123
 * @design DD-LOOK-006
 * @remarks 画像ごとの署名は互いに待たなくてよいので、全部を同時に走らせる。除いた物の代わりに元の値は入れない。
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
