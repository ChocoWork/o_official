/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as deferredGet } from '@/app/api/admin/accounting/deferred-revenue/route';
import { GET as reconciliationGet } from '@/app/api/admin/accounting/reconciliation/route';
import { toJstDate } from '@/lib/accounting/jst-date';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { PERM, claims, createHarness, dbError, uuid } from './accounting-route-harness';

const harness = createHarness({
	verifyAccessToken: verifyAccessToken as jest.Mock,
	checkAuthSessionLiveness: checkAuthSessionLiveness as jest.Mock,
	createServiceRoleClient: createServiceRoleClient as jest.Mock,
	csrf: mockCsrf,
	rate: mockRate,
	audit: mockAudit,
});
const { seq, rpcImpl, grants, read } = harness;

const balance = { through: '2026-10-31', stripe_balance: 120000, ledger_1160: 90000, ledger_1130_stripe: 0, difference: 30000, unjournaled: [{ bucket: 'fee', amount: 30000 }], payout_in_transit_1150: 0 };
const fee = { jst_total: 5500, utc_total: 5400, invoice_total: null, boundary_in: [], boundary_out: [], next_month_adjustments: [], diff_jst_utc: 100, explained_boundary: 100, unexplained_jst_utc: 0, diff_utc_invoice: null, explained_adjustments: null, unexplained_utc_invoice: null, journal_vs_txn_diff: 0 };
const intake = {
	opening_backlog: 100000, intake: 50000, sales_before_return: 30000, closing_backlog: 120000, exceptions: [{ label_key: 'dispute_pending', amount: 0 }], unexplained: 0,
	returns: 2000, booked_sales_net_orders: 28000, return_fee_revenue_4050: 0, other_4010: 0, other_4020: 0, book_sales_total: 28000, unexplained2: 0, dispute_confirmed_by_account: [],
};
const deferredList = { orders: [{ order_id: uuid(600), order_number: 'ORD-00000258', balance: 18750, paid_on: '2026-12-20', unshipped_units: 1, states: { ready: 1 } }], next_after_order: uuid(600), total_balance: 18750 };
const anomalies = { anomalies: [{ order_id: uuid(601), order_number: 'ORD-00000259', balance: -100, reason: 'negative_balance' }] };
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'get_stripe_balance_reconciliation': return { data: balance, error: null };
		case 'get_stripe_fee_reconciliation': return { data: fee, error: null };
		case 'get_intake_reconciliation': return { data: intake, error: null };
		case 'list_deferred_revenue': return { data: deferredList, error: null };
		case 'list_deferred_revenue_anomalies': return { data: anomalies, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};
