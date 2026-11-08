/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as traceGet } from '@/app/api/admin/accounting/shipment-trace/route';
import { GET as yearEndGet, POST as yearEndPost, PUT as yearEndPut } from '@/app/api/admin/accounting/year-end-shipments/route';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ACTOR, KEY, PERM, claims, createHarness, dbError, uuid } from './accounting-route-harness';

const harness = createHarness({
	verifyAccessToken: verifyAccessToken as jest.Mock,
	checkAuthSessionLiveness: checkAuthSessionLiveness as jest.Mock,
	createServiceRoleClient: createServiceRoleClient as jest.Mock,
	csrf: mockCsrf,
	rate: mockRate,
	audit: mockAudit,
});
const { seq, rpcImpl, grants, read } = harness;

const SLIP = uuid(700);
const slipRow = {
	slip_id: SLIP, number: 'SL-20261231-0001', shipment_date: '2026-12-31', confirmed_at: '2027-01-02T01:00:00+00:00', stage: 'confirmed',
	shipping_carrier: 'yamato', tracking_number: '1234-5678', checked_at: null, checked_by: null, check_stale: false,
};
const list = { slips: [slipRow], next_after_date: '2026-12-31', next_after_slip: SLIP };
const options = { carrier_date_check_enabled: false, changed_at: '2026-11-09T00:00:00+00:00', changed_by: null, version: '1' };
const gaps = { enabled: true, slips: [{ slip_id: SLIP, number: 'SL-20261231-0001', shipment_date: '2026-12-31', carrier_accepted_date: '2027-01-02', gap_days: 2 }], has_more: true };
const trace = {
	slip: { number: 'SL-20261231-0001', confirmed_at: '2027-01-02T01:00:00+00:00', shipment_date: '2026-12-31', stage: 'confirmed' },
	history: [{ version: 2, kind: 'corrected', previous_date: '2027-01-02', new_date: '2026-12-31', reason: '記録の訂正', actor_id: ACTOR, created_at: '2027-01-03T00:00:00+00:00' }],
	entries: [{ entry_id: uuid(300), entry_no: 3, event_kind: 'shipment_confirmed', entry_date: '2026-12-31', recorded_at: '2027-01-02T01:00:00+00:00', reverses_entry_id: null }],
};
const state = { gaps: gaps as Record<string, unknown> };
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'list_year_end_shipments': return { data: list, error: null };
		case 'get_shipping_options': return { data: options, error: null };
		case 'list_carrier_date_gaps': return { data: state.gaps, error: null };
		case 'admin_check_year_end_shipment': return { data: { slip_id: SLIP, checked_by: ACTOR, checked_at: '2027-01-03T00:00:00+00:00', note: null, checked_shipment_date: '2026-12-31', checked_tracking_version: 1, created: true }, error: null };
		case 'admin_set_shipping_options': return { data: { ...options, carrier_date_check_enabled: true, changed_by: ACTOR, version: '2' }, error: null };
		case 'get_shipment_journal_trace': return { data: trace, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};

