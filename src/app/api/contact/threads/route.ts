import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient, resolveRequestUser } from '@/lib/supabase/server';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

type ThreadRow = {
  id: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  inquiry_type: string;
  subject: string;
  status: string;
};

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient(request);
    const {
      data: { user },
      error: userError,
    } = await resolveRequestUser(supabase, request);

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
    }

    const service = await createServiceRoleClient();
    const threads = new Map<string, ThreadRow>();
    const columns = 'id, created_at, updated_at, last_message_at, inquiry_type, subject, status';

    const { data: byUser } = await service
      .from('contact_inquiries')
      .select(columns)
      .eq('user_id', user.id);
    for (const row of (byUser ?? []) as ThreadRow[]) {
      threads.set(row.id, row);
    }

    if (user.email) {
      const { data: byEmail } = await service
        .from('contact_inquiries')
        .select(columns)
        .ilike('email', user.email);
      for (const row of (byEmail ?? []) as ThreadRow[]) {
        threads.set(row.id, row);
      }
    }

    const data = Array.from(threads.values()).sort(
      (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
    );

    return NextResponse.json({ data }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('GET /api/contact/threads error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
