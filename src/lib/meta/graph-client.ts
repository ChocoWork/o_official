import 'server-only';

type GraphErrorPayload = {
	error?: { message?: string; code?: number; error_subcode?: number };
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ALLOWED_GRAPH_HOSTS = new Set(['graph.facebook.com', 'graph.instagram.com']);

type GraphPage<T> = {
	data?: T[];
	paging?: { next?: string };
};

async function metaGraphFetch<T>(url: URL, accessToken: string): Promise<T> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${accessToken}` },
			cache: 'no-store',
			signal: AbortSignal.timeout(15_000),
		});
		if (response.ok) {
			return await response.json() as T;
		}

		const body = await response.json().catch(() => ({})) as GraphErrorPayload;
		if (!RETRYABLE_STATUS.has(response.status) || attempt === 2) {
			throw new Error(`Meta API request failed (${response.status}): ${body.error?.message || 'unknown error'}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
	}
	throw new Error('Meta API request failed');
}

function buildGraphUrl(
	host: 'graph.facebook.com' | 'graph.instagram.com',
	version: string,
	path: string,
	params: Record<string, string>,
): URL {
	const url = new URL(`https://${host}/${version}/${path.replace(/^\//, '')}`);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url;
}

function parsePagingUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:' || !ALLOWED_GRAPH_HOSTS.has(url.hostname)) {
		throw new Error('Invalid Meta Graph paging URL');
	}
	return url;
}

export async function metaGraphGet<T>(
	host: 'graph.facebook.com' | 'graph.instagram.com',
	version: string,
	path: string,
	accessToken: string,
	params: Record<string, string> = {},
): Promise<T> {
	return metaGraphFetch<T>(buildGraphUrl(host, version, path, params), accessToken);
}

export async function metaGraphGetAll<T>(
	host: 'graph.facebook.com' | 'graph.instagram.com',
	version: string,
	path: string,
	accessToken: string,
	params: Record<string, string> = {},
): Promise<T[]> {
	const rows: T[] = [];
	let nextUrl: URL | null = buildGraphUrl(host, version, path, params);

	while (nextUrl) {
		const page: GraphPage<T> = await metaGraphFetch<GraphPage<T>>(nextUrl, accessToken);
		rows.push(...(page.data ?? []));
		nextUrl = page.paging?.next ? parsePagingUrl(page.paging.next) : null;
	}

	return rows;
}
