import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import sendMail from '@/lib/mail';
import { getRequestOrigin } from '@/lib/redirect';
import { createClient, createServiceRoleClient, resolveRequestUser } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { buildReplyAddress } from '@/lib/contact/reply-address';
import { toOrderNumber } from '@/lib/orders/order-number';

const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  inquiryType: z.enum(['product', 'order', 'other']),
  subject: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(500),
  orderNumber: z.string().trim().max(32).optional().default(''),
  website: z.string().optional().default(''),
});

type OrderLinkRow = {
  id: string;
  shipping_email: string | null;
  user_id: string | null;
};

/**
 * Resolve an order UUID from a user-entered order number (ORD-XXXXXXXX), only
 * when the requester owns the order (matching email or authenticated user id).
 * Returns null when nothing matches — the inquiry is still accepted, just not linked.
 */
async function resolveLinkedOrderId(
  service: Awaited<ReturnType<typeof createServiceRoleClient>>,
  orderNumber: string,
  email: string,
  userId: string | null
): Promise<string | null> {
  const normalized = orderNumber.trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  const candidates = new Map<string, OrderLinkRow>();

  const { data: byEmail } = await service
    .from('orders')
    .select('id, shipping_email, user_id')
    .ilike('shipping_email', email)
    .limit(50);
  for (const row of (byEmail ?? []) as OrderLinkRow[]) {
    candidates.set(row.id, row);
  }

  if (userId) {
    const { data: byUser } = await service
      .from('orders')
      .select('id, shipping_email, user_id')
      .eq('user_id', userId)
      .limit(50);
    for (const row of (byUser ?? []) as OrderLinkRow[]) {
      candidates.set(row.id, row);
    }
  }

  for (const row of candidates.values()) {
    if (toOrderNumber(row.id) === normalized) {
      return row.id;
    }
  }

  return null;
}

const inquiryTypeLabelMap: Record<string, string> = {
  product: '商品について',
  order: 'ご注文について',
  other: 'その他',
};

function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? null;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }

  return null;
}

function isSameOriginRequest(request: Request): boolean {
  const expectedOrigin = getRequestOrigin(request);
  const originHeader = request.headers.get('origin');
  const refererHeader = request.headers.get('referer');

  if (originHeader) {
    return originHeader === expectedOrigin;
  }

  if (refererHeader) {
    try {
      return new URL(refererHeader).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ success: false, error: 'Forbidden origin' }, { status: 403 });
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const ipRateLimit = await enforceRateLimit({
      request,
      endpoint: 'contact:submit',
      limit: 20,
      windowSeconds: 3600,
    });
    if (ipRateLimit) {
      return ipRateLimit;
    }

    const body = await request.json();
    const parsed = contactSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: '入力内容を確認してください。',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const { name, email, inquiryType, subject, message, orderNumber, website } = parsed.data;

    if (website.trim().length > 0) {
      await logAudit({
        action: 'contact.submit',
        outcome: 'failure',
        detail: 'honeypot_triggered',
        resource: 'contact',
        ip: getClientIp(request),
      });
      return NextResponse.json({ success: false, error: 'Bot detection failed' }, { status: 403 });
    }

    const emailRateLimit = await enforceRateLimit({
      request,
      endpoint: 'contact:submit',
      limit: 5,
      windowSeconds: 3600,
      subject: email,
    });
    if (emailRateLimit) {
      return emailRateLimit;
    }

    const service = await createServiceRoleClient();
    const clientIp = getClientIp(request);
    const userAgent = request.headers.get('user-agent');

    // ログイン済みなら user_id を記録（ゲストは null）
    let userId: string | null = null;
    try {
      const authClient = await createClient(request);
      const {
        data: { user },
      } = await resolveRequestUser(authClient, request);
      userId = user?.id ?? null;
    } catch {
      userId = null;
    }

    const linkedOrderId = await resolveLinkedOrderId(service, orderNumber, email, userId);

    const { data: inquiryData, error: inquiryError } = await service
      .from('contact_inquiries')
      .insert([
        {
          name,
          email,
          inquiry_type: inquiryType,
          subject,
          message,
          user_id: userId,
          order_id: linkedOrderId,
          submitted_ip: clientIp,
          user_agent: userAgent,
        },
      ])
      .select('id')
      .single();

    if (inquiryError || !inquiryData?.id) {
      console.error('Failed to save contact inquiry:', inquiryError);
      await logAudit({
        action: 'contact.submit',
        outcome: 'error',
        detail: 'inquiry_insert_failed',
        resource: 'contact',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ success: false, error: '問い合わせ履歴の保存に失敗しました。' }, { status: 500 });
    }

    // スレッド最初のメッセージとして本文を contact_messages に保存（チャット表示用）
    await service.from('contact_messages').insert([
      {
        inquiry_id: inquiryData.id,
        sender_role: 'user',
        author_id: userId,
        body: message,
        channel: 'web',
      },
    ]);

    await logAudit({
      action: 'contact.submit',
      outcome: 'success',
      resource: 'contact',
      resource_id: inquiryData.id,
      detail: 'accepted',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        inquiry_type: inquiryType,
        email_hash: hashText(email.toLowerCase()),
        order_linked: linkedOrderId ? true : false,
      },
    });

    const supportMailTo = process.env.CONTACT_TO_EMAIL || process.env.SES_FROM_ADDRESS || process.env.MAIL_FROM_ADDRESS;
    const mailSubject = `[Contact] ${subject}`;
    const mailText = [
      'お問い合わせを受け付けました。',
      `種別: ${inquiryTypeLabelMap[inquiryType] ?? inquiryType}`,
      `名前: ${name}`,
      `メール: ${email}`,
      `件名: ${subject}`,
      '本文:',
      message,
    ].join('\n');

    if (supportMailTo && process.env.MAIL_FROM_ADDRESS) {
      try {
        await sendMail({
          to: supportMailTo,
          subject: mailSubject,
          text: mailText,
        });
      } catch (mailError) {
        console.warn('Contact mail send failed. History is saved:', mailError);
        await logAudit({
          action: 'contact.submit.mail',
          outcome: 'error',
          resource: 'contact',
          resource_id: inquiryData.id,
          detail: 'mail_send_failed',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            inquiry_type: inquiryType,
          },
        });
      }
    }

    // 顧客への確認メール（Reply-To でメール返信をスレッドに取り込めるようにする）
    if (process.env.MAIL_FROM_ADDRESS) {
      const confirmationText = [
        `${name} 様`,
        '',
        'お問い合わせいただきありがとうございます。',
        '以下の内容で受け付けました。担当者より改めてご連絡いたします。',
        '',
        `種別: ${inquiryTypeLabelMap[inquiryType] ?? inquiryType}`,
        `件名: ${subject}`,
        '本文:',
        message,
        '',
        'ご返信の際は、本メールにそのままご返信ください。',
        '',
        'Le Fil des Heures',
      ].join('\n');

      try {
        await sendMail({
          to: email,
          subject: `【Le Fil des Heures】お問い合わせを受け付けました（${subject}）`,
          text: confirmationText,
          replyTo: buildReplyAddress(inquiryData.id) ?? undefined,
        });
      } catch (mailError) {
        console.warn('Contact acknowledgement mail failed. History is saved:', mailError);
        await logAudit({
          action: 'contact.submit.ack_mail',
          outcome: 'error',
          resource: 'contact',
          resource_id: inquiryData.id,
          detail: 'ack_mail_send_failed',
          ip: clientIp,
          user_agent: userAgent,
        });
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('POST /api/contact error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
