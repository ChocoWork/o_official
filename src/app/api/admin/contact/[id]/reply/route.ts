import { NextResponse } from 'next/server';
import { z } from 'zod';
import sendMail from '@/lib/mail';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { buildReplyAddress } from '@/lib/contact/reply-address';

const replySchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.contact.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const parsed = replySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const service = await createServiceRoleClient();

    const { data: inquiry, error: inquiryError } = await service
      .from('contact_inquiries')
      .select('id, email, subject')
      .eq('id', id)
      .single();

    if (inquiryError || !inquiry) {
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
    }

    const nowIso = new Date().toISOString();

    const { error: insertError } = await service.from('contact_messages').insert([
      {
        inquiry_id: id,
        sender_role: 'admin',
        author_id: authz.userId,
        body: parsed.data.body,
        channel: 'web',
      },
    ]);

    if (insertError) {
      console.error('Failed to insert admin reply:', insertError);
      return NextResponse.json({ error: 'Failed to save reply' }, { status: 500 });
    }

    await service
      .from('contact_inquiries')
      .update({ status: 'answered', last_message_at: nowIso, updated_at: nowIso })
      .eq('id', id);

    // 顧客へ返信メール（Reply-To でメール返信をスレッドに取り込めるようにする）
    let mailOutcome: 'success' | 'error' = 'success';
    if (process.env.MAIL_FROM_ADDRESS) {
      const subject = inquiry.subject.startsWith('Re:') ? inquiry.subject : `Re: ${inquiry.subject}`;
      const text = [parsed.data.body, '', '---', 'Le Fil des Heures'].join('\n');
      try {
        await sendMail({
          to: inquiry.email,
          subject,
          text,
          replyTo: buildReplyAddress(id) ?? undefined,
        });
      } catch (mailError) {
        mailOutcome = 'error';
        console.warn('Contact reply mail failed. Reply is saved:', mailError);
      }
    }

    await logAudit({
      action: 'admin.contact.reply',
      actor_id: authz.userId,
      resource: 'contact',
      resource_id: id,
      outcome: mailOutcome === 'success' ? 'success' : 'error',
      detail: mailOutcome === 'success' ? 'reply_sent' : 'reply_saved_mail_failed',
      user_agent: request.headers.get('user-agent'),
    });

    return NextResponse.json({ success: true, mailSent: mailOutcome === 'success' }, { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/contact/[id]/reply error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
