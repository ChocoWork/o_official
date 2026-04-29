import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';

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

    return NextResponse.json({ data }, { status: 200 });
  } catch (err) {
    console.error('Audit logs GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
