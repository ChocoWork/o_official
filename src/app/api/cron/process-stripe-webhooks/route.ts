import { NextResponse } from 'next/server';
import { authorizeCronRequest } from '@/lib/cron/auth';
import { runWebhookWorker } from '@/lib/stripe/webhook-worker';

export const maxDuration = 60;

/** 毎分の定期処理（pg_cron＋pg_net）から呼ばれる worker の入口（設計書 2026-10-05 グループ B の 3-1・4-1） */
export async function POST(request: Request): Promise<NextResponse> {
  if (!authorizeCronRequest(request, 'process-stripe-webhooks').ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runWebhookWorker({ requestUrl: request.url });
  return NextResponse.json(
    { processed: result.processed, failed: result.failed, stoppedBy: result.stoppedBy },
    { status: result.stoppedBy === 'claim_error' ? 502 : 200 },
  );
}