const base = 'https://example.test/api/admin/accounting';
const RANGE = 'from=2026-12-25&to=2027-01-10';
const getYearEnd = (query = RANGE) => yearEndGet(new Request(`${base}/year-end-shipments?${query}`));
const postCheck = (value: unknown = { slipId: SLIP, note: null, requestKey: KEY }) => yearEndPost(new Request(`${base}/year-end-shipments`, { method: 'POST', body: JSON.stringify(value) }));
const putOptions = (value: unknown = { carrierDateCheckEnabled: true, expectedVersion: '1', requestKey: KEY }) => yearEndPut(new Request(`${base}/year-end-shipments`, { method: 'PUT', body: JSON.stringify(value) }));
const getTrace = (query = `?slipId=${SLIP}`) => traceGet(new Request(`${base}/shipment-trace${query}`));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read, PERM.manage, PERM.correct, PERM.settings]);
	state.gaps = gaps;
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/accounting/year-end-shipments', () => {
	test('FREQ-574-AC-01: 年末の発送票の一覧が運送会社・追跡番号・出荷した日つきで続きの目印つきに出て、設定と受付日とのずれが付く', async () => {
		grants.current = [PERM.read];
		const response = await getYearEnd(`${RANGE}&limit=50&afterDate=2026-12-30&afterSlip=${uuid(699)}`);
		expect(response.status).toBe(200);
		const body = await read(response);
		expect(body.data).toEqual({ ...list, options, carrier_gaps: gaps });
		expect(rpcImpl).toHaveBeenCalledWith('list_year_end_shipments', { _from: '2026-12-25', _to: '2027-01-10', _limit: 50, _after_date: '2026-12-30', _after_slip: uuid(699) });
		expect(rpcImpl).toHaveBeenCalledWith('list_carrier_date_gaps', { _from: '2026-12-25', _to: '2027-01-10', _limit: 50 });
		expect(rpcImpl).toHaveBeenCalledWith('get_shipping_options', undefined);
		expect(seq).toEqual(['auth', 'rpc:list_year_end_shipments', 'rpc:get_shipping_options', 'rpc:list_carrier_date_gaps']);
		// お客様の名前・住所・メールを持たない（運送会社・追跡番号・出荷した日は出す）。
		const text = JSON.stringify(body);
		expect(text).not.toMatch(/email|address|"name"|customer|phone/i);
		expect(text).toContain('1234-5678');
	});

	test('FREQ-574-AC-04: 受付日の照らし合わせがオフの間は空の一覧（enabled:false）をそのまま返し、has_moreも通す', async () => {
		state.gaps = { enabled: false, slips: [], has_more: false };
		const off = await read(await getYearEnd());
		expect((off.data as { carrier_gaps: unknown }).carrier_gaps).toEqual({ enabled: false, slips: [], has_more: false });
		state.gaps = gaps;
		const on = await read(await getYearEnd());
		expect(((on.data as { carrier_gaps: { has_more: boolean } }).carrier_gaps).has_more).toBe(true);
		expect(rpcImpl).toHaveBeenCalledWith('list_year_end_shipments', { _from: '2026-12-25', _to: '2027-01-10', _limit: 100, _after_date: null, _after_slip: null });
	});

	test('FREQ-574-AC-01: 範囲が60日を超える・逆・日が不正・件数や目印の誤りはDBを呼ばず400', async () => {
		for (const query of [
			'', 'from=2026-12-25', 'to=2027-01-10', 'from=2027-01-10&to=2026-12-25', 'from=2026-01-01&to=2026-12-31', 'from=2026-12-25&to=2027-02-23', 'from=2026-02-30&to=2026-03-01',
			`${RANGE}&limit=0`, `${RANGE}&limit=201`, `${RANGE}&afterDate=2026-12-30`, `${RANGE}&afterSlip=${uuid(699)}`, `${RANGE}&afterDate=2026-12-30&afterSlip=bad`, `${RANGE}&x=1`,
			`${RANGE}&from=2026-12-26`,
		]) {
			const bad = await getYearEnd(query);
			expect([query, bad.status, await read(bad)]).toEqual([query, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		// ちょうど60日分（差が59日）は通る。
		expect((await getYearEnd('from=2026-12-01&to=2027-01-29')).status).toBe(200);
	});

	test('FREQ-574-AC-01: 古い続きの目印は一般の400でなく409で、最初から読み直させる', async () => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'list_year_end_shipments' ? dbError('ACCOUNTING_ARGUMENT_INVALID', '22023') : defaultRpc(name)));
		const stale = await getYearEnd(`${RANGE}&afterDate=2026-12-30&afterSlip=${uuid(699)}`);
		expect([stale.status, await read(stale)]).toEqual([409, { code: 'ACCOUNTING_LIST_RESTART', error: '一覧が変わりました。最初から読み直してください。' }]);
		const plain = await getYearEnd();
		expect([plain.status, (await read(plain)).code]).toEqual([400, 'ACCOUNTING_ARGUMENT_INVALID']);
	});

	test('FREQ-574-AC-01: 権限はadmin.finance.readだけ。aal1は403、壊れた応答は固定の500', async () => {
		grants.current = [PERM.manage, PERM.settings];
		expect((await getYearEnd()).status).toBe(403);
		grants.current = [PERM.read];
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await getYearEnd()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async (name: string) => (name === 'get_shipping_options' ? { data: [], error: null } : defaultRpc(name)));
		const broken = await getYearEnd();
		expect([broken.status, await read(broken)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
	});
});

describe('POST /api/admin/accounting/year-end-shipments（確かめた印）', () => {
	test('FREQ-574-AC-02: 確かめた印のPOSTは権限のある人だけで、監査は発送票の番号と結果だけ', async () => {
		grants.current = [PERM.read, PERM.correct, PERM.settings];
		expect((await postCheck()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.manage];
		seq.length = 0;
		const response = await postCheck({ slipId: SLIP, note: '確認した', requestKey: KEY });
		expect(response.status).toBe(200);
		expect(((await read(response)).data as { check: { created: boolean } }).check.created).toBe(true);
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_check_year_end_shipment', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_check_year_end_shipment', { _actor_id: ACTOR, _slip_id: SLIP, _note: '確認した', _request_key: KEY });
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.year_end.check', actor_id: ACTOR, resource: 'accounting', resource_id: SLIP, outcome: 'success',
			metadata: { slip_id: SLIP, result: 'checked' },
		});
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('確認した');
	});

	test('FREQ-574-AC-02: 同じ状態の再送は二重に付けず、結果は「既に確かめた」と残す', async () => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_check_year_end_shipment' ? { data: { slip_id: SLIP, checked_by: ACTOR, checked_at: '2027-01-03T00:00:00+00:00', note: null, checked_shipment_date: '2026-12-31', checked_tracking_version: 1, created: false }, error: null } : defaultRpc(name)));
		expect((await postCheck()).status).toBe(200);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { slip_id: SLIP, result: 'already_checked' } }));
	});

	test('FREQ-574-AC-02: 不正な入力・CSRF・429はDBを呼ばず、存在しない発送票は404', async () => {
		for (const value of [{ slipId: 'bad', note: null, requestKey: KEY }, { slipId: SLIP, note: 'あ'.repeat(201), requestKey: KEY }, { slipId: SLIP, note: 3, requestKey: KEY }, { slipId: SLIP, note: null }, { slipId: SLIP, note: null, requestKey: KEY, checkedBy: ACTOR }, null]) {
			expect([JSON.stringify(value), (await postCheck(value)).status]).toEqual([JSON.stringify(value), 400]);
		}
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await postCheck()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await postCheck()).status).toBe(429);
		expect(rpcImpl).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_check_year_end_shipment' ? dbError('ACCOUNTING_NOT_FOUND', 'P0002') : defaultRpc(name)));
		const missing = await postCheck();
		expect([missing.status, await read(missing)]).toEqual([404, { code: 'ACCOUNTING_NOT_FOUND', error: '会計の記録が見つかりません。' }]);
	});
});

