import type { SupabaseClient } from '@supabase/supabase-js';
import { createCustomerReturnPhotoUpload } from '@/lib/orders/returns/customer-return-store';
import { sanitizeReturnPhoto } from '@/lib/orders/returns/return-photo-sanitize';
import type { ReturnPhotoRef } from '@/lib/orders/returns/return-types';

/**
 * 申し込みの写真の置き場（非公開の入れ物 return-photos）と、写真の送り先の表を扱う（グループ E-3 段2）。サーバーだけで使う。
 * 呼ぶ側は service_role のクライアントを渡す（表の読み取りも置き場の読み書きも、service_role だけができる）。
 *
 * 署名つきの送り先・リンク、置き場の場所、DB の文は、ログ・投げる誤りに入れない（鍵や宛先が混ざりうる）。
 * 思いがけない失敗は ReturnPhotoStorageError の code（置き場か DB か）と固定の操作名だけで伝える。
 * 単体テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */
export const RETURN_PHOTO_BUCKET = 'return-photos';
/** お店が写真を見るリンクの有効な長さ（秒）。10分 */
export const RETURN_PHOTO_VIEW_SECONDS = 600;
/** 消す処理が1回に扱う送り先と写真の数（合わせて）。DB の関数の上限と同じ */
export const RETURN_PHOTO_PURGE_BATCH = 500;

/** 送り先の表を1回の問い合わせで引く番号の数（番号を並べた URL が長くなりすぎないように） */
const LOOKUP_CHUNK_SIZE = 50;
/** 1回でリンクを作る写真の数 */
const SIGN_CHUNK_SIZE = 100;
/** 置き場の窓口が1回で消せる数 */
const REMOVE_CHUNK_SIZE = 1000;
/**
 * 申し込みに使われないままの送り先を、この長さを過ぎたら期限切れとして断る。消す処理は作ってから1日を過ぎた物を消すので、
 * 1時間の余裕を見る（消す処理と申し込みが重なって、申し込みに付けた写真の中身だけが消える事故を防ぐ）。
 * 使い済みの送り先は、古くても断らない（送り直しのため）
 */
const UNATTACHED_UPLOAD_MAX_AGE_MS = 23 * 60 * 60 * 1000;
/** 写真の確かめで、置き場の読み書きを同時に始める数。10MiB までの写真を何枚も同時にメモリへ載せず、1枚ずつで時間がかかりすぎることも避ける */
const VERIFY_CONCURRENCY = 4;

export type ReturnPhotoClient = Pick<SupabaseClient, 'rpc' | 'from' | 'storage'>;

type PhotoBucket = ReturnType<ReturnPhotoClient['storage']['from']>;
type VerifiedReturnPhoto = { contentType: 'image/jpeg' | 'image/png'; sizeBytes: number };

