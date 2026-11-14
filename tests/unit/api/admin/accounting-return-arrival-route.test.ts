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
import { GET as arrivalGet, POST as arrivalPost } from '@/app/api/admin/accounting/return-arrival/route';
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

const ORDERS_READ = 'admin.orders.read';
const RECEIPT = uuid(7);
const infoRow = {
	receipt_id: RECEIPT, arrived_on_original: '2026-11-01', arrived_on_current: '2026-11-03', version: 1,
	corrections: [{ version: 1, previous_on: '2026-11-01', new_on: '2026-11-03', reason: '到着日の確認 SECRET-REASON', actor_id: uuid(5), created_at: '2026-11-04T01:00:00+00:00' }],
};
const correctedRow = { receipt_id: RECEIPT, version: 2, previous_on: '2026-11-03', new_on: '2026-11-02', correction_id: uuid(8), replayed: false };
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'get_return_arrival_info': return { data: [infoRow], error: null };
		case 'admin_correct_return_arrival_date': return { data: correctedRow, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};

const base = 'https://example.test/api/admin/accounting/return-arrival';
const get = (query = `?receiptIds=${RECEIPT}`) => arrivalGet(new Request(`${base}${query}`));
const body = { receiptId: RECEIPT, newOn: '2026-11-02', reason: '到着日の確認 SECRET-REASON', expectedVersion: 1, requestKey: KEY };
const post = (value: unknown = body) => arrivalPost(new Request(base, { method: 'POST', body: JSON.stringify(value) }));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([ORDERS_READ, PERM.correct]);
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/accounting/return-arrival', () => {
	test('FREQ-575-AC-02: 届いた日と直しの跡を admin.orders.read で返し、直した人の番号を出さず、全応答 no-store', async () => {
		grants.current = [ORDERS_READ];
		const response = await get();
		expect(response.status).toBe(200);
		const json = await read(response);
		expect(json.data).toEqual({
			arrivals: [{
				receiptId: RECEIPT, arrivedOnOriginal: '2026-11-01', arrivedOnCurrent: '2026-11-03', version: 1,
				corrections: [{ version: 1, previousOn: '2026-11-01', newOn: '2026-11-03', reason: '到着日の確認 SECRET-REASON', createdAt: '2026-11-04T01:00:00+00:00' }],
			}],
		});
		expect(JSON.stringify(json)).not.toContain(uuid(5));
		expect(seq).toEqual(['auth', 'rpc:get_return_arrival_info']);
		expect(rpcImpl).toHaveBeenCalledWith('get_return_arrival_info', { _receipt_ids: [RECEIPT] });
	});

	test('FREQ-575-AC-02: orders.read が無ければ403（finance.read だけでは読めない）。不正な問い合わせは400で、どちらも no-store', async () => {
		grants.current = [PERM.read];
		const denied = await get();
		expect(denied.status).toBe(403);
		expect(denied.headers.get('cache-control')).toContain('no-store');
		grants.current = [ORDERS_READ];
		const tooMany = `?receiptIds=${Array.from({ length: 201 }, (_, i) => uuid(i + 1)).join(',')}`;
		for (const query of ['', '?receiptIds=', '?receiptIds=x', `?receiptIds=${RECEIPT},${RECEIPT}`, `?receiptIds=${RECEIPT}&y=1`, tooMany]) {
			const response = await get(query);
			expect([query.slice(0, 40), response.status]).toEqual([query.slice(0, 40), 400]);
			expect(response.headers.get('cache-control')).toContain('no-store');
		}
		expect(rpcImpl).not.toHaveBeenCalled();
	});
});

