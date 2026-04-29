import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import sendMail from '@/lib/mail';
import { getRequestOrigin } from '@/lib/redirect';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  inquiryType: z.enum(['product', 'order', 'other']),
  subject: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(500),
  website: z.string().optional().default(''),
});

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

    const { name, email, inquiryType, subject, message, website } = parsed.data;

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

    const { data: inquiryData, error: inquiryError } = await service
      .from('contact_inquiries')
      .insert([
        {
          name,
          email,
          inquiry_type: inquiryType,
          subject,
          message,
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

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('POST /api/contact error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