/** 置き場か DB が思いがけず失敗した。窓口は想定外の失敗として扱う（写真が合わないこととは分ける） */
export class ReturnPhotoStorageError extends Error {
  constructor(
    readonly code: 'storage_unavailable' | 'db_unavailable',
    readonly operation: string,
  ) {
    super(`return photo ${operation} failed`);
    this.name = 'ReturnPhotoStorageError';
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * 写真の送り先を出す。持ち主・受付・1日の数の上限の確かめと、送り先の行を足すのは DB の関数（断りは ReturnStoreError、
 * 注文が無い・持ち主でない時は CustomerOrderNotFoundError で、窓口が答えにする）。
 * 場所は上書きできない形（upsert: false）で署名する。有効は2時間（Supabase の決まり）。
 */
export async function issueReturnPhotoUpload(
  client: ReturnPhotoClient,
  input: { orderId: string; customerId: string },
): Promise<{ uploadId: string; signedUrl: string }> {
  const { uploadId, storagePath } = await createCustomerReturnPhotoUpload(client, input);
  const { data, error } = await client.storage
    .from(RETURN_PHOTO_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
  if (error || !data?.signedUrl) {
    throw new ReturnPhotoStorageError('storage_unavailable', 'create_signed_upload_url');
  }
  return { uploadId, signedUrl: data.signedUrl };
}

/** この注文・このお客様の、使える送り先の場所。無い物・ほかのお客様の物・消した物・期限切れの物は入らない */
async function readOwnUploadPaths(
  client: ReturnPhotoClient,
  input: { orderId: string; customerId: string },
  uploadIds: string[],
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const expiredBefore = Date.now() - UNATTACHED_UPLOAD_MAX_AGE_MS;
  for (const ids of chunk(uploadIds, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await client
      .from('order_return_photo_uploads')
      .select('id, storage_path, created_at, attached_at, purged_at')
      .in('id', ids)
      .eq('order_id', input.orderId)
      .eq('customer_id', input.customerId);
    if (error) {
      throw new ReturnPhotoStorageError('db_unavailable', 'read_uploads');
    }
    const rows = (data ?? []) as Array<{
      id?: unknown;
      storage_path?: unknown;
      created_at?: unknown;
      attached_at?: unknown;
      purged_at?: unknown;
    }>;
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.storage_path !== 'string' || row.purged_at) continue;
      const createdAt = typeof row.created_at === 'string' ? Date.parse(row.created_at) : Number.NaN;
      if (!row.attached_at && !(createdAt >= expiredBefore)) continue;
      paths.set(row.id, row.storage_path);
    }
  }
  return paths;
}

/**
 * 1枚の写真を置き場から読んで確かめ、撮影の情報があれば消した写しを同じ場所に置き直す。
 * 写真として合わない（置き場に無い・画像でない・作りが壊れている・大きすぎる）時は null。置き場の不調は止める。
 */
async function verifyAndCleanPhoto(bucket: PhotoBucket, storagePath: string): Promise<VerifiedReturnPhoto | null> {
  const { data, error } = await bucket.download(storagePath);
  if (error) {
    // 署名つきの送り先に送られていない写真は、その写真だけ合わない。置き場の不調は写真のせいにしない
    if (error.status === 404 || error.statusCode === '404') return null;
    throw new ReturnPhotoStorageError('storage_unavailable', 'download');
  }
  const sanitized = sanitizeReturnPhoto(new Uint8Array(await data.arrayBuffer()));
  if (!sanitized.ok) return null;
  if (sanitized.changed) {
    // 消した写しを置く。署名つきの送り先は上書きできない形（createSignedUploadUrl の upsert: false。置き場の側がその印で決める）
    // なので、お客様が後から元の写真に戻すことはできない。この前提は本物の置き場で Task 14 の E2E が確かめる
    const { error: replaceError } = await bucket.upload(storagePath, sanitized.bytes, {
      contentType: sanitized.contentType,
      upsert: true,
    });
    if (replaceError) {
      throw new ReturnPhotoStorageError('storage_unavailable', 'replace');
    }
  }
  return { contentType: sanitized.contentType, sizeBytes: sanitized.bytes.length };
}

/**
 * 申し込みに使う写真を、DB を呼ぶ前に確かめる。送り先の表を service_role で読み（この注文・このお客様の、消していない送り先だけ）、
 * 置き場から4枚ずつ読んで、先頭の印・大きさ・作りを確かめ、撮影の情報を消す。消した物があれば同じ場所に置き直す。
 * 使い済み（attached_at）の送り先は止めない（通信が切れた後の送り直しのため。別の返品の写真かどうかは DB が断る）。
 * 申し込みに使われないまま23時間たった送り先は、期限切れとして断る（消す処理が消す1日より前）。
 * 戻す大きさ・種類は、撮影の情報を消した後の写しの物（DB の写真の行に残る）。
 */
export async function verifyReturnPhotoUploads(
  client: ReturnPhotoClient,
  input: { orderId: string; customerId: string; uploadIds: string[] },
): Promise<
  | { ok: true; photos: Record<string, VerifiedReturnPhoto> }
  | { ok: false; invalidUploadIds: string[] }
> {
  const uploadIds = [...new Set(input.uploadIds)];
  if (uploadIds.length === 0) {
    return { ok: true, photos: {} };
  }
  const paths = await readOwnUploadPaths(client, input, uploadIds);
  const bucket = client.storage.from(RETURN_PHOTO_BUCKET);
  const photos: Record<string, VerifiedReturnPhoto> = {};
  const invalidUploadIds: string[] = [];
  // 数枚ずつ確かめる。結果は渡された順に並べる（合わない番号の並びが毎回同じになる）
  for (const group of chunk(uploadIds, VERIFY_CONCURRENCY)) {
    const verified = await Promise.all(
      group.map((uploadId) => {
        const storagePath = paths.get(uploadId);
        return storagePath ? verifyAndCleanPhoto(bucket, storagePath) : null;
      }),
    );
    group.forEach((uploadId, index) => {
      const photo = verified[index];
      if (photo) {
        photos[uploadId] = photo;
      } else {
        invalidUploadIds.push(uploadId);
      }
    });
  }
  return invalidUploadIds.length > 0 ? { ok: false, invalidUploadIds } : { ok: true, photos };
}

/**
 * お店が写真を見るためのリンクを作る（10分だけ使える）。消した写真は置き場に問い合わせず url なし（purged: true）。
 * リンクを作れなかった写真も url なし（purged: false。画面は「写真を読み込めませんでした。」）。置き場の不調で一覧ごとは落とさない。
 */
export async function signReturnPhotoUrls(
  client: ReturnPhotoClient,
  photos: ReturnPhotoRef[],
): Promise<Array<{ photoId: string; returnLineId: string; url: string | null; purged: boolean }>> {
  const urlByPath = new Map<string, string>();
  const bucket = client.storage.from(RETURN_PHOTO_BUCKET);
  const livePaths = photos.filter((photo) => !photo.purged).map((photo) => photo.storagePath);
  for (const paths of chunk(livePaths, SIGN_CHUNK_SIZE)) {
    const { data, error } = await bucket.createSignedUrls(paths, RETURN_PHOTO_VIEW_SECONDS);
    if (error) {
      console.error('[return-photo] createSignedUrls failed', error.status ?? null);
      continue;
    }
    for (const entry of data) {
      if (entry.path && entry.signedUrl && !entry.error) {
        urlByPath.set(entry.path, entry.signedUrl);
      }
    }
  }
  return photos.map((photo) => ({
    photoId: photo.photoId,
    returnLineId: photo.returnLineId,
    url: photo.purged ? null : (urlByPath.get(photo.storagePath) ?? null),
    purged: photo.purged,
  }));
}

type PurgeKind = 'upload' | 'photo';
type PurgeTarget = { kind: PurgeKind; id: string; storagePath: string };

function toPurgeTargets(data: unknown): PurgeTarget[] {
  if (!Array.isArray(data)) return [];
  const targets: PurgeTarget[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const kind = row.target_kind;
    if ((kind === 'upload' || kind === 'photo') && typeof row.target_id === 'string' && typeof row.storage_path === 'string') {
      targets.push({ kind, id: row.target_id, storagePath: row.storage_path });
    }
  }
  return targets;
}

/**
 * 消す時期が来た送り先（申し込みに使われないまま1日）と写真（返品が終わって90日）を、置き場の窓口（remove）で消して印を付ける。
 * SQL で storage.objects を消しても中身（blob）は残るので、必ずこの窓口で消す。
 * 置き場から消せた分だけに印（purged_at）を付ける。消せなかった分は印を付けず、次の回にまた対象になる。
 * 返すのは印を付けた数。置き場の消去が1つでも失敗したら、残りを続けた後で storage_unavailable で止める。
 */
export async function purgeReturnPhotos(client: ReturnPhotoClient): Promise<{ uploads: number; photos: number }> {
  const { data, error } = await client.rpc('list_return_photo_purge_targets', { _limit: RETURN_PHOTO_PURGE_BATCH });
  if (error) {
    throw new ReturnPhotoStorageError('db_unavailable', 'list_purge_targets');
  }
  const targets = toPurgeTargets(data);
  const bucket = client.storage.from(RETURN_PHOTO_BUCKET);
  const marked: Record<PurgeKind, number> = { upload: 0, photo: 0 };
  let removalFailed = false;
  for (const kind of ['upload', 'photo'] as const) {
    for (const batch of chunk(targets.filter((target) => target.kind === kind), REMOVE_CHUNK_SIZE)) {
      const { error: removeError } = await bucket.remove(batch.map((target) => target.storagePath));
      if (removeError) {
        removalFailed = true;
        continue;
      }
      const { data: count, error: markError } = await client.rpc('mark_return_photo_targets_purged', {
        _target_kind: kind,
        _ids: batch.map((target) => target.id),
      });
      if (markError || typeof count !== 'number') {
        throw new ReturnPhotoStorageError('db_unavailable', 'mark_purged');
      }
      marked[kind] += count;
    }
  }
  if (removalFailed) {
    throw new ReturnPhotoStorageError('storage_unavailable', 'remove');
  }
  return { uploads: marked.upload, photos: marked.photo };
}
