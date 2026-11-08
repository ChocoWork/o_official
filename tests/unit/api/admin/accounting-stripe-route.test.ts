/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { POST as topupPost } from '@/app/api/admin/accounting/balance-topups/route';
import { GET as invoiceGet, PUT as invoicePut } from '@/app/api/admin/accounting/stripe-invoices/route';
import { toJstDate } from '@/lib/accounting/jst-date';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ACTOR, KEY, PERM, claims, createHarness, dbError } from './accounting-route-harness';

const harness = createHarness({
	verifyAccessToken: verifyAccessToken as jest.Mock,
	checkAuthSessionLiveness: checkAuthSessionLiveness as jest.Mock,
	createServiceRoleClient: createServiceRoleClient as jest.Mock,
	csrf: mockCsrf,
	rate: mockRate,
	audit: mockAudit,
});
const { seq, rpcImpl, tableImpl, grants, read } = harness;

const TODAY = toJstDate(new Date());
const dayBefore = (days: number): string => toJstDate(new Date(Date.now() - days * 86_400_000));
const settingsRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	business_start_date: null, cutover_on: '2026-01-01', current_business_type: 'soleProprietor', sole_business_ended_on: null, version: '1', sole_end_changes: [], ...overrides,
});
const invoiceRow = { invoice_month: '2026-10', invoice_total: 12345, invoice_tax: 1122, document_ref: 'INV-1', entered_at: '2026-11-09T00:00:00+00:00', version: 1 };
const state = { settings: settingsRow() };
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'get_accounting_settings': return { data: state.settings, error: null };
		case 'admin_set_stripe_invoice_record': return { data: { invoice_month: '2026-10', invoice_total: 12345, invoice_tax: 1122, document_ref: 'INV-1', version: '2', entered_at: '2026-11-09T00:00:00+00:00' }, error: null };
		case 'admin_record_balance_topup': return { data: { entry_id: '00000000-0000-4000-8000-000000000300', entry_no: 9, period_id: '00000000-0000-4000-8000-000000000001', created: true }, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};

const base = 'https://example.test/api/admin/accounting';
const getInvoice = (query = '?month=2026-10') => invoiceGet(new Request(`${base}/stripe-invoices${query}`));
const invoiceBody = { month: '2026-10', total: 12345, tax: 1122, documentRef: 'INV-1', expectedVersion: null, requestKey: KEY };
const putInvoice = (value: unknown = invoiceBody) => invoicePut(new Request(`${base}/stripe-invoices`, { method: 'PUT', body: JSON.stringify(value) }));
const topupBody = { amount: 30000, bankDate: TODAY, bankTxnNo: 'BANK-20261109-01', stripeTxnId: 'txn_1AbC', note: '残高の補充', requestKey: KEY };
const postTopup = (value: unknown = topupBody) => topupPost(new Request(`${base}/balance-topups`, { method: 'POST', body: JSON.stringify(value) }));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read, PERM.manage, PERM.correct, PERM.settings]);
	state.settings = settingsRow();
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
	tableImpl.mockResolvedValue({ data: invoiceRow, error: null });
});
afterEach(() => jest.restoreAllMocks());

