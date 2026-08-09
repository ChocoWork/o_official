import 'server-only';

const DEFAULT_GRAPH_VERSION = 'v25.0';

export type MetaConfig = {
	appId: string;
	appSecret: string;
	graphVersion: string;
	redirectUri: string | null;
	encryptionKey: Buffer;
};

export function getMetaConfig(origin?: string): MetaConfig | null {
	const appId = process.env.META_APP_ID;
	const appSecret = process.env.META_APP_SECRET;
	const encryptionKeyValue = process.env.META_TOKEN_ENCRYPTION_KEY;
	if (!appId || !appSecret || !encryptionKeyValue) {
		return null;
	}

	const encryptionKey = Buffer.from(encryptionKeyValue, 'base64');
	if (encryptionKey.length !== 32) {
		throw new Error('META_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
	}

	return {
		appId,
		appSecret,
		graphVersion: process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
		redirectUri: process.env.META_REDIRECT_URI || (origin ? `${origin}/api/admin/kpi/meta/callback` : null),
		encryptionKey,
	};
}

export function metaSetupMissing(): string[] {
	return ['META_APP_ID', 'META_APP_SECRET', 'META_TOKEN_ENCRYPTION_KEY'].filter((key) => !process.env[key]);
}
