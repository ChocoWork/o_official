import { after, NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  enqueueWebhookEvent,
  webhookErrorCategory,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';
import { isHandledStripeEventType, stripeKeyLivemode } from '@/lib/stripe/handled-webhook-events';
import { recordModeMismatch, recordSignatureFailure, type SignalDeps } from '@/lib/ops/webhook-receiver-signals';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
import type { OpsStore } from '@/lib/ops/ops-store';
import { runWebhookWorker } from '@/lib/stripe/webhook-worker';

// 返事の後に after() で worker を動かすため。時間の配分は Stripe の知らせ35秒＋注文のメール10秒で、
// その後に店への知らせの点検と1時間ごとの配達の見回りが続く（src/lib/stripe/webhook-worker.ts）
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const signalDeps: SignalDeps = {
  store: supabase as unknown as OpsStore,
  send: sendOpsAlertMail,
};

// PUBLIC: Stripe からの知らせの受け取り口。ログインの代わりに Stripe の署名で確かめる。
/**
 * PUBLIC: Stripe の知らせの受け取り口（設計書 2026-10-05 グループ B の 5-1）。
 * 1 署名（時刻の差は5分まで）→ 2 13種か → 3 モードが鍵と合うか → 4 保存（同じ番号は1回だけ）→ 5 200 を返し、after() で worker。
 * 署名の欠落・不一致は400。監査ログに1件ずつ書かず、件数だけ数える（R-05）。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY is not set');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    console.warn('[webhook] Missing stripe-signature header');
    after(() => recordSignatureFailure(signalDeps));
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  const rawBody = Buffer.from(await req.arrayBuffer());
  let event: Stripe.Event;

  try {
    event = getStripeServerClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.warn('[webhook] Signature verification failed', error instanceof Error ? error.name : 'UnknownError');
    after(() => recordSignatureFailure(signalDeps));
    return NextResponse.json(
      { error: 'Webhook signature verification failed' },
      { status: 400 },
    );
  }

  if (!isHandledStripeEventType(event.type)) {
    console.info('[webhook] Ignored event type', event.type);
    return NextResponse.json({ received: true, ignored: true });
  }

  const keyLivemode = stripeKeyLivemode(process.env.STRIPE_SECRET_KEY);
  if (keyLivemode === null) {
    // 鍵は設定されているが、本番でもテストでもない（引用符つきで貼った・pk_ の鍵など）。200 を返すと知らせが失われるので、
    // 500 を返して Stripe に最大3日送り直させる。モード違いの知らせは、数えて店へ知らせる
    console.error('[webhook] STRIPE_SECRET_KEY has an unknown prefix');
    after(() => recordModeMismatch(signalDeps, event.livemode, null));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
  if (event.livemode !== keyLivemode) {
    console.warn('[webhook] Event mode does not match the secret key', event.id);
    after(() => recordModeMismatch(signalDeps, event.livemode, keyLivemode));
    return NextResponse.json({ received: true, ignored: true });
  }

  let inserted: boolean;
  try {
    inserted = await enqueueWebhookEvent(
      supabase as unknown as WebhookEventStore,
      {
        id: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      },
    );
  } catch (error) {
    console.error('[webhook] Failed to persist verified event', event.id, webhookErrorCategory(error));
    return NextResponse.json(
      { error: 'Failed to persist webhook event' },
      { status: 500 },
    );
  }

  // 返事の後に続けて処理する。失敗しても、毎分の定期処理が拾う
  after(() => runWebhookWorker({ requestUrl: req.url }).catch((error: unknown) => {
    console.error('[webhook] Inline worker run failed', webhookErrorCategory(error));
  }));
  return NextResponse.json({ received: true, duplicate: !inserted });
}
