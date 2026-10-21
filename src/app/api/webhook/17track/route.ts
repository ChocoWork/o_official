import 'server-only';
import { NextResponse } from 'next/server';
import type { OpsStore } from '@/lib/ops/ops-store';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { readDeliveryTrackingConfig } from '@/lib/orders/tracking/delivery-config';
import { reportDeliveryTrackingIssue } from '@/lib/orders/tracking/delivery-ops';
import { scheduleDeliveryTracking } from '@/lib/orders/tracking/delivery-schedule';
import { getDeliveryTrackingSettings, signalDeliveryTracking } from '@/lib/orders/tracking/delivery-store';
import type { TrackingSignal } from '@/lib/orders/tracking/delivery-types';
import { parseTrackingSignals, verifySeventeenTrackSignature } from '@/lib/orders/tracking/seventeen-track-signature';

export const runtime = 'nodejs';

const MAX_WEBHOOK_BYTES = 1048576;

/** Content-Lengthが欠けたり小さく偽られたりしても、上限を越える前に蓄積を止める。 */
async function readWebhookBody(request: Request): Promise<Uint8Array | null> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_WEBHOOK_BYTES) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_WEBHOOK_BYTES) {
        // cancel自体の失敗で413を400に変えず、残りの受信も待たない。
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

// PUBLIC: 署名を認証の代わりに使うため、ログイン・CSRF・送信元制限は通さない。
export async function POST(request: Request): Promise<Response> {
  const { apiKey } = readDeliveryTrackingConfig(process.env);
  if (!apiKey) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  let raw: Uint8Array | null;
  try {
    raw = await readWebhookBody(request);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  if (raw === null) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  if (!verifySeventeenTrackSignature(raw, request.headers.get('sign'), apiKey)) {
    try {
      const store = await createServiceRoleClient();
      await reportDeliveryTrackingIssue(store as unknown as OpsStore, 'signature_invalid');
    } catch {
      // 計数の失敗で署名不一致の401を変えない。例外にも本文や署名が含まれうる。
      console.error('[17track] 署名不一致の計数に失敗しました');
    }
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let signals: TrackingSignal[];
  try {
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    signals = parseTrackingSignals(payload);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  try {
    const store = await createServiceRoleClient();
    const settings = await getDeliveryTrackingSettings(store);
    if (!settings.enabled || signals.length === 0) {
      return NextResponse.json({ received: true });
    }
    const signaled = await signalDeliveryTracking(store, signals);
    // 合う追跡行がある時だけ起こす。記録はpayloadではなくworkerの読み直しで決める。
    if (signaled > 0) scheduleDeliveryTracking();
  } catch {
    console.error('[17track] 配送の合図の記録に失敗しました');
    return NextResponse.json({ error: 'Failed to record tracking signal' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
