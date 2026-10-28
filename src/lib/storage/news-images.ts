import type { SupabaseClient } from '@supabase/supabase-js';
import { parseOwnObjectPath } from '@/lib/storage/safe-object-path';

const NEWS_IMAGES_BUCKET = 'news-images';
const NEWS_IMAGES_PREFIX = 'news';
const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

function normalizeObjectPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, '');
  if (trimmed.startsWith(`${NEWS_IMAGES_BUCKET}/`)) {
    return trimmed.slice(NEWS_IMAGES_BUCKET.length + 1);
  }

  return trimmed;
}

/**
 * 画像の値（保存の道か Storage の URL）から、置き場 news-images の中の道を取り出す。
 *
 * @impl IMPL-NEWS-164
 * @design DD-NEWS-067
 * @remarks 表の image_url には保存の道のほか、置き場を公開にしていた頃の public の URL や署名つき URL の形が残りうるので、どの形からも道を取り出してから置き場の後始末に渡す（ARC-NEWS-003、DATA-NEWS-004）。取り出せない値は null にして、消す物と分ける。host と接頭辞は確かめない: 署名の前の確かめは parseOwnObjectPath が、消す前の確かめは isOwnNewsImagePath が行う。
 */
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

/** 失敗の種類だけを残す。道筋・URL・Supabase の誤りの文は書かない。 */
function warnSigningFailure(kind: 'invalid_path' | 'sign_failed'): void {
  console.warn(`[news-images] ${kind}`);
}

/**
 * 画像の値を、置き場 news-images の期限つきの署名つき URL に置き換える。
 *
 * @impl IMPL-NEWS-165
 * @design DD-NEWS-068
 * @remarks 置き場を非公開のまま画像を見せるため読むたびに署名し、記事を非公開にした後に画像を開ける時間を期限（初めは1時間）で区切る（ARC-NEWS-003、SEC-NEWS-004）。
 * 署名は service role で行うので置き場の方針が効かない。自分のプロジェクトの置き場の news/ の下の安全な道筋だけを署名し、
 * 道筋が取れない時と署名に失敗した時は null を返して、外の URL や壊れた参照を元の値のまま呼び元へ渡さない（SEC-NEWS-007・008）。
 */
export async function signNewsImageUrl(
  supabase: SupabaseClient,
  rawUrl: string | null | undefined,
  expiresIn: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string | null> {
  if (!rawUrl) {
    return null;
  }

  const path = parseOwnObjectPath(rawUrl, { bucket: NEWS_IMAGES_BUCKET, prefix: NEWS_IMAGES_PREFIX });
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
 * 行の写しを作り、image_url だけを署名つき URL に置き換えて返す。
 *
 * @impl IMPL-NEWS-166
 * @design DD-NEWS-068
 * @remarks 行の置き換えを1つにまとめ、管理・公開・検索の全部で同じ取り出しと期限を使う（DATA-NEWS-004）。
 */
export async function signNewsImageFields<T extends { image_url?: string | null }>(
  supabase: SupabaseClient,
  row: T,
): Promise<T> {
  return {
    ...row,
    image_url: await signNewsImageUrl(supabase, row.image_url ?? null),
  };
}