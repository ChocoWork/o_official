import { NextResponse } from 'next/server';
import { z } from 'zod';
import sendMail from '@/lib/mail';
import { createServiceRoleClient } from '@/lib/supabase/server';

const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  inquiryType: z.enum(['product', 'order', 'other']),
  subject: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(500),
});

const inquiryTypeLabelMap: Record<string, string> = {
  product: '商品について',
  order: 'ご注文について',
  other: 'その他',
};

export async function POST(request: Request) {
  try {
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

    const { name, email, inquiryType, subject, message } = parsed.data;
    const service = await createServiceRoleClient();

    const historyRecord = {
      action: 'contact.submit',
      actor_id: null,
      actor_email: email,
      resource: 'contact',
      resource_id: null,
      outcome: 'success',
      detail: subject,
      metadata: {
        name,
        inquiryType,
        message,
      },
      created_at: new Date().toISOString(),
    };

    const { error: historyError } = await service.from('audit_logs').insert([historyRecord]);
    if (historyError) {
      console.error('Failed to save contact history:', historyError);
      return NextResponse.json({ success: false, error: '問い合わせ履歴の保存に失敗しました。' }, { status: 500 });
    }

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
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('POST /api/contact error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
