/**
 * 監査ログの新しい100件を管理者に返す窓口（src/app/api/admin/audit-logs/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-104
 * @design DD-ADMIN-004
 * @remarks audit_logs は認証済みの利用者の直接の読みを方針で断っているので、監査の閲覧権限を確かめた後に service role で読む。操作した人のメール・IP・ブラウザの情報・付帯の情報は読める人にも返さないため、列を名指しした8列だけを選ぶ。監査ログを誰がいつ読んだかを、読めた時に1行残す（ログの中身は入れない）。記録に失敗しても読み出しは止めない。
 */
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit, type AuditEvent } from '@/lib/audit';

const AUDIT_LOGS_SAFE_COLUMNS = [
  'id',
  'created_at',
  'action',
  'actor_id',
  'resource',
  'resource_id',
  'outcome',
  'detail',
].join(',');

/** 読み出しの記録に失敗しても読み出しは止めない。誤りの文は残さず固定の文だけを出す。 */
async function auditReadSafely(event: AuditEvent): Promise<void> {
  try {
    await logAudit(event);
  } catch {
    console.error('Failed to write audit log read audit');
  }
}

export async function GET(request: Request) {
  try {
    const authResult = await authorizeAdminPermission('admin.audit.read', request);
    if (!authResult.ok) {
      return authResult.response;
    }

    const service = await createServiceRoleClient();
    const { data, error } = await service
      .from('audit_logs')
      .select(AUDIT_LOGS_SAFE_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      console.error('Failed to fetch audit logs:', error);
      return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
    }

    await auditReadSafely({
      action: 'admin.audit_logs.read',
      actor_id: authResult.userId,
      actor_email: authResult.actorEmail,
      resource: 'audit_logs',
      outcome: 'success',
    });

    return NextResponse.json({ data }, { status: 200 });
  } catch (err) {
    console.error('Audit logs GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
