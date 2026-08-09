import { NextResponse } from 'next/server';
import { authorizeMetaAdmin } from '@/lib/meta/admin';
import { metaSetupMissing } from '@/lib/meta/config';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
	const authz = await authorizeMetaAdmin(request);
	if (!authz.ok) return authz.response;
	const missing = metaSetupMissing();
	const supabase = await createServiceRoleClient();
	const { data, error } = await supabase
		.from('admin_meta_kpi_connections')
		.select('instagram_username, ad_account_id, ad_account_name, token_expires_at, last_synced_at, last_sync_status, last_sync_message')
		.eq('provider', 'meta')
		.maybeSingle();
	if (error && error.code !== '42P01') {
		return NextResponse.json({ error: 'Meta連携状態を取得できませんでした' }, { status: 500 });
	}
	return NextResponse.json({
		data: {
			configured: missing.length === 0,
			missing,
			connected: Boolean(data),
			connection: data ?? null,
		},
	});
}

export async function DELETE(request: Request) {
	const authz = await authorizeMetaAdmin(request);
	if (!authz.ok) return authz.response;
	const supabase = await createServiceRoleClient();
	const { error } = await supabase.from('admin_meta_kpi_connections').delete().eq('provider', 'meta');
	if (error) return NextResponse.json({ error: 'Meta連携を解除できませんでした' }, { status: 500 });
	return NextResponse.json({ data: { connected: false } });
}
