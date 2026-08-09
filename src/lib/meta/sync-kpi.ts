import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getMetaConfig } from '@/lib/meta/config';
import { metaGraphGetAll } from '@/lib/meta/graph-client';
import { decryptMetaToken } from '@/lib/meta/token-crypto';
import { seasonMonthKeys, sourceStorageKey } from '@/lib/kpi/monthly-metrics';

type MetaConnection = {
	id: string;
	instagram_user_id: string;
	ad_account_id: string | null;
	access_token_encrypted: string;
};

type InsightValue = number | Record<string, number>;
type InsightItem = { name: string; values?: Array<{ value: InsightValue; end_time?: string }> };
type AdAction = { action_type: string; value: string };
type AdsRow = {
	date_start: string;
	spend?: string;
	impressions?: string;
	clicks?: string;
	inline_link_clicks?: string;
	actions?: AdAction[];
	action_values?: AdAction[];
};
type MediaItem = { id: string; media_type?: string; timestamp?: string };

const PURCHASE_ACTIONS = new Set(['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']);

function monthKeyFromIso(value: string): string | null {
	const match = value.match(/^(\d{4}-\d{2})/);
	return match?.[1] ?? null;
}

function scalar(value: InsightValue): number {
	if (typeof value === 'number') {
		return value;
	}
	return Object.values(value).reduce((sum, item) => sum + (Number.isFinite(item) ? item : 0), 0);
}

function actionTotal(actions: AdAction[] | undefined): number {
	return (actions ?? [])
		.filter((action) => PURCHASE_ACTIONS.has(action.action_type))
		.reduce((sum, action) => sum + (Number.parseFloat(action.value) || 0), 0);
}

function addValue(target: Record<string, Record<string, number>>, monthKey: string, metricKey: string, value: number) {
	if (!Number.isFinite(value)) {
		return;
	}
	target[monthKey] ??= {};
	target[monthKey][metricKey] = (target[monthKey][metricKey] ?? 0) + value;
}

function setValue(target: Record<string, Record<string, number>>, monthKey: string, metricKey: string, value: number) {
	if (!Number.isFinite(value)) return;
	target[monthKey] ??= {};
	target[monthKey][metricKey] = value;
}

async function fetchInstagramMetrics(connection: MetaConnection, version: string, token: string, since: string, until: string) {
	const insights = await metaGraphGetAll<InsightItem>(
		'graph.facebook.com',
		version,
		`${connection.instagram_user_id}/insights`,
		token,
		{
			metric: 'reach,profile_views,follower_count,follows_and_unfollows,website_clicks',
			period: 'day',
			since,
			until,
		},
	);
	const values: Record<string, Record<string, number>> = {};
	const keyMap: Record<string, string> = {
		reach: 'reach',
		profile_views: 'profile_visits',
		follower_count: 'followers',
		follows_and_unfollows: 'new_followers',
		website_clicks: 'link_clicks',
	};
	for (const insight of insights) {
		const sourceKey = keyMap[insight.name];
		if (!sourceKey) continue;
		for (const entry of insight.values ?? []) {
			const monthKey = entry.end_time ? monthKeyFromIso(entry.end_time) : null;
			if (!monthKey) continue;
			if (insight.name === 'follower_count') {
				setValue(values, monthKey, sourceKey, scalar(entry.value));
			} else if (insight.name === 'follows_and_unfollows' && typeof entry.value === 'object') {
				addValue(values, monthKey, sourceKey, entry.value.follows ?? 0);
			} else {
				addValue(values, monthKey, sourceKey, scalar(entry.value));
			}
		}
	}
	return values;
}

async function fetchMediaMetrics(connection: MetaConnection, version: string, token: string, since: string, until: string) {
	const values: Record<string, Record<string, number>> = {};
	const media = await metaGraphGetAll<MediaItem>('graph.facebook.com', version, `${connection.instagram_user_id}/media`, token, {
		fields: 'id,media_type,timestamp',
		limit: '100',
		since,
		until,
	});
	const stories = await metaGraphGetAll<MediaItem>('graph.facebook.com', version, `${connection.instagram_user_id}/stories`, token, {
		fields: 'id,media_type,timestamp',
	});
	const requests = [
		...media.map((item) => async () => ({
			item,
			insights: await metaGraphGetAll<InsightItem>('graph.facebook.com', version, `${item.id}/insights`, token, { metric: 'saved' }),
			story: false,
		})),
		...stories.map((item) => async () => ({
			item,
			insights: await metaGraphGetAll<InsightItem>('graph.facebook.com', version, `${item.id}/insights`, token, { metric: 'reach,views' }),
			story: true,
		})),
	];
	for (let offset = 0; offset < requests.length; offset += 10) {
		for (const result of await Promise.allSettled(requests.slice(offset, offset + 10).map((requestInsight) => requestInsight()))) {
			if (result.status !== 'fulfilled') continue;
			const monthKey = result.value.item.timestamp ? monthKeyFromIso(result.value.item.timestamp) : null;
			if (!monthKey) continue;
			for (const insight of result.value.insights) {
				const total = (insight.values ?? []).reduce((sum, entry) => sum + scalar(entry.value), 0);
				if (insight.name === 'saved') addValue(values, monthKey, 'saves', total);
				if (result.value.story && insight.name === 'views') addValue(values, monthKey, 'story_views', total);
				if (result.value.story && insight.name === 'reach') addValue(values, monthKey, 'story_reach', total);
			}
		}
	}
	return values;
}

