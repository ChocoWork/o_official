import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient, resolveRequestUser } from '@/lib/supabase/server';
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
    const supabase = await createClient(request);
    const {
      data: { user },
      error: userError,
    } = await resolveRequestUser(supabase, request);

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
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
      (inquiry.user_id === user.id ||
        (user.email ? inquiry.email.trim().toLowerCase() === user.email.trim().toLowerCase() : false));

    if (!ownsThread) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    const { error: insertError } = await service.from('contact_messages').insert([
      {
        inquiry_id: id,
        sender_role: 'user',
        author_id: user.id,
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
      actor_id: user.id,
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
