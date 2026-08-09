import { NextResponse } from 'next/server';
import { authorizeMetaAdmin } from '@/lib/meta/admin';
import { getMetaConfig } from '@/lib/meta/config';
import { metaGraphGet } from '@/lib/meta/graph-client';
import { encryptMetaToken } from '@/lib/meta/token-crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';

type TokenResponse = { access_token?: string; expires_in?: number };
type PageResponse = { data?: Array<{ id: string; instagram_business_account?: { id: string; username?: string } }> };
type AdAccountResponse = { data?: Array<{ id: string; name?: string; account_status?: number }> };

function callbackRedirect(origin: string, result: 'connected' | 'error', reason?: string) {
	const target = new URL('/admin', origin);
	target.searchParams.set('meta', result);
	if (reason) target.searchParams.set('meta_reason', reason);
	return NextResponse.redirect(target);
}

export async function GET(request: Request) {
	const authz = await authorizeMetaAdmin(request);
	if (!authz.ok) return authz.response;
	const url = new URL(request.url);
	const stateCookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('meta_oauth_state='))?.slice('meta_oauth_state='.length);
	if (!stateCookie || stateCookie !== url.searchParams.get('state')) return callbackRedirect(url.origin, 'error', 'state');
	const code = url.searchParams.get('code');
	const config = getMetaConfig(url.origin);
	if (!code || !config?.redirectUri) return callbackRedirect(url.origin, 'error', 'config');

	try {
		const tokenUrl = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
		tokenUrl.searchParams.set('client_id', config.appId);
		tokenUrl.searchParams.set('client_secret', config.appSecret);
		tokenUrl.searchParams.set('redirect_uri', config.redirectUri);
		tokenUrl.searchParams.set('code', code);
		const shortResponse = await fetch(tokenUrl, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
		if (!shortResponse.ok) throw new Error('Meta authorization code exchange failed');
		const shortToken = await shortResponse.json() as TokenResponse;
		if (!shortToken.access_token) throw new Error('Meta access token was not returned');

		const longToken = await metaGraphGet<TokenResponse>('graph.facebook.com', config.graphVersion, 'oauth/access_token', shortToken.access_token, {
			grant_type: 'fb_exchange_token',
			client_id: config.appId,
			client_secret: config.appSecret,
			fb_exchange_token: shortToken.access_token,
		});
		const accessToken = longToken.access_token || shortToken.access_token;
		const pages = await metaGraphGet<PageResponse>('graph.facebook.com', config.graphVersion, 'me/accounts', accessToken, {
			fields: 'id,name,instagram_business_account{id,username}',
		});
		const page = pages.data?.find((item) => item.instagram_business_account);
		if (!page?.instagram_business_account) throw new Error('Instagram professional account was not found');
		const ads = await metaGraphGet<AdAccountResponse>('graph.facebook.com', config.graphVersion, 'me/adaccounts', accessToken, {
			fields: 'id,name,account_status',
		});
		const adAccount = ads.data?.find((item) => item.account_status === 1) ?? ads.data?.[0];
		const expiresIn = longToken.expires_in ?? shortToken.expires_in;
		const supabase = await createServiceRoleClient();
		const { error } = await supabase.from('admin_meta_kpi_connections').upsert({
			provider: 'meta',
			instagram_user_id: page.instagram_business_account.id,
			instagram_username: page.instagram_business_account.username ?? null,
			facebook_page_id: page.id,
			ad_account_id: adAccount?.id ?? null,
			ad_account_name: adAccount?.name ?? null,
			access_token_encrypted: encryptMetaToken(accessToken, config.encryptionKey),
			token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
			connected_by: authz.userId,
			updated_at: new Date().toISOString(),
		}, { onConflict: 'provider' });
		if (error) throw new Error(error.message);
		const response = callbackRedirect(url.origin, 'connected');
		response.cookies.delete('meta_oauth_state');
		return response;
	} catch (error) {
		console.error('[Meta OAuth callback] Failed:', error instanceof Error ? error.message : 'unknown error');
		return callbackRedirect(url.origin, 'error', 'oauth');
	}
}
