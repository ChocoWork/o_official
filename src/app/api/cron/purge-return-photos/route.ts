// 毎日1回、pg_cron＋pg_net から POST で呼ばれる（グループ E-3 段2。登録はアプリを公開する時に保留の SQL
// supabase/pending/schedule_return_photo_purge.sql で行う）。
// 申し込みに使われないまま1日たった写真の送り先と、返品が終わって90日たった写真を、置き場の窓口で消して印を付ける。
// 最後の成功は見回りの印 return_photo_purge に残り、49時間より古くなれば「定期処理が止まったとき」の知らせが出る。
import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { authorizeCronRequest } from '@/lib/cron/auth';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { purgeReturnPhotos } from '@/lib/orders/returns/return-photo-storage';
import { createServiceRoleClient } from '@/lib/supabase/server';

// 1回に扱うのは500件まで。置き場の消去と印付けは数秒で終わるので、余裕を見て60秒
export const maxDuration = 60;

export type PurgeReturnPhotosResponse = { uploads: number; photos: number };

type PurgeFailureCause = 'storage_unavailable' | 'db_unavailable' | 'unexpected_error';

/** 失敗の原因の記号。例外の文には置き場の場所などが混ざりうるので、記号だけを残す */
function failureCause(error: unknown): PurgeFailureCause {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null;
  return code === 'storage_unavailable' || code === 'db_unavailable' ? code : 'unexpected_error';
}

/** 最後の成功・失敗を記録する（止まった知らせの点検が読む）。記録の失敗で応答を変えない。 */
async function recordRun(store: OpsStore | null, succeeded: boolean, errorCode: string | null): Promise<void> {
  if (!store) return;
  try {
    await recordHeartbeat(store, 'return_photo_purge', succeeded, errorCode);
  } catch (error) {
    console.error('[purge-return-photos] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }
}

export async function POST(request: Request) {
  if (!authorizeCronRequest(request, 'purge-return-photos').ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let store: OpsStore | null = null;
  try {
    const client = await createServiceRoleClient();
    store = client as unknown as OpsStore;
    const data: PurgeReturnPhotosResponse = await purgeReturnPhotos(client);
    // 監査に残すのは数だけ（置き場の場所・写真の番号は残さない）
    await logAudit({
      action: 'orders.return_photos.purge',
      resource: 'order_return_photos',
      outcome: 'success',
      detail: 'Return photo purge',
      metadata: { uploads: data.uploads, photos: data.photos },
    });
    await recordRun(store, true, null);
    return NextResponse.json({ data });
  } catch (error) {
    const cause = failureCause(error);
    console.error('[purge-return-photos] Purge failed', cause);
    await logAudit({
      action: 'orders.return_photos.purge',
      resource: 'order_return_photos',
      outcome: 'error',
      detail: cause,
    });
    await recordRun(store, false, cause);
    return NextResponse.json({ error: 'Purge failed' }, { status: 502 });
  }
}