describe('/api/admin/accounting/stripe-invoices', () => {
	test('FREQ-566-AC-02: 請求書の記録のGETは月の記録を返し、入力者の番号を出さない。無ければnull', async () => {
		grants.current = [PERM.read];
		const response = await getInvoice();
		expect(response.status).toBe(200);
		const body = await read(response);
		expect(body.data).toEqual({ record: { month: '2026-10', total: 12345, tax: 1122, documentRef: 'INV-1', enteredAt: '2026-11-09T00:00:00+00:00', version: '1' } });
		expect(seq).toEqual(['auth', 'table:accounting_stripe_invoice_records']);
		tableImpl.mockResolvedValue({ data: null, error: null });
		expect((await read(await getInvoice())).data).toEqual({ record: null });
		for (const query of ['', '?month=2026-13', '?month=2026-1', '?month=2026-10-01', '?month=2026-10&month=2026-09', '?month=2026-10&x=1']) {
			expect([query, (await getInvoice(query)).status]).toEqual([query, 400]);
		}
		grants.current = [PERM.manage, PERM.settings];
		expect((await getInvoice()).status).toBe(403);
	});

	test('FREQ-566-AC-02: 表を読めない時・形が壊れた時は固定の500', async () => {
		tableImpl.mockResolvedValue({ data: null, error: { message: 'boom secret', code: 'XX000', details: 'secret' } });
		const failed = await getInvoice();
		expect([failed.status, await read(failed)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
		tableImpl.mockResolvedValue({ data: { ...invoiceRow, entered_by: ACTOR }, error: null });
		expect((await getInvoice()).status).toBe(500);
	});

	test('FREQ-566-AC-02: 請求書の記録のPUTはadmin.finance.manageの人だけで、監査に月と結果だけ残し金額・文書の参照を入れない', async () => {
		grants.current = [PERM.read, PERM.correct, PERM.settings];
		expect((await putInvoice()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.manage];
		seq.length = 0;
		const response = await putInvoice();
		expect(response.status).toBe(200);
		expect(((await read(response)).data as { record: { version: string } }).record.version).toBe('2');
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_set_stripe_invoice_record', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_set_stripe_invoice_record', {
			_actor_id: ACTOR, _invoice_month: '2026-10', _invoice_total: 12345, _invoice_tax: 1122, _document_ref: 'INV-1', _expected_version: null, _request_key: KEY,
		});
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.stripe.invoice', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success',
			metadata: { month: '2026-10', result: 'saved' },
		});
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of ['12345', '1122', 'INV-1', KEY]) expect(audit).not.toContain(secret);
	});

	test('FREQ-566-AC-02: 請求書の記録のPUTは版違いを409で返す', async () => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_stripe_invoice_record' ? dbError('ACCOUNTING_VERSION_CONFLICT', '40001') : defaultRpc(name)));
		const conflict = await putInvoice({ ...invoiceBody, expectedVersion: '1' });
		expect([conflict.status, await read(conflict)]).toEqual([409, { code: 'ACCOUNTING_VERSION_CONFLICT', error: '設定が変わりました。読み直してください。' }]);
		expect(rpcImpl).toHaveBeenCalledWith('admin_set_stripe_invoice_record', expect.objectContaining({ _expected_version: '1' }));
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: 'ACCOUNTING_VERSION_CONFLICT' } }));
	});

	test('FREQ-566-AC-02: 不正な金額・月・版・知らない鍵・CSRF・429はDBを呼ばない', async () => {
		const bad: [string, unknown][] = [
			['月が不正', { ...invoiceBody, month: '2026-13' }], ['合計が負', { ...invoiceBody, total: -1 }], ['合計が小数', { ...invoiceBody, total: 1.5 }],
			['合計が文字', { ...invoiceBody, total: '100' }], ['合計が上限超え', { ...invoiceBody, total: Number.MAX_SAFE_INTEGER + 1 }], ['税が負', { ...invoiceBody, tax: -1 }],
			['参照が201文字', { ...invoiceBody, documentRef: 'a'.repeat(201) }], ['版が数値', { ...invoiceBody, expectedVersion: 1 }], ['版が0', { ...invoiceBody, expectedVersion: '0' }],
			['知らない鍵', { ...invoiceBody, enteredBy: ACTOR }], ['要求番号なし', { ...invoiceBody, requestKey: undefined }],
		];
		for (const [label, value] of bad) {
			const response = await putInvoice(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await putInvoice()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await putInvoice()).status).toBe(429);
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await putInvoice()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		// 0円・参照なしは通る。
		expect((await putInvoice({ ...invoiceBody, total: 0, tax: 0, documentRef: null })).status).toBe(200);
	});
});

