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
import { POST as settlementPost } from '@/app/api/admin/accounting/refund-settlements/route';
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

const OWED = uuid(31);
const PAYING = uuid(32);
const body = { owedRefundId: OWED, payingRefundId: PAYING, requestKey: KEY };
const settled = { settlement_id: uuid(33), owed_refund_id: OWED, paying_refund_id: PAYING, pre_amount: 6543, post_amount: 0, entry_id: uuid(34), entry_no: 12, replayed: false };
const post = (value: unknown = body) => settlementPost(new Request('https://example.test/api/admin/accounting/refund-settlements', { method: 'POST', body: JSON.stringify(value) }));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.correct]);
	rpcImpl.mockImplementation(async (name: string) => {
		if (name === 'admin_settle_owed_by_refund') return { data: settled, error: null };
		throw new Error(`unexpected rpc ${name}`);
	});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/admin/accounting/refund-settlements', () => {
	test('FREQ-579-AC-05: 結びのrouteは admin.accounting.entries.correct の人だけで、順に通ってから DB へ渡り、応答の後に計上係を流す', async () => {
		grants.current = [PERM.read, PERM.manage, PERM.settings];
		expect((await post()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.correct];
		seq.length = 0;
		const response = await post();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({
			settlement: { settlementId: uuid(33), owedRefundId: OWED, payingRefundId: PAYING, preAmount: 6543, postAmount: 0, entryId: uuid(34), entryNo: 12, replayed: false },
		});
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_settle_owed_by_refund', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_settle_owed_by_refund', { _actor_id: ACTOR, _owed_refund_id: OWED, _paying_refund_id: PAYING, _request_key: KEY });
		expect(mockSchedule).toHaveBeenCalledWith('refund_settle');
	});

	test('FREQ-579-AC-05: 監査は返金の番号と結果だけで、金額を入れない', async () => {
		await post();
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.refund.settle', actor_id: ACTOR, resource: 'accounting', resource_id: OWED, outcome: 'success', metadata: { refund_id: OWED, result: 'settled' },
		});
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of ['6543', KEY, PAYING]) expect(audit).not.toContain(secret);
		rpcImpl.mockImplementation(async () => ({ data: { ...settled, replayed: true }, error: null }));
		expect((await post()).status).toBe(200);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { refund_id: OWED, result: 'replayed' } }));
	});

	test('FREQ-579-AC-05: 不正な入力は400で、同じ返金どうし・番号の誤り・知らない鍵・aal1・CSRF 欠落・429はDBを呼ばない', async () => {
		for (const [label, value] of [
			['同じ返金', { ...body, payingRefundId: OWED }], ['借りの番号が不正', { ...body, owedRefundId: 'x' }], ['やり直しの番号なし', { ...body, payingRefundId: undefined }],
			['要求番号なし', { ...body, requestKey: undefined }], ['金額を渡す', { ...body, amount: 100 }], ['JSON でない', null],
		] as [string, unknown][]) {
			const response = await post(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await post()).status).toBe(403);
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await post()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await post()).status).toBe(429);
		expect(rpcImpl).not.toHaveBeenCalled();
		expect(mockSchedule).not.toHaveBeenCalled();
	});

	test.each([
		['借りの仕訳がまだ・残高を超える', 'ACCOUNTING_EVENT_NOT_POSTABLE', '55000', 409, 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。'],
		['違う元の返金・取り消しの出来事の返金', 'ACCOUNTING_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
		['要求番号で別の操作', 'ACCOUNTING_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
	])('FREQ-579-AC-05: 断られた理由（%s）は %s の表の状態と本文で返し、計上係を流さない', async (_label, message, sqlstate, status, text) => {
		rpcImpl.mockImplementation(async () => dbError(message, sqlstate, 'PRIVATE-MARKER'));
		const response = await post();
		expect([response.status, await read(response)]).toEqual([status, { code: message, error: text }]);
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: message } }));
		expect(mockSchedule).not.toHaveBeenCalled();
	});
});
