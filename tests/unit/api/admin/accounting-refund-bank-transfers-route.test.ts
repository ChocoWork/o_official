/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
const mockSchedule = jest.fn();
jest.mock('@/lib/accounting/posting-runner', () => ({ scheduleAccountingPosting: (...args: unknown[]) => mockSchedule(...args) }));
import { POST as bankPost } from '@/app/api/admin/accounting/refund-bank-transfers/route';
import { toJstDate } from '@/lib/accounting/jst-date';
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

const TODAY = toJstDate(new Date());
const ORDER = uuid(21);
const body = { orderId: ORDER, origin: 'pre_shipment', amount: 4321, bankDate: TODAY, bankTxnNo: 'BANK-20261114-77', note: '振込で返金 SECRET-NOTE', requestKey: KEY };
const created = { entry_id: uuid(22), entry_no: 5, period_id: uuid(23), created: true };
const post = (value: unknown = body) => bankPost(new Request('https://example.test/api/admin/accounting/refund-bank-transfers', { method: 'POST', body: JSON.stringify(value) }));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.manage]);
	rpcImpl.mockImplementation(async (name: string) => {
		if (name === 'admin_record_refund_bank_transfer') return { data: created, error: null };
		throw new Error(`unexpected rpc ${name}`);
	});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/admin/accounting/refund-bank-transfers', () => {
	test('FREQ-579-AC-04: 振込の記録は admin.finance.manage の人だけで、順に通ってから DB へ渡り、応答の後に計上係を流す', async () => {
		grants.current = [PERM.read, PERM.correct, PERM.settings];
		expect((await post()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		expect(mockSchedule).not.toHaveBeenCalled();
		grants.current = [PERM.manage];
		seq.length = 0;
		const response = await post();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ transfer: created });
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_record_refund_bank_transfer', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_record_refund_bank_transfer', {
			_actor_id: ACTOR, _order_id: ORDER, _origin: 'pre_shipment', _amount: 4321, _bank_date: TODAY, _bank_txn_no: 'BANK-20261114-77', _note: '振込で返金 SECRET-NOTE', _request_key: KEY,
		});
		expect(mockSchedule).toHaveBeenCalledTimes(1);
		expect(mockSchedule).toHaveBeenCalledWith('refund_bank');
	});

	test('FREQ-579-AC-04: 振込の記録の監査に金額・銀行の取引の番号・メモ・注文の番号を入れない', async () => {
		await post();
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.refund.bank', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success', metadata: { result: 'recorded' },
		});
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of ['4321', 'BANK-20261114-77', 'SECRET-NOTE', ORDER, KEY, TODAY]) expect(audit).not.toContain(secret);
	});

	test('FREQ-579-AC-04: 未来の日・額0・長すぎるメモ・取引の番号の形の誤り・知らない鍵はDBを呼ばず400', async () => {
		const bad: [string, unknown][] = [
			['未来の日', { ...body, bankDate: toJstDate(new Date(Date.now() + 2 * 86_400_000)) }], ['額0', { ...body, amount: 0 }], ['額が負', { ...body, amount: -5 }],
			['額が小数', { ...body, amount: 10.5 }], ['額が文字', { ...body, amount: '100' }], ['額が上限超え', { ...body, amount: Number.MAX_SAFE_INTEGER + 1 }],
			['メモが501文字', { ...body, note: 'あ'.repeat(501) }], ['取引の番号に空白', { ...body, bankTxnNo: 'A B' }], ['取引の番号が101文字', { ...body, bankTxnNo: 'a'.repeat(101) }],
			['取引の番号なし', { ...body, bankTxnNo: undefined }], ['元が不正', { ...body, origin: 'dispute' }], ['注文の番号が不正', { ...body, orderId: 'x' }],
			['日が暦にない', { ...body, bankDate: '2026-02-30' }], ['要求番号なし', { ...body, requestKey: undefined }], ['知らない鍵', { ...body, accountCode: '1040' }], ['JSON でない', null],
		];
		for (const [label, value] of bad) {
			const response = await post(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		expect(mockSchedule).not.toHaveBeenCalled();
		// 境界（500字のメモ・100字の番号・メモなし・出荷後・返品の元）は通る。
		expect((await post({ ...body, note: 'あ'.repeat(500), bankTxnNo: 'a'.repeat(100) })).status).toBe(200);
		expect((await post({ ...body, note: null, origin: 'post_shipment' })).status).toBe(200);
		expect((await post({ ...body, note: '  ', origin: 'return' })).status).toBe(200);
		expect(rpcImpl).toHaveBeenLastCalledWith('admin_record_refund_bank_transfer', expect.objectContaining({ _note: null, _origin: 'return' }));
	});

	test('FREQ-579-AC-04: 同じ要求番号の再送は前の結果（created:false）で、監査は replayed', async () => {
		rpcImpl.mockImplementation(async () => ({ data: { ...created, created: false }, error: null }));
		const response = await post();
		expect(response.status).toBe(200);
		expect(((await read(response)).data as { transfer: { created: boolean } }).transfer.created).toBe(false);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'success', metadata: { result: 'replayed' } }));
	});

	test.each([
		['ACCOUNTING_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
		['ACCOUNTING_EVENT_NOT_POSTABLE', '55000', 409, 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。'],
		['ACCOUNTING_DEDUPE_CONTENT_MISMATCH', '23505', 409, '同じ出来事で内容の違う仕訳は入れられません。'],
		['ACCOUNTING_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
		['ACCOUNTING_PERIOD_MISSING', '55000', 409, 'この日付の会計の期間がありません。先に期間を作ってください。'],
	])('FREQ-579-AC-04: DBの%sは表の状態と本文で返し、計上係は流さない', async (message, sqlstate, status, text) => {
		rpcImpl.mockImplementation(async () => dbError(message, sqlstate, 'PRIVATE-MARKER'));
		const response = await post();
		expect([response.status, await read(response)]).toEqual([status, { code: message, error: text }]);
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: message } }));
		expect(mockSchedule).not.toHaveBeenCalled();
	});

	test('FREQ-579-AC-04: CSRF・回数制限・aal1は断ってDBを呼ばない', async () => {
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await post()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await post()).status).toBe(429);
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await post()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		expect(mockAudit).not.toHaveBeenCalled();
		expect(mockSchedule).not.toHaveBeenCalled();
	});
});
