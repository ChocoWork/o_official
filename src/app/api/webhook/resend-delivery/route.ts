import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { isSvixTimestampFresh, verifySvixSignature } from '@/lib/webhooks/svix';
import { MAX_DELIVERY_WEBHOOK_BYTES, parseDeliveryEvent } from '@/lib/orders/email/order-email-delivery';
import { recordOrderEmailDelivery, type OrderEmailStore } from '@/lib/orders/email/order-email-store';

/**
 * PUBLIC: Resend の配達の状態の知らせ（グループ D 設計書 6-2）。
 * お問い合わせの受け口とは別の鍵（RESEND_DELIVERY_WEBHOOK_SECRET）で、届いたままの本文の Svix 署名を確かめる。
 * 受付済みの番号を書き、配達の状態を1行直すだけにして、すぐ返す。DB の失敗の時だけ 500 を返して送り直してもらう。
 * 宛先・本文はログに出さない。
 */
const MAX_SVIX_ID_LENGTH = 200;

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.RESEND_DELIVERY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[resend-delivery] RESEND_DELIVERY_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DELIVERY_WEBHOOK_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_DELIVERY_WEBHOOK_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(body);

  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature || svixId.length > MAX_SVIX_ID_LENGTH) {
    return NextResponse.json({ error: 'Missing signature headers' }, { status: 400 });
  }
  if (!isSvixTimestampFresh(svixTimestamp) || !verifySvixSignature(secret, svixId, svixTimestamp, svixSignature, rawBody)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const event = parseDeliveryEvent(payload);
  if (event.kind === 'invalid') {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  if (event.kind === 'ignored') {
    return NextResponse.json({ received: true, ignored: true });
  }

  try {
    const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
    await recordOrderEmailDelivery(store, {
      svixId,
      providerMessageId: event.providerMessageId,
      status: event.status,
      eventAt: event.eventAt,
    });
  } catch (error) {
    console.error('[resend-delivery] Failed to record delivery', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Failed to record delivery' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
