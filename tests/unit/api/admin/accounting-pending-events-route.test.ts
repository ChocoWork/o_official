/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as pendingGet } from '@/app/api/admin/accounting/pending-events/route';
import { POST as resolvePost } from '@/app/api/admin/accounting/pending-events/[id]/resolve/route';
import { POST as runPost, maxDuration } from '@/app/api/admin/accounting/posting/run/route';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ACTOR, KEY, PERM, claims, createHarness, dbError, uuid, type StopCase } from './accounting-route-harness';

const harness = createHarness({
	verifyAccessToken: verifyAccessToken as jest.Mock,
	checkAuthSessionLiveness: checkAuthSessionLiveness as jest.Mock,
	createServiceRoleClient: createServiceRoleClient as jest.Mock,
	csrf: mockCsrf,
	rate: mockRate,
	audit: mockAudit,
});
const { seq, rpcImpl, grants, read } = harness;

const EVENT = uuid(201);
const eventRow = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: uuid(200 + n), event_kind: 'shipment_confirmed', source_table: 'shipment_slips', source_id: uuid(500 + n), order_id: uuid(600 + n),
	reason: 'payment_journal_missing', detail: { order_count: 1 }, first_detected_at: '2026-11-09T01:00:00+00:00',
	last_detected_at: '2026-11-09T01:10:00+00:00', detection_count: 2, resolved_at: null, resolved_entry_id: null, ...overrides,
});
const EVENT_KEYS = ['detail', 'detectionCount', 'eventKind', 'firstDetectedAt', 'id', 'lastDetectedAt', 'orderId', 'reason', 'resolvedAt', 'resolvedEntryId', 'sourceId', 'sourceTable'];

const state = { page: { events: [eventRow(1), eventRow(2)], next_after_at: '2026-11-09T01:00:00+00:00', next_after_id: uuid(202), open_count: 7 } as Record<string, unknown> };
const defaultRpc = (name: string): { data: unknown; error: null } => {
	switch (name) {
		case 'list_accounting_pending_events': return { data: state.page, error: null };
		case 'get_accounting_pending_summary': return { data: { open_count: 7, by_reason: { payment_journal_missing: 5, before_cutover: 2 }, oldest_at: '2026-11-08T00:00:00+00:00' }, error: null };
		case 'admin_resolve_accounting_pending_event': return { data: eventRow(1, { reason: 'before_cutover', resolved_at: '2026-11-09T02:00:00+00:00' }), error: null };
		case 'accounting_run_posting': return { data: { payments: 1, shipments: 2, stripe: 3, disputes: 0, parked: 4, resolved: 5, has_more: false }, error: null };
		default: throw new Error(`unexpected rpc ${name}`);
	}
};

const base = 'https://example.test/api/admin/accounting';
const get = (query = '') => pendingGet(new Request(`${base}/pending-events${query}`));
const resolveBody = { note: '切り替え前の記録なので確認済み', requestKey: KEY };
const resolve = (value: unknown = resolveBody, id: string = EVENT) =>
	resolvePost(new Request(`${base}/pending-events/${id}/resolve`, { method: 'POST', body: JSON.stringify(value) }), { params: Promise.resolve({ id }) });
const run = (body: BodyInit | null = JSON.stringify({})) => runPost(new Request(`${base}/posting/run`, { method: 'POST', body }));