describe('POST /api/admin/accounting/return-arrival', () => {
	test('直しは権限・CSRF・IP・actor の順に通ってから DB へ渡り、監査は受け取りの番号と結果だけ（理由の本文・日を入れない）', async () => {
		const response = await post();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ arrival: { receiptId: RECEIPT, version: 2, previousOn: '2026-11-03', newOn: '2026-11-02', correctionId: uuid(8), replayed: false } });
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_correct_return_arrival_date', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_correct_return_arrival_date', {
			_actor_id: ACTOR, _receipt_id: RECEIPT, _new_on: '2026-11-02', _reason: '到着日の確認 SECRET-REASON', _expected_version: 1, _request_key: KEY,
		});
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.return.arrival', actor_id: ACTOR, resource: 'accounting', resource_id: RECEIPT, outcome: 'success',
			metadata: { receipt_id: RECEIPT, result: 'corrected' },
		});
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of ['SECRET-REASON', '2026-11-02', '2026-11-03', KEY]) expect(audit).not.toContain(secret);
	});

	test('FREQ-575-AC-02: 届いた日の直しのrouteは aal1・権限なし・CSRF欠落・429・不正入力で store を呼ばず、理由の本文と日を監査に入れない', async () => {
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await post()).status).toBe(403);
		grants.current = [ORDERS_READ, PERM.manage, PERM.settings, PERM.read];
		expect((await post()).status).toBe(403);
		grants.current = [ORDERS_READ, PERM.correct];
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await post()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await post()).status).toBe(429);
		const bad: [string, unknown][] = [
			['理由が空白', { ...body, reason: '   ' }], ['理由が501文字', { ...body, reason: 'あ'.repeat(501) }], ['版が負', { ...body, expectedVersion: -1 }],
			['日が暦にない', { ...body, newOn: '2026-02-30' }], ['受け取りの番号が不正', { ...body, receiptId: 'x' }], ['要求番号なし', { ...body, requestKey: undefined }],
			['知らない鍵', { ...body, actorId: uuid(1) }], ['JSON でない', null],
		];
		for (const [label, value] of bad) {
			const response = await post(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		expect(mockSchedule).not.toHaveBeenCalled();
		// 理由の長さの境界（500字・版0）は通る。
		expect((await post({ ...body, reason: 'あ'.repeat(500), expectedVersion: 0 })).status).toBe(200);
		// 断った時の監査（不正入力の失敗）にも、成功の監査にも、理由の本文と日は入らない
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of ['SECRET-REASON', 'あああ', '2026-11-02', '2026-02-30']) expect(audit).not.toContain(secret);
	});

	test('FREQ-575-AC-01: 届いた日が不正（未来・申し込みの前・確定済み）なら400と固定の文で、DETAIL を出さず、監査は失敗だけ', async () => {
		rpcImpl.mockImplementation(async () => dbError('RETURN_ARRIVAL_DATE_INVALID', '22023', 'dispute_confirmed'));
		const response = await post();
		expect([response.status, await read(response)]).toEqual([400, { code: 'RETURN_ARRIVAL_DATE_INVALID', error: '届いた日を確かめてください。' }]);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: 'RETURN_ARRIVAL_DATE_INVALID' } }));
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('dispute_confirmed');
	});

	test.each([
		['ACCOUNTING_VERSION_CONFLICT', '40001', 409, '設定が変わりました。読み直してください。'],
		['ACCOUNTING_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
		['ACCOUNTING_NOT_FOUND', 'P0002', 404, '会計の記録が見つかりません。'],
		['ACCOUNTING_FORBIDDEN', '42501', 403, '会計を操作する権限がありません。'],
	])('FREQ-575-AC-05: DBの%sは表の状態と本文で返す', async (message, sqlstate, status, text) => {
		rpcImpl.mockImplementation(async () => dbError(message, sqlstate, 'PRIVATE-MARKER'));
		const response = await post();
		expect([response.status, await read(response)]).toEqual([status, { code: message, error: text }]);
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
	});

	test('FREQ-575-AC-05: 同じ要求番号の再送は前の結果で、監査は replayed。直しの後に計上係は流さない（受け取りの係が拾う）', async () => {
		rpcImpl.mockImplementation(async () => ({ data: { ...correctedRow, replayed: true }, error: null }));
		const response = await post();
		expect(response.status).toBe(200);
		expect(((await read(response)).data as { arrival: { replayed: boolean } }).arrival.replayed).toBe(true);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { receipt_id: RECEIPT, result: 'replayed' } }));
		expect(mockSchedule).not.toHaveBeenCalled();
	});
});