async function fetchAdsMetrics(connection: MetaConnection, version: string, token: string, since: string, until: string) {
	const values: Record<string, Record<string, number>> = {};
	if (!connection.ad_account_id) {
		return values;
	}
	const rows = await metaGraphGetAll<AdsRow>(
		'graph.facebook.com',
		version,
		`${connection.ad_account_id}/insights`,
		token,
		{
			fields: 'date_start,spend,impressions,clicks,inline_link_clicks,actions,action_values',
			time_increment: '1',
			time_range: JSON.stringify({ since, until }),
			level: 'account',
		},
	);
	for (const row of rows) {
		const monthKey = monthKeyFromIso(row.date_start);
		if (!monthKey) continue;
		addValue(values, monthKey, 'ad_spend', Number.parseFloat(row.spend ?? '0'));
		addValue(values, monthKey, 'ad_impressions', Number.parseFloat(row.impressions ?? '0'));
		addValue(values, monthKey, 'ad_clicks', Number.parseFloat(row.inline_link_clicks ?? row.clicks ?? '0'));
		addValue(values, monthKey, 'ad_conversions', actionTotal(row.actions));
		addValue(values, monthKey, 'ad_revenue', actionTotal(row.action_values));
	}
	return values;
}

function mergeMetrics(...sets: Array<Record<string, Record<string, number>>>) {
	const merged: Record<string, Record<string, number>> = {};
	for (const set of sets) {
		for (const [monthKey, metrics] of Object.entries(set)) {
			for (const [metricKey, value] of Object.entries(metrics)) addValue(merged, monthKey, metricKey, value);
		}
	}
	return merged;
}

export async function syncMetaKpis(supabase: SupabaseClient, connection: MetaConnection, season: string) {
	const config = getMetaConfig();
	if (!config) throw new Error('Meta API environment variables are not configured');
	const monthKeys = seasonMonthKeys(season);
	if (monthKeys.length !== 6) throw new Error('Invalid season');
	const since = `${monthKeys[0]}-01`;
	const endMonth = new Date(`${monthKeys[5]}-01T00:00:00Z`);
	endMonth.setUTCMonth(endMonth.getUTCMonth() + 1);
	endMonth.setUTCDate(0);
	const until = endMonth.toISOString().slice(0, 10);
	const token = decryptMetaToken(connection.access_token_encrypted, config.encryptionKey);

	const results = await Promise.allSettled([
		fetchInstagramMetrics(connection, config.graphVersion, token, since, until),
		fetchMediaMetrics(connection, config.graphVersion, token, since, until),
		fetchAdsMetrics(connection, config.graphVersion, token, since, until),
	]);
	const successful = results.filter((result): result is PromiseFulfilledResult<Record<string, Record<string, number>>> => result.status === 'fulfilled');
	if (successful.length === 0) {
		throw new Error(results.map((result) => result.status === 'rejected' ? result.reason instanceof Error ? result.reason.message : 'sync failed' : '').join('; '));
	}
	const merged = mergeMetrics(...successful.map((result) => result.value));
	const rows = Object.entries(merged).flatMap(([monthKey, metrics]) =>
		Object.entries(metrics).map(([key, value]) => ({ month_key: monthKey, metric_key: sourceStorageKey(key), value })),
	);
	if (rows.length > 0) {
		const { error } = await supabase.from('admin_kpi_monthly_records').upsert(rows, { onConflict: 'month_key,metric_key' });
		if (error) throw new Error(error.message);
	}
	return {
		status: successful.length === results.length ? 'success' as const : 'partial' as const,
		metricsWritten: rows.length,
		message: results.filter((result) => result.status === 'rejected').map((result) => result.reason instanceof Error ? result.reason.message : '一部同期に失敗しました').join('; ') || null,
	};
}

export type { MetaConnection };