beforeEach(() => {
	jest.resetAllMocks();
	harness.setup([PERM.read, PERM.manage, PERM.correct, PERM.settings]);
	state.page = { events: [eventRow(1), eventRow(2)], next_after_at: '2026-11-09T01:00:00+00:00', next_after_id: uuid(202), open_count: 7 };
	rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/accounting/pending-events', () => {
	test('FREQ-569-AC-01: 計上待ちの一覧の応答に名前・メールの鍵が無い', async () => {
		grants.current = [PERM.read];
		const response = await get('?includeResolved=false&limit=2&afterAt=2026-11-09T02:00:00%2B00:00&afterId=' + uuid(209));
		expect(response.status).toBe(200);
		const body = await read(response);
		expect(Object.keys(body).sort()).toEqual(['data', 'permissions']);
		const data = body.data as { events: Record<string, unknown>[]; nextAfterAt: string | null; nextAfterId: string | null; openCount: number; byReason: Record<string, number> };
		expect(Object.keys(data).sort()).toEqual(['byReason', 'events', 'nextAfterAt', 'nextAfterId', 'openCount']);
		for (const event of data.events) expect(Object.keys(event).sort()).toEqual(EVENT_KEYS);
		expect(data.events[0]).toMatchObject({ id: uuid(201), eventKind: 'shipment_confirmed', reason: 'payment_journal_missing', detail: { order_count: 1 }, detectionCount: 2, resolvedAt: null });
		expect(data.nextAfterAt).toBe('2026-11-09T01:00:00+00:00');
		expect(data.nextAfterId).toBe(uuid(202));
		expect(data.openCount).toBe(7);
		expect(data.byReason).toEqual({ payment_journal_missing: 5, before_cutover: 2 });
		// 名前・メール・DB の列名・閲覧者の番号は本文に出さない。
		const text = JSON.stringify(body);
		expect(text).not.toMatch(/"(name|email|customer|address|phone|note|resolved_by)[A-Za-z_]*":/i);
		expect(text).not.toContain('owner@example.test');
		expect(text).not.toContain(ACTOR);
		expect(rpcImpl).toHaveBeenCalledWith('list_accounting_pending_events', {
			_include_resolved: false, _limit: 2, _after_at: '2026-11-09T02:00:00+00:00', _after_id: uuid(209),
		});
		expect(seq).toEqual(['auth', 'rpc:list_accounting_pending_events', 'rpc:get_accounting_pending_summary']);
		expect(mockRate).not.toHaveBeenCalled(); expect(mockCsrf).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
	});

	test('FREQ-569-AC-01: 既定は未解決・50件。includeResolved=trueで解決済みも読む', async () => {
		await get();
		expect(rpcImpl).toHaveBeenCalledWith('list_accounting_pending_events', { _include_resolved: false, _limit: 50, _after_at: null, _after_id: null });
		await get('?includeResolved=true');
		expect(rpcImpl).toHaveBeenLastCalledWith('get_accounting_pending_summary', undefined);
		expect(rpcImpl).toHaveBeenCalledWith('list_accounting_pending_events', { _include_resolved: true, _limit: 50, _after_at: null, _after_id: null });
	});

	test('FREQ-569-AC-01: 不正な問い合わせはDBを呼ばず400。知らない鍵・重ねた鍵・片方だけの目印・範囲外も断る', async () => {
		for (const query of [
			'?limit=0', '?limit=101', '?limit=1.5', '?limit=abc', '?includeResolved=yes', '?includeResolved=true&includeResolved=false',
			`?afterAt=2026-11-09T01:00:00%2B00:00`, `?afterId=${uuid(1)}`, '?afterAt=bad&afterId=' + uuid(1), `?afterAt=2026-11-09T01:00:00%2B00:00&afterId=not-a-uuid`,
			`?actorId=${ACTOR}`,
		]) {
			const bad = await get(query);
			expect([query, bad.status, await read(bad)]).toEqual([query, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		}
		expect(rpcImpl).not.toHaveBeenCalled();
	});

	test('FREQ-569-AC-01: 続きの目印が古くてDBが22023で断ったら、一般の400でなく409で最初から読み直させる', async () => {
		const stale = `?afterAt=2026-11-09T01:00:00%2B00:00&afterId=${uuid(209)}`;
		rpcImpl.mockImplementation(async (name: string) => (name === 'list_accounting_pending_events' ? dbError('ACCOUNTING_ARGUMENT_INVALID', '22023') : defaultRpc(name)));
		const response = await get(stale);
		expect([response.status, await read(response)]).toEqual([409, { code: 'ACCOUNTING_LIST_RESTART', error: '一覧が変わりました。最初から読み直してください。' }]);
		// 目印の無い問い合わせの22023は一般の入力の誤り。
		const plain = await get();
		expect([plain.status, (await read(plain)).code]).toEqual([400, 'ACCOUNTING_ARGUMENT_INVALID']);
	});

	test('FREQ-569-AC-03: 読みはadmin.finance.readを求め、aal1を断り、壊れた応答・未知の失敗は固定の500', async () => {
		grants.current = [PERM.manage, PERM.correct];
		expect((await get()).status).toBe(403);
		grants.current = [PERM.read];
		(verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
		expect((await get()).status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled();
		state.page = { events: [eventRow(1, { reason: 'unknown_reason' })], next_after_at: null, next_after_id: null, open_count: 1 };
		const broken = await get();
		expect([broken.status, await read(broken)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
		rpcImpl.mockImplementation(async (name: string) => (name === 'get_accounting_pending_summary' ? dbError('boom secret', 'XX000', 'secret') : defaultRpc(name)));
		state.page = { events: [], next_after_at: null, next_after_id: null, open_count: 0 };
		const failed = await get();
		expect([failed.status, await read(failed)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
	});
});

describe('POST /api/admin/accounting/pending-events/[id]/resolve', () => {
	test('FREQ-569-AC-03: 確認済みはadmin.accounting.entries.correctの人だけで、メモ本文を監査に入れない', async () => {
		grants.current = [PERM.correct];
		const response = await resolve();
		expect(response.status).toBe(200);
		const body = await read(response);
		const event = (body.data as { event: Record<string, unknown> }).event;
		expect(Object.keys(event).sort()).toEqual(EVENT_KEYS);
		expect(event).toMatchObject({ id: uuid(201), reason: 'before_cutover', resolvedAt: '2026-11-09T02:00:00+00:00' });
		expect(JSON.stringify(body)).not.toContain(resolveBody.note);
		// 認可 → CSRF → IP → actor → 入力 → store → 監査。
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:admin_resolve_accounting_pending_event', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('admin_resolve_accounting_pending_event', {
			_actor_id: ACTOR, _event_id: EVENT, _note: resolveBody.note, _request_key: KEY,
		});
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.pending.resolve', actor_id: ACTOR, resource: 'accounting', resource_id: EVENT, outcome: 'success',
			metadata: { event_id: EVENT, result: 'resolved' },
		});
		const audit = JSON.stringify(mockAudit.mock.calls);
		for (const secret of [resolveBody.note, KEY, 'owner@example.test']) expect(audit).not.toContain(secret);
		expect(mockRate).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'admin.accounting.write', limit: 30, windowSeconds: 600 }));
	});

	test('FREQ-569-AC-03: 権限なし・aal1・CSRF欠落・429・不正入力ではstoreを呼ばない', async () => {
		const stops: StopCase[] = [
			['aal1', () => (verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') })), 403],
			['finance.manageだけ', () => { grants.current = [PERM.read, PERM.manage, PERM.settings]; }, 403],
			['CSRF', () => mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 })), 403],
			['IP 429', () => mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 })), 429],
		];
		for (const [label, arrange, status] of stops) {
			grants.current = [PERM.correct]; rpcImpl.mockClear(); mockAudit.mockClear();
			arrange();
			const denied = await resolve();
			expect([label, denied.status]).toEqual([label, status]);
			expect(denied.headers.get('cache-control')).toContain('no-store');
			expect(rpcImpl).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
		}
		// actor の 429（IP は通る）。
		grants.current = [PERM.correct];
		mockRate.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await resolve()).status).toBe(429);
		expect(rpcImpl).not.toHaveBeenCalled();
		const bad: [string, unknown, string?][] = [
			['メモなし', { requestKey: KEY }], ['空のメモ', { ...resolveBody, note: '   ' }], ['501文字', { ...resolveBody, note: 'あ'.repeat(501) }],
			['メモが文字でない', { ...resolveBody, note: 1 }], ['要求番号なし', { note: 'x' }], ['要求番号が不正', { ...resolveBody, requestKey: 'bad' }],
			['知らない鍵', { ...resolveBody, actorId: ACTOR }], ['本文がJSONでない', null], ['IDが不正', resolveBody, 'not-a-uuid'],
		];
		for (const [label, value, id] of bad) {
			rpcImpl.mockClear(); mockAudit.mockClear();
			const response = await resolve(value, id);
			expect([label, response.status, await read(response)]).toEqual([label, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
			expect(rpcImpl).not.toHaveBeenCalled();
			// 失敗の監査にもメモの本文・要求番号は入らない。
			expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(resolveBody.note);
		}
		// 500文字ちょうどは通る。
		expect((await resolve({ ...resolveBody, note: 'あ'.repeat(500) })).status).toBe(200);
	});

	test.each([
		['ACCOUNTING_EVENT_NOT_POSTABLE', '55000', 409, 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。'],
		['ACCOUNTING_PENDING_RESOLVED', '55000', 409, 'この計上待ちは既に解決されています。'],
		['ACCOUNTING_NOT_FOUND', 'P0002', 404, '会計の記録が見つかりません。'],
		['ACCOUNTING_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
		['ACCOUNTING_FORBIDDEN', '42501', 403, '会計を操作する権限がありません。'],
	])('FREQ-569-AC-03: DBの%sは表の状態と本文で返し、監査は対象の番号と結果コードだけ', async (message, sqlstate, status, text) => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_resolve_accounting_pending_event' ? dbError(message, sqlstate, 'PRIVATE-MARKER') : defaultRpc(name)));
		const response = await resolve();
		expect([response.status, await read(response)]).toEqual([status, { code: message, error: text }]);
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.pending.resolve', actor_id: ACTOR, resource: 'accounting', resource_id: EVENT, outcome: 'failure',
			metadata: { event_id: EVENT, result_code: message },
		});
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(resolveBody.note);
	});

	test('FREQ-569-AC-03: 同じ文でもSQLSTATEが違えば分類せず固定の500', async () => {
		rpcImpl.mockImplementation(async (name: string) => (name === 'admin_resolve_accounting_pending_event' ? dbError('ACCOUNTING_PENDING_RESOLVED', '23505') : defaultRpc(name)));
		const response = await resolve();
		expect([response.status, await read(response)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
		expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', metadata: { event_id: EVENT, result_code: 'ACCOUNTING_FAILED' } }));
	});
});

