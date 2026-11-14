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
import { POST as cancellationPost } from '@/app/api/admin/accounting/refund-cancellations/route';
import { GET as statesGet } from '@/app/api/admin/accounting/refund-states/route';
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

const REFUND = uuid(11);
const REASON = '店で返金をやめた SECRET-REASON';
const statesRow = {
	refunds: [{ refund_id: REFUND, order_id: uuid(12), order_number: 'ORD-0000000C', source: 'admin', state: 'canceled', pre_amount: 3000, post_amount: 0, owed_pre: 0, owed_post: 0, canceled_at: '2026-11-10T00:00:00+00:00' }],
	next_after_at: null,
	next_after_id: null,
};
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'list_refund_accounting_states': return { data: statesRow, error: null };
		case 'admin_decide_refund_cancellation': return { data: { refund_id: REFUND, state: 'abandoned', event_id: uuid(13), replayed: false }, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};

const base = 'https://example.test/api/admin/accounting';
const body = { refundId: REFUND, kind: 'abandoned', reason: REASON, requestKey: KEY };
const post = (value: unknown = body) => cancellationPost(new Request(`${base}/refund-cancellations`, { method: 'POST', body: JSON.stringify(value) }));
const getStates = (query = '') => statesGet(new Request(`${base}/refund-states${query}`));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read, PERM.correct]);
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/accounting/refund-states', () => {
	test('FREQ-579-AC-03: 取り消しの区分待ち・借りが残る返金の一覧を finance.read で返し、名前・メールを含めず、全応答 no-store', async () => {
		grants.current = [PERM.read];
		const response = await getStates();
		expect(response.status).toBe(200);
		const json = await read(response);
		expect(json.data).toEqual({
			refunds: [{ refundId: REFUND, orderId: uuid(12), orderNumber: 'ORD-0000000C', source: 'admin', state: 'canceled', preAmount: 3000, postAmount: 0, owedPre: 0, owedPost: 0, canceledAt: '2026-11-10T00:00:00+00:00' }],
			nextAfterAt: null,
			nextAfterId: null,
		});
		expect(JSON.stringify(json)).not.toMatch(/mail|name"|address/i);
		expect(seq).toEqual(['auth', 'rpc:list_refund_accounting_states']);
		expect(rpcImpl).toHaveBeenCalledWith('list_refund_accounting_states', { _limit: 50, _after_at: null, _after_id: null });
		grants.current = [PERM.correct];
		const denied = await getStates();
		expect(denied.status).toBe(403);
		expect(denied.headers.get('cache-control')).toContain('no-store');
		grants.current = [PERM.read];
		for (const query of ['?limit=0', '?limit=101', '?afterAt=2026-11-10T00:00:00Z', `?afterId=${uuid(1)}`, '?x=1']) {
			const bad = await getStates(query);
			expect([query, bad.status]).toEqual([query, 400]);
			expect(bad.headers.get('cache-control')).toContain('no-store');
		}
	});
});

describe('POST /api/admin/accounting/refund-cancellations', () => {
	test('FREQ-579-AC-03: 取り消しの区分のrouteは権限のある人だけで、認可・CSRF・IP・actor の順に通り、監査は返金の番号と区分だけ（理由の本文を入れない）', async () => {
		grants.current = [PERM.read, PERM.manage, PERM.settings];
		expect((await post()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.correct];
		seq.length = 0;
		const response = await post();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ decision: { refundId: REFUND, state: 'abandoned', eventId: uuid(13), replayed: false } });
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_decide_refund_cancellation', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_decide_refund_cancellation', { _actor_id: ACTOR, _refund_id: REFUND, _kind: 'abandoned', _reason: REASON, _request_key: KEY });
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.refund.cancel_decision', actor_id: ACTOR, resource: 'accounting', resource_id: REFUND, outcome: 'success',
			metadata: { refund_id: REFUND, result: 'abandoned' },
		});
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of ['SECRET-REASON', KEY]) expect(audit).not.toContain(secret);
	});

	test('FREQ-579-AC-03: 区分と理由が不正なら400で、DBを呼ばない。aal1・CSRF 欠落・429も呼ばない', async () => {
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await post()).status).toBe(403);
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await post()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await post()).status).toBe(429);
		const bad: [string, unknown][] = [
			['区分が不正', { ...body, kind: 'settled' }], ['区分なし', { ...body, kind: undefined }], ['理由が空白', { ...body, reason: '  ' }], ['理由が501文字', { ...body, reason: 'あ'.repeat(501) }],
			['返金の番号が不正', { ...body, refundId: 'x' }], ['要求番号なし', { ...body, requestKey: undefined }], ['知らない鍵', { ...body, amount: 100 }], ['JSON でない', null],
		];
		for (const [label, value] of bad) {
			const response = await post(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		expect(mockSchedule).not.toHaveBeenCalled();
		expect((await post({ ...body, kind: 'owed', reason: 'あ'.repeat(500) })).status).toBe(200);
	});

	test('FREQ-579-AC-03: 2回目は409とコードで、取り消されていない返金も409。再送は前の結果', async () => {
		rpcImpl.mockImplementation(async () => dbError('ACCOUNTING_REFUND_CANCEL_DECIDED', '55000', 'PRIVATE-MARKER'));
		const decided = await post();
		expect([decided.status, await read(decided)]).toEqual([409, { code: 'ACCOUNTING_REFUND_CANCEL_DECIDED', error: 'この返金の取り消しの区分は、もう決まっています。' }]);
		rpcImpl.mockImplementation(async () => dbError('ACCOUNTING_REFUND_NOT_CANCELED', '55000'));
		const notCanceled = await post();
		expect([notCanceled.status, await read(notCanceled)]).toEqual([409, { code: 'ACCOUNTING_REFUND_NOT_CANCELED', error: 'この返金は取り消された状態ではありません。' }]);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: 'ACCOUNTING_REFUND_NOT_CANCELED' } }));
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
		expect(mockSchedule).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async () => ({ data: { refund_id: REFUND, state: 'abandoned', event_id: uuid(13), replayed: true }, error: null }));
		const replay = await post();
		expect(replay.status).toBe(200);
		expect(((await read(replay)).data as { decision: { replayed: boolean } }).decision.replayed).toBe(true);
	});

	test('FREQ-579-AC-03: UNIT_CANCEL_REVERT_REFUSED は409とコードで、理由ごとの文を出し、DETAIL を出さない', async () => {
		const revert = 'この取り消しは元に戻せません。「返すつもり」を選んで振込で返してください。';
		for (const [detail, text] of [['ubrr_later', revert], ['ubrr_holds', revert], ['ubrr_status', 'Stripe への返金をやり直してください。']] as const) {
			rpcImpl.mockImplementation(async () => dbError('UNIT_CANCEL_REVERT_REFUSED', '22023', detail));
			const response = await post();
			expect([detail, response.status, await read(response)]).toEqual([detail, 409, { code: 'UNIT_CANCEL_REVERT_REFUSED', error: text }]);
			expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(detail);
		}
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: 'UNIT_CANCEL_REVERT_REFUSED' } }));
		expect(mockSchedule).not.toHaveBeenCalled();
	});

	test('FREQ-579-AC-06: 区分を選んだ応答の後に計上係を流す（係の失敗が応答を変えないことは、返金・受け取りの route の試験で確かめる）', async () => {
		const response = await post();
		expect(response.status).toBe(200);
		expect(mockSchedule).toHaveBeenCalledTimes(1);
		expect(mockSchedule).toHaveBeenCalledWith('refund_cancel');
	});
});
