/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as taxRefundsGet } from '@/app/api/admin/accounting/tax-refunds/route';
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

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	entry_id: uuid(1), line_key: `${uuid(1)}:1`, refund_date: '2026-11-10', order_id: uuid(2), order_number: 'ORD-00000000', amount: 1100, tax_rate: 10, tax_amount: 100,
	item_summary: 'シャツ×1', original_sale_date: '2026-11-02', sale_period_status: 'taxable', refund_period_status: 'taxable', exclusion: 'none', ...overrides,
});
const state = {
	list: { rows: [row()], next_after_date: '2026-11-10', next_after_key: `${uuid(1)}:1`, retention_note: '消費税法施行令58条の2により7年間保存する' } as Record<string, unknown>,
	totals: { included_amount: 1100, included_tax: 100, excluded_amount: 0, excluded_by: { before_sale: 0, sale_unbooked: 0, exempt_sale_14_1_6: 0, after_exit_14_1_7: 0 } } as Record<string, unknown>,
};
const base = 'https://example.test/api/admin/accounting/tax-refunds';
const get = (query = '?from=2026-11&to=2026-11') => taxRefundsGet(new Request(`${base}${query}`));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read]);
	state.list = { rows: [row()], next_after_date: '2026-11-10', next_after_key: `${uuid(1)}:1`, retention_note: '消費税法施行令58条の2により7年間保存する' };
	rpcImpl.mockImplementation(async (name: string) => {
		if (name === 'list_consumption_tax_refunds') return { data: state.list, error: null };
		if (name === 'get_consumption_tax_refund_totals') return { data: state.totals, error: null };
		throw new Error(`unexpected rpc ${name}`);
	});
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/accounting/tax-refunds', () => {
	test('FREQ-583-AC-01: 消費税用の一覧のrouteは no-store で、finance.read だけで読め、応答に名前・メールの鍵が無い', async () => {
		const response = await get();
		expect(response.status).toBe(200);
		const json = await read(response);
		const data = json.data as { rows: unknown[]; totals: unknown; nextAfterDate: string; nextAfterKey: string; retentionNote: string };
		expect(data.rows).toHaveLength(1);
		expect(data.nextAfterDate).toBe('2026-11-10');
		expect(data.nextAfterKey).toBe(`${uuid(1)}:1`);
		expect(data.retentionNote).toContain('7年間');
		expect(data.totals).toEqual({ includedAmount: 1100, includedTax: 100, excludedAmount: 0, excludedBy: { beforeSale: 0, saleUnbooked: 0, exemptSale1416: 0, afterExit1417: 0 } });
		expect(JSON.stringify(json)).not.toMatch(/mail|name"|address|phone/i);
		expect(seq).toEqual(['auth', 'rpc:list_consumption_tax_refunds', 'rpc:get_consumption_tax_refund_totals']);
		expect(rpcImpl).toHaveBeenNthCalledWith(1, 'list_consumption_tax_refunds', { _from: '2026-11-01', _to: '2026-11-30', _limit: 100, _after_date: null, _after_key: null });
		expect(rpcImpl).toHaveBeenNthCalledWith(2, 'get_consumption_tax_refund_totals', { _from: '2026-11-01', _to: '2026-11-30' });
		grants.current = [PERM.manage, PERM.correct, PERM.settings];
		const denied = await get();
		expect(denied.status).toBe(403);
		expect(denied.headers.get('cache-control')).toContain('no-store');
	});

	test('FREQ-583-AC-01: 期間（月・最大12か月）と件数を検証し、不正なら400で DB を呼ばない（失敗も no-store）', async () => {
		for (const query of ['', '?from=2026-11', '?from=2026-12&to=2026-11', '?from=2026-01&to=2027-01', '?from=2026-11-01&to=2026-11-30', '?from=2026-11&to=2026-11&limit=201', '?from=2026-11&to=2026-11&limit=0', '?from=2026-11&to=2026-11&x=1']) {
			const response = await get(query);
			expect([query, response.status, await read(response)]).toEqual([query, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		const limited = await get('?from=2026-01&to=2026-12&limit=200');
		expect(limited.status).toBe(200);
		expect(rpcImpl).toHaveBeenCalledWith('list_consumption_tax_refunds', expect.objectContaining({ _from: '2026-01-01', _to: '2026-12-31', _limit: 200 }));
	});

	test('FREQ-583-AC-03: 一覧の続きの目印が不正なら400（片方だけ・形の誤り）、正しければ DB へ渡す。古い目印を DB が断っても400', async () => {
		for (const bad of ['&afterDate=2026-11-10', `&afterKey=${uuid(1)}:1`, `&afterDate=2026-11-10&afterKey=${uuid(1)}`, `&afterDate=2026-11-10&afterKey=${uuid(1)}:0`, `&afterDate=2026-13-10&afterKey=${uuid(1)}:1`, '&afterDate=2026-11-10&afterKey=x:1']) {
			const response = await get(`?from=2026-11&to=2026-11${bad}`);
			expect([bad, response.status]).toEqual([bad, 400]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		const ok = await get(`?from=2026-11&to=2026-11&afterDate=2026-11-10&afterKey=${uuid(1)}:1`);
		expect(ok.status).toBe(200);
		expect(rpcImpl).toHaveBeenCalledWith('list_consumption_tax_refunds', expect.objectContaining({ _after_date: '2026-11-10', _after_key: `${uuid(1)}:1` }));
		rpcImpl.mockImplementation(async () => dbError('ACCOUNTING_ARGUMENT_INVALID', '22023', 'PRIVATE-MARKER'));
		const refused = await get(`?from=2026-11&to=2026-11&afterDate=2026-11-10&afterKey=${uuid(1)}:1`);
		expect([refused.status, await read(refused)]).toEqual([400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
	});

	test('FREQ-583-AC-02: 対象外の5つの理由（sale_unbooked を含む）の行と、元の売上の日が空の行を受け取り、DBの形が崩れたら固定の500', async () => {
		state.list = {
			...state.list,
			rows: [row({ exclusion: 'sale_unbooked', original_sale_date: null, sale_period_status: null }), row({ exclusion: 'before_sale', original_sale_date: null, sale_period_status: null })],
		};
		state.totals = { included_amount: 0, included_tax: 0, excluded_amount: 2200, excluded_by: { before_sale: 1100, sale_unbooked: 1100, exempt_sale_14_1_6: 0, after_exit_14_1_7: 0 } };
		const response = await get();
		expect(response.status).toBe(200);
		const data = (await read(response)).data as { rows: Array<{ exclusion: string; originalSaleDate: string | null }>; totals: { excludedBy: { saleUnbooked: number } } };
		expect(data.rows.map((r) => [r.exclusion, r.originalSaleDate])).toEqual([['sale_unbooked', null], ['before_sale', null]]);
		expect(data.totals.excludedBy.saleUnbooked).toBe(1100);
		state.list = { ...state.list, rows: [row({ exclusion: 'unknown' })] };
		const broken = await get();
		expect([broken.status, await read(broken)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
	});

	test('FREQ-583-AC-01: aal1は403で、DB の拒否も no-store で返す', async () => {
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		const denied = await get();
		expect(denied.status).toBe(403);
		expect(denied.headers.get('cache-control')).toContain('no-store');
		expect(rpcImpl).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async () => dbError('ACCOUNTING_FORBIDDEN', '42501'));
		const forbidden = await get();
		expect(forbidden.status).toBe(403);
		expect(forbidden.headers.get('cache-control')).toContain('no-store');
	});
});
