import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';

export async function authorizeMetaAdmin(request: Request) {
	const authz = await authorizeAdminPermission('admin.orders.read', request);
	if (!authz.ok) return authz;
	if (authz.role !== 'admin') {
		return { ok: false as const, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
	}
	return authz;
}
