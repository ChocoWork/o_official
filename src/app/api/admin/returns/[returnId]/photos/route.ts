import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { signReturnPhotoUrls } from '@/lib/orders/returns/return-photo-storage';
import { respondToReturnReadError } from '@/lib/orders/returns/return-route-support';
import { listReturnPhotos } from '@/lib/orders/returns/return-store';
import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * 申し込みの写真の一覧（グループ E-3 段2、設計書 5-2・11-1）。申し込みを確かめる画面を開いた時に読む。
 * 返品の権限の人（店長とサポート）だけが読める。読むだけなので CSRF・回数の制限・監査は通さない。
 * 写真は非公開の置き場にあるので、10分だけ使える署名つきのリンクを付けて返す（消した写真は url が null）。
 * 答えは 写真の番号・返品の行の番号・リンク・消したか の4つだけ（置き場の場所は返さない）。リンクは中に鍵が入るので、
 * ログにも誤りの答えにも出さない（失敗のログは例外名と DB の記号だけ）。キャッシュさせない。
 */
export async function GET(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.return', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { returnId } = await params;
  const parsedId = z.string().uuid().safeParse(returnId);
  if (!parsedId.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const client = await createServiceRoleClient();
    const refs = await listReturnPhotos(client, parsedId.data);
    const signed = await signReturnPhotoUrls(client, refs);
    const photos = signed.map(({ photoId, returnLineId, url, purged }) => ({ photoId, returnLineId, url, purged }));
    return NextResponse.json({ data: { photos } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return respondToReturnReadError(error, {
      tag: '[admin.orders.return.photos] Failed to load photos',
      failureKind: 'photos',
    });
  }
}
