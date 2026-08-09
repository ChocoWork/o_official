import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authorizeMetaAdmin } from '@/lib/meta/admin';
import { getMetaConfig, metaSetupMissing } from '@/lib/meta/config';

export async function GET(request: Request) {
	const authz = await authorizeMetaAdmin(request);
	if (!authz.ok) return authz.response;
	const origin = new URL(request.url).origin;
	const config = getMetaConfig(origin);
	if (!config?.redirectUri) {
		return NextResponse.json({ error: 'Meta API設定が不足しています', missing: metaSetupMissing() }, { status: 503 });
	}
	const state = randomBytes(32).toString('base64url');
	const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
	url.searchParams.set('client_id', config.appId);
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('state', state);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', [
		'instagram_basic',
		'instagram_manage_insights',
		'pages_show_list',
		'pages_read_engagement',
		'ads_read',
		'business_management',
	].join(','));
	const response = NextResponse.redirect(url);
	response.cookies.set('meta_oauth_state', state, {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		path: '/api/admin/kpi/meta/callback',
		maxAge: 600,
	});
	return response;
}