describe('POST /api/admin/accounting/posting/run', () => {
	test('FREQ-569-AC-03: 今すぐ計上はadmin.finance.manageの人だけ', async () => {
		grants.current = [PERM.read, PERM.correct, PERM.settings];
		const denied = await run();
		expect(denied.status).toBe(403);
		expect(rpcImpl).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
		grants.current = [PERM.manage];
		seq.length = 0;
		const ok = await run();
		expect(ok.status).toBe(200);
		expect((await read(ok)).data).toEqual({ result: { payments: 1, shipments: 2, stripe: 3, disputes: 0, parked: 4, resolved: 5, hasMore: false } });
		expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:accounting_run_posting', 'audit']);
		expect(rpcImpl).toHaveBeenCalledWith('accounting_run_posting', { _limit: 50 });
		// 監査は件数だけ。
		expect(mockAudit).toHaveBeenCalledWith({
			action: 'admin.accounting.posting.run', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success',
			metadata: { counts: { payments: 1, shipments: 2, stripe: 3, disputes: 0, parked: 4, resolved: 5, has_more: false } },
		});
	});

	test('FREQ-562-AC-05: 今すぐ計上もhas_moreが偽になるまで繰り返し、20回で止まる。数は回ごとの合計', async () => {
		let calls = 0;
		rpcImpl.mockImplementation(async () => {
			calls += 1;
			return { data: { payments: 1, shipments: 0, stripe: 0, disputes: 0, parked: 1, resolved: 0, has_more: calls < 3 }, error: null };
		});
		grants.current = [PERM.manage];
		const response = await run('');
		expect(response.status).toBe(200);
		expect((await read(response)).data).toEqual({ result: { payments: 3, shipments: 0, stripe: 0, disputes: 0, parked: 3, resolved: 0, hasMore: false } });
		expect(calls).toBe(3);
		calls = 0;
		rpcImpl.mockImplementation(async () => {
			calls += 1;
			return { data: { payments: 0, shipments: 0, stripe: 0, disputes: 0, parked: 0, resolved: 0, has_more: true }, error: null };
		});
		const capped = await run();
		expect(calls).toBe(20);
		expect(((await read(capped)).data as { result: { hasMore: boolean } }).result.hasMore).toBe(true);
	});

	test('FREQ-569-AC-03: 入力の誤り・CSRF・回数制限・失敗は係を呼ばない／固定の失敗にする', async () => {
		grants.current = [PERM.manage];
		const extra = await run(JSON.stringify({ limit: 200 }));
		expect([extra.status, await read(extra)]).toEqual([400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
		mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 }));
		expect((await run()).status).toBe(403);
		mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
		expect((await run()).status).toBe(429);
		expect(rpcImpl).not.toHaveBeenCalled();
		rpcImpl.mockImplementation(async () => dbError('boom secret', 'XX000', 'secret'));
		const failed = await run();
		expect([failed.status, await read(failed)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
		expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'admin.accounting.posting.run', outcome: 'error', metadata: { result_code: 'ACCOUNTING_FAILED' } }));
		expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('secret');
		expect(maxDuration).toBe(120);
	});
});
