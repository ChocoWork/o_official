/**
 * 手元の Supabase の Storage に、見本データ（supabase/seed.sql）が指す仮の画像を置く（設計書 2026-10-05 グループ B の 7-4）。
 * seed.sql は表の行と bucket を作るが、画像の中身（ファイル）は Storage の API でしか置けないので、E2E の前にここで置く。
 * 何度動かしても同じ結果になる（upsert）。手元以外の住所なら置かずに止める。
 */
import { createClient } from '@supabase/supabase-js';
import { isLocalUrl, type EnvRecord } from './environment';

/** 12×16 の薄い灰色の PNG（架空の画像） */
export const SEED_IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAQCAIAAACtAwlQAAAAFUlEQVR42mO4dvkMQcQwqmhUEXGKAJ+/19DGXw+VAAAAAElFTkSuQmCC';

const ITEM_IDS = [1, 3, 4, 5, 6, 7, 8, 9, 10];
const LOOK_IDS = [1, 2, 3, 4, 5, 6, 7];
const NEWS_IDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** seed.sql の行が指す画像（bucket ごとの相対パス）。seed.sql を変えたら、ここも変える（テストが食い違いを止める）。 */
export const SEED_STORAGE_OBJECTS: ReadonlyArray<{ bucket: string; path: string }> = [
  ...ITEM_IDS.flatMap((id) => [1, 2].map((n) => ({ bucket: 'item-images', path: `e2e/item-${id}-${n}.png` }))),
  ...LOOK_IDS.flatMap((id) => [1, 2].map((n) => ({ bucket: 'look-images', path: `e2e/look-${id}-${n}.png` }))),
  ...NEWS_IDS.map((id) => ({ bucket: 'news-images', path: `e2e/news-${id}.png` })),
];

export type StorageClient = {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Buffer,
        options: { contentType: string; upsert: boolean },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
};

function createStorageClient(url: string, key: string): StorageClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as StorageClient;
}

export async function seedLocalStorage(
  env: EnvRecord,
  makeClient: (url: string, key: string) => StorageClient = createStorageClient,
): Promise<number> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('E2E の見張り: 手元の Supabase 以外には見本の画像を置きません。');
  }

  const client = makeClient(url, key);
  const body = Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64');
  for (const object of SEED_STORAGE_OBJECTS) {
    const { error } = await client.storage
      .from(object.bucket)
      .upload(object.path, body, { contentType: 'image/png', upsert: true });
    if (error) {
      throw new Error(`見本の画像を置けませんでした: ${object.bucket}/${object.path}（${error.message}）`);
    }
  }
  return SEED_STORAGE_OBJECTS.length;
}