const base = 'https://example.test/api/admin/accounting';
const getRec = (query: string) => reconciliationGet(new Request(`${base}/reconciliation${query}`));
const getDeferred = (query = '') => deferredGet(new Request(`${base}/deferred-revenue${query}`));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read]);
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/accounting/reconciliation', () => {
	test('FREQ-566-AC-03: 照合のrouteはkindごとに入力を検証し、読み口をそのままno-storeで返す', async () => {
		const stripeBalance = await getRec('?kind=stripe-balance&through=2026-10-31');
		expect(stripeBalance.status).toBe(200);
		expect((await read(stripeBalance)).data).toEqual(balance);
		expect(rpcImpl).toHaveBeenLastCalledWith('get_stripe_balance_reconciliation', { _through: '2026-10-31' });
		const stripeFee = await getRec('?kind=stripe-fee&month=2026-10');
		expect((await read(stripeFee)).data).toEqual(fee);
		expect(rpcImpl).toHaveBeenLastCalledWith('get_stripe_fee_reconciliation', { _month: '2026-10' });
		const intakeResponse = await getRec('?kind=intake&from=2026-10-01&to=2026-10-31');
		expect((await read(intakeResponse)).data).toEqual(intake);
		expect(rpcImpl).toHaveBeenLastCalledWith('get_intake_reconciliation', { _from: '2026-10-01', _to: '2026-10-31' });
		// 認可だけ（CSRF・回数制限・監査は読みに付けない）。
		expect(seq).toEqual(['auth', 'rpc:get_stripe_balance_reconciliation', 'auth', 'rpc:get_stripe_fee_reconciliation', 'auth', 'rpc:get_intake_reconciliation']);
		expect(mockCsrf).not.toHaveBeenCalled(); expect(mockRate).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
	});

	test('FREQ-571-AC-05: 受注残の照合は平らなオブジェクトのまま返し、組み替えない', async () => {
		const body = await read(await getRec('?kind=intake&from=2026-10-01&to=2026-10-31'));
		const data = body.data as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(Object.keys(intake).sort());
		expect(data).not.toHaveProperty('stage1');
		expect(data).not.toHaveProperty('stage2');
		// 1段目と2段目が共有する値は1つだけ。
		expect(data.sales_before_return).toBe(30000);
		// 個人の情報を含まない
		expect(JSON.stringify(body)).not.toMatch(/email|@|"name"/i);
	});

	test('FREQ-566-AC-03: 入力の誤り（kindなし・知らないkind・足りない／余る鍵・暦にない日・向きが逆・重ねた鍵）はDBを呼ばず400', async () => {
		for (const query of [
			'', '?kind=other', '?kind=stripe-balance', '?kind=stripe-balance&through=2026-02-30', '?kind=stripe-balance&through=2026-10-31&month=2026-10',
			'?kind=stripe-fee', '?kind=stripe-fee&month=2026-13', '?kind=stripe-fee&month=2026-10-01', '?kind=stripe-fee&through=2026-10-31',
			'?kind=intake&from=2026-10-01', '?kind=intake&to=2026-10-31', '?kind=intake&from=2026-11-01&to=2026-10-01', '?kind=intake&from=2026/10/01&to=2026-10-31',
			'?kind=intake&from=2026-10-01&to=2026-10-31&limit=5', '?kind=intake&kind=stripe-fee&from=2026-10-01&to=2026-10-31',
		]) {
			const bad = await getRec(query);
			expect([query, bad.status, await read(bad)]).toEqual([query, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		// 同じ日の範囲（from = to）は通る。
		expect((await getRec('?kind=intake&from=2026-10-01&to=2026-10-01')).status).toBe(200);
	});

	test('FREQ-566-AC-03: admin.finance.readだけ。aal1と権限なしは403、DBの拒否は表のとおり、壊れた応答は固定の500', async () => {
		grants.current = [PERM.manage, PERM.settings, PERM.correct];
		expect((await getRec('?kind=stripe-fee&month=2026-10')).status).toBe(403);
		grants.current = [PERM.read];
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await getRec('?kind=stripe-fee&month=2026-10')).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async () => dbError('ACCOUNTING_ARGUMENT_INVALID', '22023'));
		const invalid = await getRec('?kind=intake&from=2020-01-01&to=2026-10-31');
		expect([invalid.status, (await read(invalid)).code]).toEqual([400, 'ACCOUNTING_ARGUMENT_INVALID']);
		rpcImpl.mockImplementation(async () => ({ data: 'not an object', error: null }));
		const broken = await getRec('?kind=stripe-balance&through=2026-10-31');
		expect([broken.status, await read(broken)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
		rpcImpl.mockImplementation(async () => dbError('boom secret', 'XX000', 'secret'));
		const failed = await getRec('?kind=stripe-fee&month=2026-10');
		expect([failed.status, await read(failed)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
	});
});

describe('GET /api/admin/accounting/deferred-revenue', () => {
	test('FREQ-569-AC-04: 繰り越した前受金の一覧と異常の一覧を1つの応答で返す', async () => {
		const response = await getDeferred('?asOf=2026-12-31&limit=50&afterOrder=' + uuid(599));
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ ...deferredList, anomalies: anomalies.anomalies });
		expect(rpcImpl).toHaveBeenCalledWith('list_deferred_revenue', { _as_of: '2026-12-31', _limit: 50, _after_order: uuid(599) });
		expect(rpcImpl).toHaveBeenCalledWith('list_deferred_revenue_anomalies', undefined);
		expect(seq).toEqual(['auth', 'rpc:list_deferred_revenue', 'rpc:list_deferred_revenue_anomalies']);
	});

	test('FREQ-569-AC-04: asOfを省くと今日（日本時間）、件数の既定は100。個人の情報を含まない', async () => {
		const body = await read(await getDeferred());
		expect(rpcImpl).toHaveBeenCalledWith('list_deferred_revenue', { _as_of: toJstDate(new Date()), _limit: 100, _after_order: null });
		expect(JSON.stringify(body)).not.toMatch(/email|@|"name"/i);
	});

	test('FREQ-569-AC-04: 不正な問い合わせはDBを呼ばず400、権限はreadだけ', async () => {
		for (const query of ['?asOf=2026-02-30', '?limit=0', '?limit=201', '?afterOrder=bad', '?x=1', '?asOf=2026-12-31&asOf=2026-12-30']) {
			expect([query, (await getDeferred(query)).status]).toEqual([query, 400]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.manage];
		expect((await getDeferred()).status).toBe(403);
	});
});
