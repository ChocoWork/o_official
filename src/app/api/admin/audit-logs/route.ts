import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  try {
    const adminApiKey = process.env.ADMIN_API_KEY;
    if (!adminApiKey) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    const token = request.headers.get('x-admin-token');
    if (token !== adminApiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const service = createServiceRoleClient();
    const { data, error } = await service.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100);
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
