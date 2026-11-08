/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as disputesGet } from '@/app/api/admin/accounting/disputes/route';
import { POST as assignPost } from '@/app/api/admin/accounting/disputes/[id]/assign/route';
import { GET as settingsGet, PUT as settingsPut } from '@/app/api/admin/accounting/dispute-settings/route';
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

const DISPUTE = 'dp_1AbCdEf';
const settingRow = { reason: 'fraudulent', account_code: '6290', version: '1', updated_at: '2026-11-09T00:00:00+00:00' };
const disputeRow = {
	dispute_id: DISPUTE, reason: 'fraudulent', status: 'lost', amount: 12000, order_id: uuid(600), stripe_created_at: '2026-11-01T00:00:00+00:00',
	withdrawn_on: '2026-11-01', confirmed_on: '2026-11-05', assigned_account_code: '1470', pending_reasons: [],
};
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'list_dispute_account_settings': return { data: { settings: [settingRow] }, error: null };
		case 'admin_set_dispute_account_setting': return { data: { ...settingRow, version: '2' }, error: null };
		case 'list_accounting_disputes': return { data: { disputes: [disputeRow], next_after_at: '2026-11-01T00:00:00+00:00', next_after_id: DISPUTE }, error: null };
		case 'admin_assign_dispute_confirmed': return { data: { entry_id: uuid(300), entry_no: 5, period_id: uuid(1), created: true }, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};

const base = 'https://example.test/api/admin/accounting';
const settingBody = { reason: 'fraudulent', accountCode: '6290', expectedVersion: null, requestKey: KEY };
const putSetting = (value: unknown = settingBody) => settingsPut(new Request(`${base}/dispute-settings`, { method: 'PUT', body: JSON.stringify(value) }));
const getDisputes = (query = '') => disputesGet(new Request(`${base}/disputes${query}`));
const assign = (value: unknown = { requestKey: KEY }, id: string = DISPUTE) =>
	assignPost(new Request(`${base}/disputes/${id}/assign`, { method: 'POST', body: JSON.stringify(value) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read, PERM.manage, PERM.correct, PERM.settings]);
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('/api/admin/accounting/dispute-settings', () => {
	test('FREQ-568-AC-05: 設定のGETはadmin.finance.readで読み、no-storeで返す', async () => {
		grants.current = [PERM.read];
		const response = await settingsGet(new Request(`${base}/dispute-settings`));
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ settings: [settingRow] });
		expect(seq).toEqual(['auth', 'rpc:list_dispute_account_settings']);
		grants.current = [PERM.settings];
		expect((await settingsGet(new Request(`${base}/dispute-settings`))).status).toBe(403);
	});

	test('FREQ-568-AC-05: 科目の設定のPUTは権限のある人だけで、監査に金額を入れず原因と勘定の符号だけ残す', async () => {
		grants.current = [PERM.manage, PERM.correct, PERM.read];
		const denied = await putSetting();
		expect(denied.status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.settings];
		seq.length = 0;
		const response = await putSetting();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ setting: { ...settingRow, version: '2' } });
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_set_dispute_account_setting', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_set_dispute_account_setting', {
			_actor_id: ACTOR, _reason: 'fraudulent', _account_code: '6290', _expected_version: null, _request_key: KEY,
		});
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.dispute.setting', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success',
			metadata: { reason: 'fraudulent', account_code: '6290' },
		});
		// 変える時は読んだ版を渡す。
		await putSetting({ ...settingBody, expectedVersion: '2' });
		expect(rpcImpl).toHaveBeenLastCalledWith('admin_set_dispute_account_setting', expect.objectContaining({ _expected_version: '2' }));
	});

	test('FREQ-568-AC-05: 不正な勘定・原因・版・知らない鍵は400でDBを呼ばず、画面の文に「チャージバック」を書かない', async () => {
		const bad: [string, unknown][] = [
			['勘定が文字', { ...settingBody, accountCode: 'abc' }], ['勘定が5桁', { ...settingBody, accountCode: '62900' }], ['勘定の前後の空白', { ...settingBody, accountCode: ' 6290' }],
			['勘定なし', { reason: 'fraudulent', expectedVersion: null, requestKey: KEY }], ['原因が知らない値', { ...settingBody, reason: 'chargeback' }],
			['版が0', { ...settingBody, expectedVersion: '0' }], ['版が数値', { ...settingBody, expectedVersion: 2 }], ['要求番号が不正', { ...settingBody, requestKey: 'bad' }],
			['知らない鍵', { ...settingBody, amount: 100 }], ['本文がJSONでない', null],
		];
		for (const [label, value] of bad) {
			const response = await putSetting(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		// DB が使えない勘定と断った時（資産・負債など）は400と固定の文。
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_dispute_account_setting' ? dbError('ACCOUNTING_DISPUTE_ACCOUNT_INVALID', '22023', 'PRIVATE-MARKER') : defaultRpc(name)));
		const invalid = await putSetting({ ...settingBody, accountCode: '1160' });
		const body = await read(invalid);
		expect([invalid.status, body]).toEqual([400, { code: 'ACCOUNTING_DISPUTE_ACCOUNT_INVALID', error: '選んだ勘定は、支払いの取り消しの振り替え先に使えません。' }]);
		expect(JSON.stringify(body)).not.toContain('チャージバック');
		expect(mockAudit).toHaveBeenLastCalledWith({
			action: 'admin.accounting.dispute.setting', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'failure',
			metadata: { result_code: 'ACCOUNTING_DISPUTE_ACCOUNT_INVALID' },
		});
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
	});

	test('FREQ-568-AC-05: 版違いは409、CSRF・429・aal1は断ってDBを呼ばない', async () => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_dispute_account_setting' ? dbError('ACCOUNTING_VERSION_CONFLICT', '40001') : defaultRpc(name)));
		const conflict = await putSetting({ ...settingBody, expectedVersion: '1' });
		expect([conflict.status, await read(conflict)]).toEqual([409, { code: 'ACCOUNTING_VERSION_CONFLICT', error: '設定が変わりました。読み直してください。' }]);
		rpcImpl.mockClear();
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await putSetting()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await putSetting()).status).toBe(429);
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await putSetting()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
	});
});

