import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { parseReplyAddress } from '@/lib/contact/reply-address';

// Resend delivers inbound emails via a Svix-signed webhook. We verify the
// signature manually (no svix dependency) and correlate the reply back to the
// originating inquiry thread via the reply+{id}.{token}@ address.

const SVIX_TOLERANCE_SECONDS = 5 * 60;

function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  svixSignatureHeader: string,
  payload: string
): boolean {
  const secretKey = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const secretBytes = Buffer.from(secretKey, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  const providedSignatures = svixSignatureHeader
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter((value): value is string => Boolean(value));

  const expectedBuffer = Buffer.from(expected);
  return providedSignatures.some((signature) => {
    const provided = Buffer.from(signature);
    return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
  });
}

function isTimestampFresh(svixTimestamp: string): boolean {
  const timestamp = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - timestamp) <= SVIX_TOLERANCE_SECONDS;
}

// Collect candidate recipient addresses from the inbound payload shape.
function collectRecipients(data: Record<string, unknown>): string[] {
  const recipients: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string') {
      recipients.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') {
          recipients.push(entry);
        } else if (entry && typeof entry === 'object' && typeof (entry as { address?: unknown }).address === 'string') {
          recipients.push((entry as { address: string }).address);
        }
      }
    }
  };

  push(data.to);
  const headers = data.headers;
  if (headers && typeof headers === 'object') {
    push((headers as Record<string, unknown>).to);
    push((headers as Record<string, unknown>).To);
  }
  return recipients;
}

function extractEmail(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

// Best-effort removal of quoted reply history so only the new text is stored.
function stripQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    if (/^\s*On .+wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^_{5,}$/.test(line)) break;
    if (line.startsWith('>')) continue;
    output.push(line);
  }
  return output.join('\n').trim();
}

export async function POST(request: Request) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      console.error('RESEND_WEBHOOK_SECRET is not configured');
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
    }

    const rawBody = await request.text();
    const svixId = request.headers.get('svix-id');
    const svixTimestamp = request.headers.get('svix-timestamp');
    const svixSignature = request.headers.get('svix-signature');

    if (!svixId || !svixTimestamp || !svixSignature) {
      return NextResponse.json({ error: 'Missing signature headers' }, { status: 400 });
    }

    if (!isTimestampFresh(svixTimestamp) || !verifySvixSignature(secret, svixId, svixTimestamp, svixSignature, rawBody)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const event = JSON.parse(rawBody) as { type?: string; data?: Record<string, unknown> };
    const data = event.data ?? {};

    // Correlate to a thread via the reply address.
    const recipients = collectRecipients(data);
    let inquiryId: string | null = null;
    for (const recipient of recipients) {
      const parsed = parseReplyAddress(recipient);
      if (parsed?.valid) {
        inquiryId = parsed.inquiryId;
        break;
      }
    }

    if (!inquiryId) {
      // Not a thread reply we recognize — acknowledge to avoid retries.
      return NextResponse.json({ ignored: true }, { status: 200 });
    }

    const service = await createServiceRoleClient();

    const { data: inquiry, error: inquiryError } = await service
      .from('contact_inquiries')
      .select('id, email')
      .eq('id', inquiryId)
      .single();

    if (inquiryError || !inquiry) {
      return NextResponse.json({ ignored: true }, { status: 200 });
    }

    // Anti-spoofing: the reply must come from the original inquirer's address.
    const fromRaw = typeof data.from === 'string' ? data.from : '';
    const fromEmail = extractEmail(fromRaw);
    if (fromEmail !== inquiry.email.trim().toLowerCase()) {
      await logAudit({
        action: 'contact.inbound',
        resource: 'contact',
        resource_id: inquiryId,
        outcome: 'failure',
        detail: 'sender_mismatch',
      });
      return NextResponse.json({ ignored: true }, { status: 200 });
    }

    const rawText = typeof data.text === 'string' ? data.text : '';
    const body = stripQuotedHistory(rawText) || rawText.trim();
    if (!body) {
      return NextResponse.json({ ignored: true }, { status: 200 });
    }

    const providerId =
      (typeof data.email_id === 'string' && data.email_id) ||
      (typeof (data as { id?: unknown }).id === 'string' && (data as { id: string }).id) ||
      svixId;

    const { error: insertError } = await service.from('contact_messages').insert([
      {
        inquiry_id: inquiryId,
        sender_role: 'user',
        body,
        channel: 'email',
        inbound_provider_id: providerId,
      },
    ]);

    if (insertError) {
      // Unique violation on inbound_provider_id => already processed (idempotent).
      if (insertError.code === '23505') {
        return NextResponse.json({ duplicate: true }, { status: 200 });
      }
      console.error('Failed to insert inbound message:', insertError);
      return NextResponse.json({ error: 'Failed to store message' }, { status: 500 });
    }

    const nowIso = new Date().toISOString();
    await service
      .from('contact_inquiries')
      .update({ status: 'pending', last_message_at: nowIso, updated_at: nowIso })
      .eq('id', inquiryId);

    await logAudit({
      action: 'contact.inbound',
      resource: 'contact',
      resource_id: inquiryId,
      outcome: 'success',
      detail: 'message_stored',
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('POST /api/contact/inbound error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
