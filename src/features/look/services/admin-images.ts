/**
 * 管理の LOOK の画像の確かめ・保存名・後始末（src/features/look/services/admin-images.ts）。
 *
 * @packageDocumentation
 * @design DD-LOOK-070
 * @remarks 画像の扱いを窓口（作成・更新・削除）で同じにそろえる。置き場は service role で書くので、
 * 申告の種類を鵜呑みにせず、保存名も送られた名前から作らず、後始末で消す道筋は自分の置き場の自分の接頭辞の下だけにする。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { resolveUploadImageType, type DetectedImageType } from '@/lib/storage/image-signature';
import { extractLookImageObjectPath } from '@/lib/storage/look-images';

export const LOOK_IMAGE_BUCKET = 'look-images';

export type PreparedLookImage = { buffer: Buffer; contentType: DetectedImageType; extension: string };

/**
 * File を読み、申告の type と先頭の印が同じ時だけ返す。違えば null（呼び手が 400 'Unsupported image type'）。
 *
 * @impl IMPL-LOOK-151
 * @design DD-LOOK-070
 * @remarks 申告の type は送り手が決められるので、偽の画像で置き場と量の枠を使わせないよう、書く前に中身の印で確かめる。
 * 保存名の拡張子は検出した種類の対応表から作り、送られた名前は使わない。
 */
export async function prepareLookImage(image: File): Promise<PreparedLookImage | null> {
  const buffer = Buffer.from(await image.arrayBuffer());
  const resolved = resolveUploadImageType(image.type, buffer);
  if (!resolved) {
    return null;
  }
  return { buffer, contentType: resolved.type, extension: resolved.extension };
}

/**
 * looks/YYYY-MM-DD/<uuid>.<extension> の保存名を作る（日付は UTC の ISO。now は試験用）。
 *
 * @impl IMPL-LOOK-152
 * @design DD-LOOK-070
 * @remarks 利用者の入力（ファイル名）を道筋に混ぜず、日付と乱数だけで作る。
 */
export function buildLookImagePath(extension: string, now: Date = new Date()): string {
  return `looks/${now.toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
}

const OWN_LOOK_IMAGE_PATH = /^looks\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * 自分の置き場の自分の接頭辞（looks/）の下の安全な文字だけの道筋なら true。
 *
 * @impl IMPL-LOOK-153
 * @design DD-LOOK-070
 * @remarks 行の image_urls には古い見本の道筋や外の URL が混ざりうる。消す側が service role なので、
 * 1本ずつ確かめて、'..'・先頭の '/'・別の接頭辞・URL を消す対象にしない（古い見本は消さない側に倒れる）。
 */
export function isOwnLookImagePath(path: string): boolean {
  return OWN_LOOK_IMAGE_PATH.test(path);
}

/**
 * 行の image_urls から、置き場から消してよい道筋を重複なしで返す（keep に含まれる物は除く）。
 *
 * @impl IMPL-LOOK-155
 * @design DD-LOOK-070
 * @remarks 古い公開 URL の形も道筋に直してから確かめる。同じ道筋が新旧に残る時は、行が今も指しているので消さない。
 */
export function listRemovableLookImagePaths(rawUrls: unknown, keep: readonly string[] = []): string[] {
  if (!Array.isArray(rawUrls)) {
    return [];
  }

  const kept = new Set(keep);
  const result: string[] = [];
  for (const raw of rawUrls) {
    if (typeof raw !== 'string') {
      continue;
    }
    const path = extractLookImageObjectPath(raw);
    if (path && isOwnLookImagePath(path) && !kept.has(path) && !result.includes(path)) {
      result.push(path);
    }
  }
  return result;
}

/**
 * 置き場の画像を消す。空なら呼ばない。失敗は名前と符号だけ記録して 'failed' を返し、投げない。
 *
 * @impl IMPL-LOOK-154
 * @design DD-LOOK-070
 * @remarks 行の変更が済んだ後の後始末なので、置き場の失敗で応答を失敗にしない。呼び手が監査に件数を残す。
 */
export async function removeLookImages(
  supabase: SupabaseClient,
  paths: readonly string[],
): Promise<'ok' | 'failed'> {
  if (paths.length === 0) {
    return 'ok';
  }

  try {
    const { error } = await supabase.storage.from(LOOK_IMAGE_BUCKET).remove([...paths]);
    if (error) {
      console.error('Failed to remove look images:', describeErrorForLog(error));
      return 'failed';
    }
    return 'ok';
  } catch (error) {
    console.error('Failed to remove look images:', describeErrorForLog(error));
    return 'failed';
  }
}
