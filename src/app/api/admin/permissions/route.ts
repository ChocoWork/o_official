import 'server-only';

import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { getPermissionsMatrix, RolePermissionStoreError } from '@/lib/auth/role-permission-store';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** 読取でも現在のACL・session・MFAを毎回確認する。 */
export async function GET(request: Request): Promise<Response> {
  const authz = await authorizeAdminPermission('admin.permissions.manage', request);
  if (!authz.ok) return noStore(authz.response);

  try {
    const client = await createServiceRoleClient();
    const data = await getPermissionsMatrix(client, authz.userId);
    return noStore(NextResponse.json({ data }));
  } catch (error) {
    if (error instanceof RolePermissionStoreError && error.code === 'ROLE_PERMISSION_FORBIDDEN') {
      return noStore(NextResponse.json({ error: '権限を変更する権限がありません。', code: error.code }, { status: 403 }));
    }
    console.error('[admin.permissions] operation failed');
    return noStore(NextResponse.json({ error: '権限を読み込めませんでした。', code: 'PERMISSION_LOAD_FAILED' }, { status: 500 }));
  }
}