describe('PUT /api/admin/accounting/year-end-shipments（運送会社の受付日の設定）', () => {
	test('FREQ-574-AC-03: 設定の切り替えはadmin.accounting.settings.manageの人だけで、監査は結果だけ', async () => {
		grants.current = [PERM.read, PERM.manage, PERM.correct];
		expect((await putOptions()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.settings];
		const response = await putOptions();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ options: { ...options, carrier_date_check_enabled: true, changed_by: ACTOR, version: '2' } });
		expect(rpcImpl).toHaveBeenCalledWith('admin_set_shipping_options', { _actor_id: ACTOR, _carrier_date_check_enabled: true, _expected_version: '1', _request_key: KEY });
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.shipping.options', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success', metadata: { result: 'enabled' },
		});
		await putOptions({ carrierDateCheckEnabled: false, expectedVersion: '2', requestKey: KEY });
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { result: 'disabled' } }));
	});

	test('FREQ-574-AC-03: 版違いは409、不正な入力はDBを呼ばず400', async () => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_shipping_options' ? dbError('ACCOUNTING_VERSION_CONFLICT', '40001') : defaultRpc(name)));
		const conflict = await putOptions();
		expect([conflict.status, (await read(conflict)).code]).toEqual([409, 'ACCOUNTING_VERSION_CONFLICT']);
		rpcImpl.mockClear();
		for (const value of [{ carrierDateCheckEnabled: 'true', expectedVersion: '1', requestKey: KEY }, { carrierDateCheckEnabled: true, expectedVersion: null, requestKey: KEY }, { carrierDateCheckEnabled: true, expectedVersion: '0', requestKey: KEY }, { carrierDateCheckEnabled: true, expectedVersion: '1' }, { carrierDateCheckEnabled: true, expectedVersion: '1', requestKey: KEY, x: 1 }]) {
			expect([JSON.stringify(value), (await putOptions(value)).status]).toEqual([JSON.stringify(value), 400]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
	});
});

describe('GET /api/admin/accounting/shipment-trace', () => {
	test('FREQ-564-AC-03: 発送票の跡のrouteは発送票の番号・直した理由・人・前後の日と仕訳を返す', async () => {
		grants.current = [PERM.read];
		const response = await getTrace();
		expect(response.status).toBe(200);
		const data = (await read(response)).data as typeof trace;
		expect(data).toEqual(trace);
		expect(data.slip.number).toBe('SL-20261231-0001');
		expect(data.history[0]).toMatchObject({ reason: '記録の訂正', actor_id: ACTOR, previous_date: '2027-01-02', new_date: '2026-12-31' });
		expect(data.entries[0].event_kind).toBe('shipment_confirmed');
		expect(rpcImpl).toHaveBeenCalledWith('get_shipment_journal_trace', { _slip_id: SLIP });
		expect(seq).toEqual(['auth', 'rpc:get_shipment_journal_trace']);
		// お客様の名前・メール・住所を持たない。
		expect(JSON.stringify(data)).not.toMatch(/email|address|customer|phone/i);
	});

	test('FREQ-564-AC-03: slipIdの誤りは400、無い発送票は404、権限はreadだけ', async () => {
		for (const query of ['', '?slipId=bad', `?slipId=${SLIP}&slipId=${SLIP}`, `?slipId=${SLIP}&x=1`]) {
			expect([query, (await getTrace(query)).status]).toEqual([query, 400]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async (name: string) => (name === 'get_shipment_journal_trace' ? dbError('ACCOUNTING_NOT_FOUND', 'P0002') : defaultRpc(name)));
		const missing = await getTrace();
		expect([missing.status, await read(missing)]).toEqual([404, { code: 'ACCOUNTING_NOT_FOUND', error: '会計の記録が見つかりません。' }]);
		grants.current = [PERM.manage];
		expect((await getTrace()).status).toBe(403);
	});
});
