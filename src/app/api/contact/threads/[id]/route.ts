import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient, resolveRequestUser } from '@/lib/supabase/server';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

type OwnedInquiry = {
  id: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  inquiry_type: string;
  subject: string;
  status: string;
  email: string;
  user_id: string | null;
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

    const service = await createServiceRoleClient();

    const { data: inquiry } = await service
      .from('contact_inquiries')
      .select('id, created_at, updated_at, last_message_at, inquiry_type, subject, status, email, user_id')
      .eq('id', id)
      .single<OwnedInquiry>();

    const ownsThread =
      inquiry &&
      (inquiry.user_id === user.id ||
        (user.email ? inquiry.email.trim().toLowerCase() === user.email.trim().toLowerCase() : false));

    if (!ownsThread) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    const { data: messages, error: messagesError } = await service
      .from('contact_messages')
      .select('id, sender_role, body, channel, created_at')
      .eq('inquiry_id', id)
      .order('created_at', { ascending: true });

    if (messagesError) {
      console.error('Failed to fetch thread messages:', messagesError);
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500, headers: NO_STORE_HEADERS });
    }

    const { email: _omitEmail, user_id: _omitUserId, ...safeInquiry } = inquiry;
    void _omitEmail;
    void _omitUserId;

    return NextResponse.json({ data: { ...safeInquiry, messages: messages ?? [] } }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('GET /api/contact/threads/[id] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
