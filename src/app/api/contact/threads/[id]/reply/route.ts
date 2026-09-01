import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { logAudit } from '@/lib/audit';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

const replySchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

type OwnedInquiry = {
  id: string;
  email: string;
  user_id: string | null;
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authenticateRequest(request);

    if (!auth.ok) {
      return authFailureResponse(auth.reason, NO_STORE_HEADERS);
    }

    const userId = auth.claims.sub;
    const userEmail = auth.claims.email ?? null;

    // 認証済みでも、1 スレッドへ無制限に行を挿入させない（OWASP A04: レート制限の欠如）。
    // 主体は IP ではなく利用者。共有 IP の巻き添えを避けつつ、乗っ取られた 1 セッションが
    // contact_messages を膨らませるのを止める。
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimited = await enforceRateLimit({
      request,
      endpoint: 'contact:thread:reply',
      subject: userId,
      limit: 30,
      windowSeconds: 3600,
    });
    if (rateLimited) {
      return rateLimited;
    }

    const parsed = replySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const service = await createServiceRoleClient();

    const { data: inquiry } = await service
      .from('contact_inquiries')
      .select('id, email, user_id')
      .eq('id', id)
      .single<OwnedInquiry>();

    const ownsThread =
      inquiry &&
      (inquiry.user_id === userId ||
        (userEmail ? inquiry.email.trim().toLowerCase() === userEmail.trim().toLowerCase() : false));

    if (!ownsThread) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    const { error: insertError } = await service.from('contact_messages').insert([
      {
        inquiry_id: id,
        sender_role: 'user',
        author_id: userId,
        body: parsed.data.body,
        channel: 'web',
      },
    ]);

    if (insertError) {
      console.error('Failed to insert customer reply:', insertError);
      return NextResponse.json({ error: 'Failed to save reply' }, { status: 500, headers: NO_STORE_HEADERS });
    }

    const nowIso = new Date().toISOString();
    await service
      .from('contact_inquiries')
      .update({ status: 'pending', last_message_at: nowIso, updated_at: nowIso })
      .eq('id', id);

    await logAudit({
      action: 'contact.thread.reply',
      actor_id: userId,
      resource: 'contact',
      resource_id: id,
      outcome: 'success',
      detail: 'customer_reply',
    });

    return NextResponse.json({ success: true }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('POST /api/contact/threads/[id]/reply error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
