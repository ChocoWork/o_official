import { NextResponse } from 'next/server';
import { currentSeasonKey } from '@/lib/kpi/monthly-metrics';
import { syncMetaKpis, type MetaConnection } from '@/lib/meta/sync-kpi';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
	const expected = process.env.CRON_SECRET;
	const authorization = request.headers.get('authorization');
	if (!expected || authorization !== `Bearer ${expected}`) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}
	const supabase = await createServiceRoleClient();
	const { data, error } = await supabase
		.from('admin_meta_kpi_connections')
		.select('id, instagram_user_id, ad_account_id, access_token_encrypted')
		.eq('provider', 'meta')
		.maybeSingle();
	if (error || !data) return NextResponse.json({ data: { skipped: true } });
	try {
		const result = await syncMetaKpis(supabase, data as MetaConnection, currentSeasonKey());
		const now = new Date().toISOString();
		await supabase.from('admin_meta_kpi_connections').update({ last_synced_at: now, last_sync_status: result.status, last_sync_message: result.message, updated_at: now }).eq('id', data.id);
		return NextResponse.json({ data: result });
	} catch (syncError) {
		const message = syncError instanceof Error ? syncError.message : 'Meta KPI sync failed';
		await supabase.from('admin_meta_kpi_connections').update({ last_sync_status: 'failed', last_sync_message: message, updated_at: new Date().toISOString() }).eq('id', data.id);
		return NextResponse.json({ error: 'Sync failed' }, { status: 502 });
	}
}
