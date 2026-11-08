// 10分ごとに pg_cron＋pg_net から POST で呼ばれる（計画2 Task 10。登録は supabase/pending/schedule_accounting_post.sql）。
// Webhook の worker と各画面の操作が流す係の取りこぼしを拾う。認可・heartbeat・監査は stripe-reconcile の route の形。
import { NextResponse } from 'next/server';
import { runAccountingPosting } from '@/lib/accounting/posting-runner';
import { countOpenPendingEvents } from '@/lib/accounting/posting-store';
import { logAudit } from '@/lib/audit';
import { authorizeCronRequest } from '@/lib/cron/auth';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';

// 係を最大20回まで繰り返す。pg_net は60秒で待つのをやめるが実行は続く（成功か失敗かは ops_job_heartbeats が正）。
export const maxDuration = 120;

/** 最後の成功・失敗を記録する（見回りが30分止まったかを見る）。記録の失敗で応答を変えない。 */
async function recordRun(store: OpsStore | null, succeeded: boolean, errorCode: string | null): Promise<void> {
  if (!store) return;
  try {
    await recordHeartbeat(store, 'accounting_post', succeeded, errorCode);
  } catch (error) {
    console.error('[accounting-post] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }
}

export async function POST(request: Request) {
  if (!authorizeCronRequest(request, 'accounting-post').ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let store: OpsStore | null = null;
  try {
    const database = await createServiceRoleClient();
    store = database as unknown as OpsStore;
    const result = await runAccountingPosting(database);
    const openPending = await countOpenPendingEvents(database);
    const data = { ...result, openPending };

    // 件数だけを残す（金額・注文・お客様の情報は載せない）
    await logAudit({
      action: 'accounting.post',
      resource: 'accounting',
      outcome: 'success',
      detail: 'Accounting posting',
      metadata: { ...result, openPending },
    });
    await recordRun(store, true, null);
    return NextResponse.json({ data });
  } catch (error) {
    const cause = webhookFailureCause(error);
    console.error('[accounting-post] Posting failed', cause);
    await recordRun(store, false, cause);
    return NextResponse.json({ error: 'Posting failed' }, { status: 502 });
  }
}
