/**
 * 問い合わせの一覧を状態・種別・検索語で絞って管理者に返す窓口（src/app/api/admin/contact/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-121
 * @design DD-ADMIN-006
 * @remarks 問い合わせの表は直接の読みを断っているので、問い合わせの閲覧権限を確かめた後に service role で読む。検索語は PostgREST の or の条件に字のまま埋め込まれるため、区切りの字を空白にして長さを切ってから入れる。状態と種別は表の CHECK と同じ決まった値だけを絞りに使う。一覧を開いたことを、読めた時に1行監査へ残す。検索語・名前・メールは入れず、検索語の長さだけを残し、読んだ人の送り元 IP とブラウザの名乗りを付ける（ADR-0462）。記録に失敗しても読み出しは止めない。
 */
import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit, type AuditEvent } from '@/lib/audit';
import { getAuditRequestContext } from '@/lib/request-ip';

const DEFAULT_PAGE_SIZE = 20;
const CONTACT_STATUSES = new Set(['open', 'pending', 'answered', 'closed']);
const CONTACT_TYPES = new Set(['product', 'order', 'other']);

// PostgREST の or() フィルタを壊す文字を除去する（ユーザー入力を安全にする）
function sanitizeSearchTerm(value: string): string {
  return value.replace(/[,()%\\]/g, ' ').trim().slice(0, 100);
}

/** 読み出しの記録に失敗しても読み出しは止めない。誤りの文は残さず固定の文だけを出す。 */
async function auditReadSafely(event: AuditEvent): Promise<void> {
  try {
    await logAudit(event);
  } catch {
    console.error('Failed to write contact list read audit');
  }
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

    await auditReadSafely({
      action: 'admin.contact.list',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'contact',
      outcome: 'success',
      ...getAuditRequestContext(request),
      metadata: {
        status: statusFilter && CONTACT_STATUSES.has(statusFilter) ? statusFilter : null,
        type: typeFilter && CONTACT_TYPES.has(typeFilter) ? typeFilter : null,
        page,
        q_length: search.length,
      },
    });

    return NextResponse.json(
      { data: data ?? [], page, pageSize, totalPages, totalCount },
      { status: 200 }
    );
  } catch (error) {
    console.error('GET /api/admin/contact error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
