import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

type SupabaseLikeError = {
  code?: string;
  message?: string;
};

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.orders.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    if (authz.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const supabase = await createServiceRoleClient();

    // Check if admin_kpi_targets table exists
    const { data, error } = await supabase.rpc('check_table_exists', {
      table_name: 'admin_kpi_targets',
    });

    if (error) {
      console.error('RPC error (check_table_exists):', error);
      // Fallback: Try a simple query
      const { error: queryError } = await supabase.from('admin_kpi_targets').select('1').limit(1);

      if (queryError) {
        const typedError = queryError as SupabaseLikeError;
        if (typedError.code === '42P01') {
          return NextResponse.json(
            {
              exists: false,
              message: 'admin_kpi_targets table does not exist',
              code: typedError.code,
            },
            { status: 200 },
          );
        }

        return NextResponse.json(
          {
            exists: false,
            message: queryError.message,
            code: typedError.code,
          },
          { status: 200 },
        );
      }

      return NextResponse.json({ exists: true, message: 'Table exists' }, { status: 200 });
    }

    return NextResponse.json(
      { exists: Boolean(data), message: 'Table check successful', data },
      { status: 200 },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('GET /api/admin/kpi/migration-status error:', errorMessage, error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
