/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as optionsGet, PUT as optionsPut } from '@/app/api/admin/accounting/return-options/route';
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

const optionRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	use_carrier_delivery_date: false, changed_at: null, changed_by: null, version: '1', ...overrides,
});
const state = { read: optionRow(), write: optionRow({ use_carrier_delivery_date: true, changed_at: '2026-11-14T00:00:00+00:00', changed_by: uuid(90), version: '2', replayed: false }) };
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'get_return_arrival_option': return { data: state.read, error: null };
		case 'admin_set_return_arrival_option': return { data: state.write, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};

const url = 'https://example.test/api/admin/accounting/return-options';
const body = { enabled: true, expectedVersion: '1', requestKey: KEY };
const put = (value: unknown = body) => optionsPut(new Request(url, { method: 'PUT', body: JSON.stringify(value) }));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read, PERM.settings]);
	state.read = optionRow();
	state.write = optionRow({ use_carrier_delivery_date: true, changed_at: '2026-11-14T00:00:00+00:00', changed_by: uuid(90), version: '2', replayed: false });
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('/api/admin/accounting/return-options', () => {
	test('FREQ-575-AC-04: 設定のGETは既定オフで、変えた人の番号を出さず、追跡の注意の鍵を返し、全応答 no-store', async () => {
		grants.current = [PERM.read];
		const response = await optionsGet(new Request(url));
		expect(response.status).toBe(200);
		const json = await read(response);
		expect(json.data).toEqual({ option: { useCarrierDeliveryDate: false, changedAt: null, version: '1', noticeKey: 'return_tracking_unregistered' } });
		expect(seq).toEqual(['auth', 'rpc:get_return_arrival_option']);
		state.read = optionRow({ use_carrier_delivery_date: true, changed_at: '2026-11-14T00:00:00+00:00', changed_by: uuid(90), version: '2' });
		expect(JSON.stringify(await read(await optionsGet(new Request(url))))).not.toContain(uuid(90));
		grants.current = [PERM.settings];
		const denied = await optionsGet(new Request(url));
		expect(denied.status).toBe(403);
		expect(denied.headers.get('cache-control')).toContain('no-store');
	});

	test('FREQ-575-AC-04: 設定のPUTは権限のある人だけで、権限・CSRF・IP・actor の順に通り、監査は結果だけ', async () => {
		grants.current = [PERM.read, PERM.manage, PERM.correct];
		expect((await put()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		grants.current = [PERM.settings];
		seq.length = 0;
		const response = await put();
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({
			option: { useCarrierDeliveryDate: true, changedAt: '2026-11-14T00:00:00+00:00', version: '2', noticeKey: 'return_tracking_unregistered' },
		});
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_set_return_arrival_option', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_set_return_arrival_option', { _actor_id: ACTOR, _enabled: true, _expected_version: '1', _request_key: KEY });
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.return.option', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success', metadata: { result: 'enabled' },
		});
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(KEY);
	});

	test('FREQ-575-AC-04: 設定のPUTの版違いは409、再送は前の結果で監査は replayed', async () => {
		rpcImpl.mockImplementation(async () => dbError('ACCOUNTING_VERSION_CONFLICT', '40001'));
		const conflict = await put();
		expect([conflict.status, await read(conflict)]).toEqual([409, { code: 'ACCOUNTING_VERSION_CONFLICT', error: '設定が変わりました。読み直してください。' }]);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { result_code: 'ACCOUNTING_VERSION_CONFLICT' } }));
		rpcImpl.mockImplementation(async () => ({ data: { ...state.write, replayed: true }, error: null }));
		expect((await put()).status).toBe(200);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'success', metadata: { result: 'replayed' } }));
	});

	test('FREQ-575-AC-04: aal1・CSRF 欠落・429・不正入力はDBを呼ばない', async () => {
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await put()).status).toBe(403);
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await put()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await put()).status).toBe(429);
		for (const [label, value] of [
			['真偽でない', { ...body, enabled: 'true' }], ['版が数値', { ...body, expectedVersion: 1 }], ['版が0', { ...body, expectedVersion: '0' }],
			['要求番号なし', { ...body, requestKey: undefined }], ['知らない鍵', { ...body, changedBy: ACTOR }], ['JSON でない', null],
		] as [string, unknown][]) {
			const response = await put(value);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
		expect(mockAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
	});
});
