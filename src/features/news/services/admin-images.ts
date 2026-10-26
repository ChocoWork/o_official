/**
 * 管理のニュースの画像の確かめ・保存名・後始末（src/features/news/services/admin-images.ts）。
 *
 * @packageDocumentation
 * @design DD-NEWS-071
 * @remarks 画像の扱いを窓口（作成・更新・削除）で同じにそろえる。置き場は service role で書くので、
 * 申告の種類を鵜呑みにせず、保存名も送られた名前から作らず、後始末で消す道筋は自分の置き場の自分の接頭辞の下だけにする。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { resolveUploadImageType, type DetectedImageType } from '@/lib/storage/image-signature';
import { extractNewsImageObjectPath } from '@/lib/storage/news-images';

export const NEWS_IMAGE_BUCKET = 'news-images';

export type PreparedNewsImage = { buffer: Buffer; contentType: DetectedImageType; extension: string };

/**
 * File を読み、申告の type と先頭の印が同じ時だけ返す。違えば null（呼び手が 400 'Unsupported image type'）。
 *
 * @impl IMPL-NEWS-170
 * @design DD-NEWS-071
 * @remarks 申告の type は送り手が決められるので、偽の画像を置き場に書かせないよう、書く前に中身の印で確かめる。
 * 保存名の拡張子は検出した種類の対応表から作り、送られた名前は使わない。
 */
export async function prepareNewsImage(image: File): Promise<PreparedNewsImage | null> {
  const buffer = Buffer.from(await image.arrayBuffer());
  const resolved = resolveUploadImageType(image.type, buffer);
  if (!resolved) {
    return null;
  }
  return { buffer, contentType: resolved.type, extension: resolved.extension };
}

/**
 * news/YYYY-MM-DD/<uuid>.<extension> の保存名を作る（日付は UTC の ISO。now は試験用）。
 *
 * @impl IMPL-NEWS-171
 * @design DD-NEWS-071
 * @remarks 利用者の入力（ファイル名）を道筋に混ぜず、日付と乱数だけで作る。
 */
export function buildNewsImagePath(extension: string, now: Date = new Date()): string {
  return `news/${now.toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
}

const OWN_NEWS_IMAGE_PATH = /^news\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * 自分の置き場の自分の接頭辞（news/）の下の安全な文字だけの道筋なら true。
 *
 * @impl IMPL-NEWS-172
 * @design DD-NEWS-071
 * @remarks 行の image_url には古い見本の道筋や外の URL が混ざりうる。消す側が service role なので、
 * 1本ずつ確かめて、'..'・先頭の '/'・別の接頭辞・URL を消す対象にしない（古い見本は消さない側に倒れる）。
 */
export function isOwnNewsImagePath(path: string): boolean {
  return OWN_NEWS_IMAGE_PATH.test(path);
}

/**
 * 行の image_url（古い公開 URL の形も可）を道筋に直し、自分の道筋だけを置き場から消す。keep に含まれる物は消さない。
 * 消す物が無ければ置き場を呼ばず ok。失敗は名前と符号だけ記録して 'failed' を返し、投げない。
 *
 * @impl IMPL-NEWS-173
 * @design DD-NEWS-071
 * @remarks 行の変更が済んだ後の後始末なので、置き場の失敗で応答を失敗にしない。呼び手が監査に結果を残す。
 * 同じ道筋が新旧に残る時は、行が今も指しているので消さない。
 */
export async function removeNewsImages(
  supabase: SupabaseClient,
  rawUrls: readonly (string | null | undefined)[],
  keep: readonly string[] = [],
): Promise<'ok' | 'failed'> {
  const kept = new Set(keep);
  const paths: string[] = [];
  for (const raw of rawUrls) {
    const path = extractNewsImageObjectPath(raw);
    if (path && isOwnNewsImagePath(path) && !kept.has(path) && !paths.includes(path)) {
      paths.push(path);
    }
  }

  if (paths.length === 0) {
    return 'ok';
  }

  try {
    const { error } = await supabase.storage.from(NEWS_IMAGE_BUCKET).remove(paths);
    if (error) {
      console.error('Failed to remove news images:', describeErrorForLog(error));
      return 'failed';
    }
    return 'ok';
  } catch (error) {
    console.error('Failed to remove news images:', describeErrorForLog(error));
    return 'failed';
  }
}
