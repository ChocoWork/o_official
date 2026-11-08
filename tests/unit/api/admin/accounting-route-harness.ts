// 会計の route の単体で共通の道具。jest.mock は各試験の先頭に置き（巻き上げのため）、作った jest.fn をここへ渡す。
// 認可（verifyAccessToken・権限の表）→ CSRF → IP/actor の制限 → store の rpc → 監査 の順を seq に記録する。

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ACTOR = uuid(90);
export const KEY = uuid(91);

export const PERM = {
	read: 'admin.finance.read',
	manage: 'admin.finance.manage',
	settings: 'admin.accounting.settings.manage',
	correct: 'admin.accounting.entries.correct',
} as const;

export const claims = (aal: string) => ({
	sub: ACTOR,
	session_id: 'session-1',
	aal,
	email: 'owner@example.test',
	app_metadata: { role: 'admin' },
});

export const dbError = (message: string, code: string, details: string | null = null) => ({
	data: null,
	error: { message, code, details, hint: null },
});

type Mocks = {
	verifyAccessToken: jest.Mock;
	checkAuthSessionLiveness: jest.Mock;
	createServiceRoleClient: jest.Mock;
	csrf: jest.Mock;
	rate: jest.Mock;
	audit: jest.Mock;
};

export function createHarness(mocks: Mocks) {
	const seq: string[] = [];
	const rpcImpl = jest.fn();
	const tableImpl = jest.fn();
	const grants = { current: [] as string[] };
	const service = {
		from: (table: string) => {
			if (table === 'accounting_stripe_invoice_records') {
				const chain = {
					select: () => chain,
					eq: () => chain,
					maybeSingle: async () => {
						seq.push(`table:${table}`);
						return tableImpl(table);
					},
				};
				return chain;
			}
			const chain = {
				select: () => chain,
				eq: () => chain,
				or: async () => ({
					data: [{ roles: { role_permissions: grants.current.map((code) => ({ permissions: { code } })) } }],
					error: null,
				}),
			};
			return chain;
		},
		rpc: (name: string, args: Record<string, unknown>) => {
			seq.push(`rpc:${name}`);
			return rpcImpl(name, args);
		},
	};

	/** beforeEach から呼ぶ。`jest.resetAllMocks()` のあとに。 */
	function setup(initialGrants: string[]) {
		seq.length = 0;
		grants.current = [...initialGrants];
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
		mocks.verifyAccessToken.mockImplementation(async () => {
			seq.push('auth');
			return { ok: true, claims: claims('aal2') };
		});
		mocks.checkAuthSessionLiveness.mockResolvedValue('active');
		mocks.createServiceRoleClient.mockResolvedValue(service);
		mocks.csrf.mockImplementation(() => {
			seq.push('csrf');
		});
		mocks.rate.mockImplementation(async (arg: { endpoint: string; subject?: string }) => {
			seq.push(`${arg.endpoint}:${arg.subject ? 'actor' : 'ip'}`);
			return undefined;
		});
		mocks.audit.mockImplementation(async () => {
			seq.push('audit');
		});
	}

	async function read(response: Response) {
		expect(response.headers.get('cache-control')).toContain('no-store');
		return (await response.json()) as Record<string, unknown>;
	}

	return { seq, rpcImpl, tableImpl, grants, service, setup, read };
}

/** 書き込みの route が、断る時に store（rpc）と監査へ進まないことを確かめる。 */
export type StopCase = [label: string, arrange: () => void, status: number];
