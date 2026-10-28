/**
 * 公開の LOOK の og:image の窓口（src/app/look/[id]/og/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-157
 * @design DD-LOOK-071
 * @remarks og:image に期限つきの署名つき URL を入れると、1 時間で切れ、SNS のクローラーにも残る。公開の LOOK だけを匿名の鍵で読み、
 * 検証した道筋のバイトを service role で読んで返す。種類は置き場の申告でなくバイトの先頭の印で決め、画像でなければ 404 にする。
 * 非公開・無い・不正な id・画像なし・置き場の失敗はすべて同じ 404 にして、有無と置き場の誤りを外へ出さない。
 * Cookie は付けず、共有キャッシュに載る公開の応答に識別子を混ぜない。回数制限は付けない（公開の LOOK の数に限られ、s-maxage で CDN が受ける）。
 */
import { parseLookId } from '@/lib/look/public';
import { getPublishedLookCoverRaw } from '@/lib/look/server';
import { detectImageType } from '@/lib/storage/image-signature';
import { parseOwnObjectPath } from '@/lib/storage/safe-object-path';
import { createServiceRoleClient } from '@/lib/supabase/server';

const LOOK_IMAGES_BUCKET = 'look-images';
const LOOK_IMAGES_PREFIX = 'looks';

function notFound(reason: 'not_found' | 'download_failed' | 'not_image'): Response {
  if (reason !== 'not_found') {
    // 記録は固定の種類だけ。道筋・置き場の誤りの文は書かない。
    console.warn(`[look-og] ${reason}`);
  }
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** 公開の LOOK の先頭の画像を、署名つき URL を含まない同一オリジンの URL で返す。 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const lookId = parseLookId(id);
  if (lookId === null) {
    return notFound('not_found');
  }

  const raw = await getPublishedLookCoverRaw(lookId);
  const path = parseOwnObjectPath(raw, { bucket: LOOK_IMAGES_BUCKET, prefix: LOOK_IMAGES_PREFIX });
  if (!path) {
    return notFound('not_found');
  }

  let bytes: Uint8Array;
  try {
    const supabase = await createServiceRoleClient();
    const { data, error } = await supabase.storage.from(LOOK_IMAGES_BUCKET).download(path);
    if (error || !data) {
      return notFound('download_failed');
    }
    bytes = new Uint8Array(await data.arrayBuffer());
  } catch {
    return notFound('download_failed');
  }

  const type = detectImageType(bytes);
  if (!type) {
    return notFound('not_image');
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
