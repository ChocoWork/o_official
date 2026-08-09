import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeMetaAdmin } from '@/lib/meta/admin';
import { syncMetaKpis, type MetaConnection } from '@/lib/meta/sync-kpi';
import { createServiceRoleClient } from '@/lib/supabase/server';

const requestSchema = z.object({ season: z.string().regex(/^\d{4}(SS|AW)$/) });

export async function POST(request: Request) {
	const authz = await authorizeMetaAdmin(request);
	if (!authz.ok) return authz.response;
	const body = await request.json().catch(() => null);
	const parsed = requestSchema.safeParse(body);
	if (!parsed.success) return NextResponse.json({ error: 'Invalid season' }, { status: 400 });
	const supabase = await createServiceRoleClient();
	const { data, error } = await supabase
		.from('admin_meta_kpi_connections')
		.select('id, instagram_user_id, ad_account_id, access_token_encrypted')
		.eq('provider', 'meta')
		.maybeSingle();
	if (error || !data) return NextResponse.json({ error: 'Metaアカウントが接続されていません' }, { status: 409 });

	const { data: run, error: runError } = await supabase.from('admin_meta_kpi_sync_runs').insert({
		connection_id: data.id,
		season_key: parsed.data.season,
		status: 'running',
	}).select('id').single();
	if (runError) return NextResponse.json({ error: '同期履歴を作成できませんでした' }, { status: 500 });

	try {
		const result = await syncMetaKpis(supabase, data as MetaConnection, parsed.data.season);
		const now = new Date().toISOString();
		await Promise.all([
			supabase.from('admin_meta_kpi_sync_runs').update({ status: result.status, metrics_written: result.metricsWritten, message: result.message, finished_at: now }).eq('id', run.id),
			supabase.from('admin_meta_kpi_connections').update({ last_synced_at: now, last_sync_status: result.status, last_sync_message: result.message, updated_at: now }).eq('id', data.id),
		]);
		return NextResponse.json({ data: result });
	} catch (syncError) {
		const message = syncError instanceof Error ? syncError.message : 'Meta KPI sync failed';
		const now = new Date().toISOString();
		await Promise.all([
			supabase.from('admin_meta_kpi_sync_runs').update({ status: 'failed', message, finished_at: now }).eq('id', run.id),
			supabase.from('admin_meta_kpi_connections').update({ last_sync_status: 'failed', last_sync_message: message, updated_at: now }).eq('id', data.id),
		]);
		console.error('[Meta KPI sync] Failed:', message);
		return NextResponse.json({ error: 'Meta KPIの同期に失敗しました' }, { status: 502 });
	}
}