describe('/api/admin/accounting/disputes', () => {
	test('FREQ-568-AC-05: 一覧のGETはadmin.finance.readで読み、続きの目印と件数を検査する', async () => {
		grants.current = [PERM.read];
		const response = await getDisputes(`?limit=20&afterAt=2026-11-02T00:00:00%2B00:00&afterId=${DISPUTE}`);
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ disputes: [disputeRow], next_after_at: '2026-11-01T00:00:00+00:00', next_after_id: DISPUTE });
		expect(rpcImpl).toHaveBeenCalledWith('list_accounting_disputes', { _limit: 20, _after_at: '2026-11-02T00:00:00+00:00', _after_id: DISPUTE });
		await getDisputes();
		expect(rpcImpl).toHaveBeenLastCalledWith('list_accounting_disputes', { _limit: 50, _after_at: null, _after_id: null });
		rpcImpl.mockClear();
		for (const query of ['?limit=0', '?limit=101', `?afterAt=2026-11-02T00:00:00%2B00:00`, `?afterId=${DISPUTE}`, '?afterAt=2026-11-02T00:00:00%2B00:00&afterId=xyz', '?x=1']) {
			expect([query, (await getDisputes(query)).status]).toEqual([query, 400]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.settings, PERM.correct];
		expect((await getDisputes()).status).toBe(403);
	});

	test('FREQ-568-AC-05: 一覧に画面に出さない欄（資料・メール）が無い', async () => {
		const text = JSON.stringify(await read(await getDisputes()));
		expect(text).not.toMatch(/raw_payload|evidence|email|name"/i);
	});
});

describe('POST /api/admin/accounting/disputes/[id]/assign', () => {
	test('FREQ-568-AC-05: 振り替えはadmin.accounting.entries.correctの人だけで、監査は取り消しの番号と結果だけ', async () => {
		grants.current = [PERM.read, PERM.manage, PERM.settings];
		expect((await assign()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.correct];
		seq.length = 0;
		const response = await assign();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ assignment: { entry_id: uuid(300), entry_no: 5, period_id: uuid(1), created: true } });
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_assign_dispute_confirmed', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_assign_dispute_confirmed', { _actor_id: ACTOR, _dispute_id: DISPUTE, _request_key: KEY });
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.dispute.assign', actor_id: ACTOR, resource: 'accounting', resource_id: DISPUTE, outcome: 'success',
			metadata: { dispute_id: DISPUTE, result: 'assigned' },
		});
		// 既に振り替え済み（再送・別の要求）は何も足さず、その結果を返す。
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_assign_dispute_confirmed' ? { data: { entry_id: uuid(300), entry_no: 5, period_id: uuid(1), created: false }, error: null } : defaultRpc(name)));
		await assign();
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { dispute_id: DISPUTE, result: 'already_assigned' } }));
	});

	test('FREQ-568-AC-05: 不正なIDや本文は400でDBを呼ばず、振り替えられない状態は409', async () => {
		for (const id of ['xyz', 'dp_', 'dp_a-b', 'DP_abc', '../x', uuid(1), 'dp_' + 'a'.repeat(253)]) {
			const response = await assign({ requestKey: KEY }, id);
			expect([id, response.status]).toEqual([id, 400]);
		}
		// 255文字ちょうどは通る
		expect((await assign({ requestKey: KEY }, 'dp_' + 'a'.repeat(252))).status).toBe(200);
		rpcImpl.mockClear();
		for (const value of [{}, { requestKey: 'bad' }, { requestKey: KEY, entryId: uuid(1) }, null]) {
			expect([JSON.stringify(value), (await assign(value)).status]).toEqual([JSON.stringify(value), 400]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_assign_dispute_confirmed' ? dbError('ACCOUNTING_EVENT_NOT_POSTABLE', '55000') : defaultRpc(name)));
		const notPostable = await assign();
		expect([notPostable.status, await read(notPostable)]).toEqual([409, { code: 'ACCOUNTING_EVENT_NOT_POSTABLE', error: 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。' }]);
		expect(mockAudit).toHaveBeenLastCalledWith({
			action: 'admin.accounting.dispute.assign', actor_id: ACTOR, resource: 'accounting', resource_id: DISPUTE, outcome: 'failure',
			metadata: { dispute_id: DISPUTE, result_code: 'ACCOUNTING_EVENT_NOT_POSTABLE' },
		});
	});
});
