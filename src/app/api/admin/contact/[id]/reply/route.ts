/**
 * 問い合わせへの管理者の返信を保存し、お客様へメールで送る窓口（src/app/api/admin/contact/[id]/reply/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-123
 * @design DD-ADMIN-008
 * @remarks 店の答えを失わないよう保存を先にし、メールが送れなくても保存は取り消さず、結果を応答の mailSent と監査で分ける。送り手の設定が無い時は送れていないので mailSent を偽にして別の符号で残す。返信後の状態の更新が誤りなら500にする（保存した返信は残る）。件名は問い合わせ者の入力なので、制御文字（CR・LF を含む）を空白にして、ヘッダーの注入を防ぐ。返信は管理者単位で10分に30回までに絞る。Reply-To にスレッドの印付きの宛先を入れ、お客様のメール返信を同じスレッドへ取り込めるようにする。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import sendMail from '@/lib/mail';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { getAuditRequestContext } from '@/lib/request-ip';
import { buildReplyAddress } from '@/lib/contact/reply-address';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

const replySchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

const CONTACT_REPLY_RATE_LIMIT = { endpoint: 'admin:contact:reply', limit: 30, windowSeconds: 600 } as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 件名の制御文字（CR・LF を含む）を空白にし、前後を削って Re: を付ける。空なら固定の件名にする。 */
function buildReplySubject(rawSubject: string): string {
  const cleaned = rawSubject.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
  if (cleaned === '') {
    return 'Re: (件名なし)';
  }
  return cleaned.startsWith('Re:') ? cleaned : `Re: ${cleaned}`;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.contact.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const limited = await enforceRateLimit({ request, ...CONTACT_REPLY_RATE_LIMIT, subject: authz.userId });
    if (limited) {
      return limited;
    }

    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
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

    const { error: statusError } = await service
      .from('contact_inquiries')
      .update({ status: 'answered', last_message_at: nowIso, updated_at: nowIso })
      .eq('id', id);

    if (statusError) {
      // 保存した返信は取り消さない。メールは送らない（状態が直るまで送り直しの判断を管理者に任せる）
      console.error('Failed to update inquiry status after reply:', { code: statusError.code });
      await logAudit({
        action: 'admin.contact.reply',
        actor_id: authz.userId,
        actor_email: authz.actorEmail,
        resource: 'contact',
        resource_id: id,
        outcome: 'error',
        detail: 'status_update_failed',
        ...getAuditRequestContext(request),
      });
      return NextResponse.json({ error: 'Failed to update inquiry status' }, { status: 500 });
    }

    // 顧客へ返信メール（Reply-To でメール返信をスレッドに取り込めるようにする）
    let mailOutcome: 'success' | 'error' | 'not_configured' = 'not_configured';
    if (process.env.MAIL_FROM_ADDRESS) {
      mailOutcome = 'success';
      const subject = buildReplySubject(inquiry.subject);
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
      actor_email: authz.actorEmail,
      resource: 'contact',
      resource_id: id,
      outcome: mailOutcome === 'success' ? 'success' : 'error',
      detail:
        mailOutcome === 'success'
          ? 'reply_sent'
          : mailOutcome === 'error'
            ? 'reply_saved_mail_failed'
            : 'reply_saved_mail_not_configured',
      ...getAuditRequestContext(request),
    });

    return NextResponse.json({ success: true, mailSent: mailOutcome === 'success' }, { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/contact/[id]/reply error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