describe('POST /api/admin/accounting/balance-topups', () => {
	test('FREQ-565-AC-06: 残高の補充のrouteはadmin.finance.manageの人だけで、監査は結果だけ（金額・取引の番号・メモを入れない）', async () => {
		grants.current = [PERM.read, PERM.correct, PERM.settings];
		expect((await postTopup()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.manage];
		seq.length = 0;
		const response = await postTopup();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ topup: { entry_id: '00000000-0000-4000-8000-000000000300', entry_no: 9, period_id: '00000000-0000-4000-8000-000000000001', created: true } });
		// 設定を読んで切り替えの日を確かめてから、書く。
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:get_accounting_settings', 'rpc:admin_record_balance_topup', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_record_balance_topup', {
			_actor_id: ACTOR, _amount: 30000, _bank_date: TODAY, _bank_txn_no: 'BANK-20261109-01', _stripe_txn_id: 'txn_1AbC', _note: '残高の補充', _request_key: KEY,
		});
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.stripe.topup', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success', metadata: { result: 'recorded' },
		});
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of ['30000', 'BANK-20261109-01', 'txn_1AbC', '残高の補充', KEY]) expect(audit).not.toContain(secret);
	});

	test('FREQ-565-AC-06: 同じ要求番号の再送は前の結果を返す（created:falseは「再送」として監査に残す）', async () => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_record_balance_topup' ? { data: { entry_id: '00000000-0000-4000-8000-000000000300', entry_no: 9, period_id: '00000000-0000-4000-8000-000000000001', created: false }, error: null } : defaultRpc(name)));
		const response = await postTopup();
		expect(response.status).toBe(200);
		expect(((await read(response)).data as { topup: { created: boolean } }).topup.created).toBe(false);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'success', metadata: { result: 'replayed' } }));
		// 銀行の番号だけ・Stripe の番号だけでも通る。
		expect((await postTopup({ ...topupBody, stripeTxnId: null, note: null })).status).toBe(200);
		expect((await postTopup({ ...topupBody, bankTxnNo: null })).status).toBe(200);
	});

	test('FREQ-565-AC-06: 未来の日・額0・番号なし・形の悪い番号・長いメモ・知らない鍵はDBを呼ばず400', async () => {
		const bad: [string, unknown][] = [
			['未来の日', { ...topupBody, bankDate: toJstDate(new Date(Date.now() + 2 * 86_400_000)) }], ['額0', { ...topupBody, amount: 0 }], ['額が負', { ...topupBody, amount: -5 }],
			['額が小数', { ...topupBody, amount: 10.5 }], ['額が文字', { ...topupBody, amount: '100' }], ['額が上限超え', { ...topupBody, amount: Number.MAX_SAFE_INTEGER + 1 }],
			['日が暦にない', { ...topupBody, bankDate: '2026-02-30' }], ['番号が両方なし', { ...topupBody, bankTxnNo: null, stripeTxnId: null }],
			['銀行の番号に空白', { ...topupBody, bankTxnNo: 'A B' }], ['銀行の番号に日本語', { ...topupBody, bankTxnNo: '振込1' }], ['銀行の番号が129文字', { ...topupBody, bankTxnNo: 'a'.repeat(129) }],
			['Stripeの番号に記号', { ...topupBody, stripeTxnId: 'txn/1' }], ['メモが401文字', { ...topupBody, note: 'あ'.repeat(401) }],
			['知らない鍵', { ...topupBody, accountCode: '1040' }], ['要求番号が不正', { ...topupBody, requestKey: 'bad' }], ['本文がJSONでない', null],
		];
		for (const [label, value] of bad) {
			const response = await postTopup(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		// 今日・128文字ちょうどの番号は通る。
		expect((await postTopup({ ...topupBody, bankTxnNo: 'a'.repeat(128), bankDate: TODAY })).status).toBe(200);
	});

	test('FREQ-565-AC-06: 切り替えの日より前の日は400と専用の文で、補充の関数を呼ばない', async () => {
		state.settings = settingsRow({ cutover_on: TODAY });
		const response = await postTopup({ ...topupBody, bankDate: dayBefore(1) });
		expect([response.status, await read(response)]).toEqual([400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '切り替えの日より前の日は入れられません。' }]);
		expect(rpcImpl).not.toHaveBeenCalledWith('admin_record_balance_topup', expect.anything());
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: 'ACCOUNTING_ARGUMENT_INVALID' } }));
		// 切り替えの日ちょうどは通る。
		expect((await postTopup({ ...topupBody, bankDate: TODAY })).status).toBe(200);
	});

	test.each([
		['ACCOUNTING_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
		['ACCOUNTING_DEDUPE_CONTENT_MISMATCH', '23505', 409, '同じ出来事で内容の違う仕訳は入れられません。'],
		['ACCOUNTING_PERIOD_MISSING', '55000', 409, 'この日付の会計の期間がありません。先に期間を作ってください。'],
		['ACCOUNTING_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
	])('FREQ-565-AC-06: DBの%sは表の状態と本文で返す', async (message, sqlstate, status, text) => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_record_balance_topup' ? dbError(message, sqlstate, 'PRIVATE-MARKER') : defaultRpc(name)));
		const response = await postTopup();
		expect([response.status, await read(response)]).toEqual([status, { code: message, error: text }]);
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
	});

	test('FREQ-565-AC-06: CSRF・回数制限・aal1は断ってDBを呼ばない', async () => {
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await postTopup()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await postTopup()).status).toBe(429);
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await postTopup()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
	});
});
