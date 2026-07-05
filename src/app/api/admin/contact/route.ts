import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

const DEFAULT_PAGE_SIZE = 20;
const CONTACT_STATUSES = new Set(['open', 'pending', 'answered', 'closed']);
const CONTACT_TYPES = new Set(['product', 'order', 'other']);

// PostgREST の or() フィルタを壊す文字を除去する（ユーザー入力を安全にする）
function sanitizeSearchTerm(value: string): string {
  return value.replace(/[,()%\\]/g, ' ').trim().slice(0, 100);
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.contact.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const url = new URL(request.url);
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
    );
    const statusFilter = url.searchParams.get('status');
    const typeFilter = url.searchParams.get('type');
    const rawSearch = url.searchParams.get('q') ?? '';

    const service = await createServiceRoleClient();

    let query = service
      .from('contact_inquiries')
      .select(
        'id, created_at, updated_at, last_message_at, name, email, inquiry_type, subject, status, order_id, user_id',
        { count: 'exact' }
      );

    if (statusFilter && CONTACT_STATUSES.has(statusFilter)) {
      query = query.eq('status', statusFilter);
    }

    if (typeFilter && CONTACT_TYPES.has(typeFilter)) {
      query = query.eq('inquiry_type', typeFilter);
    }

    const search = sanitizeSearchTerm(rawSearch);
    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,subject.ilike.%${search}%`);
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('last_message_at', { ascending: false })
      .range(from, to);

    if (error) {
      console.error('Failed to fetch contact inquiries:', error);
      return NextResponse.json({ error: 'Failed to fetch inquiries' }, { status: 500 });
    }

    const totalCount = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    return NextResponse.json(
      { data: data ?? [], page, pageSize, totalPages, totalCount },
      { status: 200 }
    );
  } catch (error) {
    console.error('GET /api/admin/contact error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
