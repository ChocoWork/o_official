import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { parseJournalQuery, uuidSchema } from '@/lib/accounting/accounting-schema';
import {
	getAccountingSettings,
	getOpeningBalances,
	listAccountingPeriods,
	listSavedJournal,
} from '@/lib/accounting/accounting-store';
import { listJournalShipmentMeta } from '@/lib/accounting/posting-store';
import {
	ACCOUNTING_LIST_RESTART,
	AccountingListRestartError,
	AccountingStoreError,
	type AccountingJournalData,
	type AccountingPeriodsData,
	type AccountingPermissions,
} from '@/lib/accounting/accounting-types';
import { filingDeadlines } from '@/lib/accounting/filing-deadlines';
import { isJpHoliday } from '@/lib/accounting/jp-holidays';
import { toJstDate } from '@/lib/accounting/jst-date';
import { startupDeadlines } from '@/lib/accounting/startup-deadlines';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermission, type PermissionCode } from '@/lib/auth/admin-rbac';
import { NO_STORE_CACHE_CONTROL } from '@/lib/http/no-store';
import { createServiceRoleClient } from '@/lib/supabase/server';

export type AccountingContext = { params: Promise<{ id: string }> };
export type AccountingAuditAction =
	| 'admin.accounting.period.create'
	| 'admin.accounting.period.final_sole'
	| 'admin.accounting.period.filing'
	| 'admin.accounting.settings.update'
	| 'admin.accounting.pending.resolve'
	| 'admin.accounting.posting.run'
	| 'admin.accounting.dispute.setting'
	| 'admin.accounting.dispute.assign'
	| 'admin.accounting.stripe.invoice'
	| 'admin.accounting.stripe.topup'
	| 'admin.accounting.year_end.check'
	| 'admin.accounting.shipping.options';
/**
 * 監査に載せる値。名前・メール・金額・日付（開業日を含む）・メモの本文は載せない（FREQ-561-AC-04）。
 * 計画2: 対象の番号（event_id・dispute_id）、原因と勘定の符号、月、結果、係の件数だけを足せる。
 */
export type AccountingAuditMetadata = {
	period_id?: string;
	event_id?: string;
	dispute_id?: string;
	slip_id?: string;
	result_code?: string;
	changed_fields?: string[];
	reason?: string;
	account_code?: string;
	month?: string;
	result?: string;
	counts?: Record<string, number | boolean>;
};
/** 失敗の監査に対象の番号を載せる時の鍵。 */
export type AccountingAuditIdKey = 'period_id' | 'event_id' | 'dispute_id' | 'slip_id';

const WINDOW_SECONDS = 600;
const WRITE_LIMIT = 30;
const WRITE_ENDPOINT = 'admin.accounting.write';
const READ: PermissionCode = 'admin.finance.read';
const MANAGE: PermissionCode = 'admin.accounting.settings.manage';

function noStore<T extends Response>(response: T): T {
	response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	return response;
}
const json = (body: unknown, status: number): Response => noStore(NextResponse.json(body, { status }));
const failureResponse = (error: AccountingStoreError): Response =>
	json({ ...(error.code && error.status < 500 ? { code: error.code } : {}), error: error.message }, error.status);
const listRestartResponse = (): Response =>
	json({ code: ACCOUNTING_LIST_RESTART.code, error: ACCOUNTING_LIST_RESTART.message }, ACCOUNTING_LIST_RESTART.status);
const invalid = (): AccountingStoreError => new AccountingStoreError('ACCOUNTING_ARGUMENT_INVALID');
const sqlstateOf = (error: unknown): unknown =>
	error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
const asStoreError = (error: unknown): AccountingStoreError =>
	error instanceof AccountingStoreError ? error : new AccountingStoreError(null, sqlstateOf(error));
const permissionsOf = (permissions: ReadonlySet<PermissionCode>): AccountingPermissions => ({
	manageSettings: permissions.has(MANAGE),
});

function logUnexpected(label: string, failure: AccountingStoreError): void {
	if (failure.status === 500) console.error(`${label} error:`, failure.name, failure.sqlstate ?? null);
}

/** 回数の制限は IP と actor を別々に数える。IP は getClientIp だけから取られる（enforceRateLimit の内部）。 */
async function limitIpAndActor(request: Request, actorId: string): Promise<Response | undefined> {
	const rate = { request, endpoint: WRITE_ENDPOINT, limit: WRITE_LIMIT, windowSeconds: WINDOW_SECONDS };
	const ip = await enforceRateLimit(rate);
	if (ip) return noStore(ip);
	const actor = await enforceRateLimit({ ...rate, subject: actorId });
	return actor ? noStore(actor) : undefined;
}

/** 期間ごとの申告の期限と中間申告、開業日からの届け出の期限をサーバーで計算して付ける（SQL は期限を計算しない）。 */
export async function readAccountingPeriods(client: SupabaseClient, today: string): Promise<AccountingPeriodsData> {
	const periods = await listAccountingPeriods(client);
	const settings = await getAccountingSettings(client);
	const deadlines: AccountingPeriodsData['deadlines'] = {};
	const interim: AccountingPeriodsData['interim'] = {};
	for (const period of periods) {
		const result = filingDeadlines(period, isJpHoliday);
		deadlines[period.id] = result.deadlines;
		interim[period.id] = result.interim;
	}
	const startup = settings.businessStartDate === null ? [] : startupDeadlines(settings.businessStartDate, today, isJpHoliday);
	return { periods, settings, deadlines, interim, startup };
}

/** 読み: 認可(admin.finance.read) → 検証 → store。回数の制限・CSRF・監査は付けない。全応答が no-store。 */
export async function handleRead(
	request: Request,
	label: string,
	load: (client: SupabaseClient, request: Request) => Promise<unknown>,
): Promise<Response> {
	try {
		const authz = await authorizeAdminPermission(READ, request);
		if (!authz.ok) return noStore(authz.response);
		const data = await load(await createServiceRoleClient(), request);
		return json({ data, permissions: permissionsOf(authz.permissions) }, 200);
	} catch (error) {
		// 続きの目印が古い時は、画面に一覧の最初から読み直させる（一般の入力の誤りと分ける）。
		if (error instanceof AccountingListRestartError) return listRestartResponse();
		const failure = asStoreError(error);
		logUnexpected(label, failure);
		return failureResponse(failure);
	}
}

export function handlePeriodsGet(request: Request): Promise<Response> {
	return handleRead(request, 'GET /api/admin/accounting/periods', (client) =>
		readAccountingPeriods(client, toJstDate(new Date())),
	);
}

export function handleSettingsGet(request: Request): Promise<Response> {
	return handleRead(request, 'GET /api/admin/accounting/settings', async (client) => ({
		settings: await getAccountingSettings(client),
	}));
}

const EMPTY_JOURNAL: AccountingJournalData = { entries: [], nextAfter: null, opening: [], shipmentMeta: [] };

/** periodId を省略した時は、期間が1つも無ければ空の一覧、あれば入力の誤り。渡した期間が無い時も空の一覧（404 にしない）。 */
export function handleJournalGet(request: Request): Promise<Response> {
	return handleRead(request, 'GET /api/admin/accounting/journal', async (client, req): Promise<AccountingJournalData> => {
		const query = parseJournalQuery(new URL(req.url).searchParams);
		if (!query) throw invalid();
		const { periodId } = query;
		if (periodId === undefined) {
			if ((await listAccountingPeriods(client)).length === 0) return EMPTY_JOURNAL;
			throw invalid();
		}
		try {
			const page = await listSavedJournal(client, { ...query, periodId });
			const opening = await getOpeningBalances(client, periodId);
			// 出荷の仕訳にだけ、出荷した日と発送票を確定した日を付ける（6-c）。ほかの仕訳は呼ばない。
			const shipmentMeta = await listJournalShipmentMeta(
				client,
				page.entries.filter((entry) => entry.sourceTable === 'shipment_slips').map((entry) => entry.id),
			);
			return { ...page, opening, shipmentMeta };
		} catch (error) {
			if (error instanceof AccountingStoreError && error.code === 'ACCOUNTING_NOT_FOUND') return EMPTY_JOURNAL;
			throw error;
		}
	});
}

export type AccountingWriteSpec<B, R> = {
	label: string;
	action: AccountingAuditAction;
	/** true: URL の [id] を検証して run へ渡す。 */
	withId: boolean;
	/** [id] の検査。省くと UUID。 */
	idSchema?: z.ZodType<string>;
	/** 失敗の監査に [id] を載せる鍵。省くと period_id。 */
	idKey?: AccountingAuditIdKey;
	/** 要る権限。省くと admin.accounting.settings.manage。 */
	permission?: PermissionCode;
	schema: z.ZodType<B>;
	status: 200 | 201;
	run: (client: SupabaseClient, actorId: string, id: string | null, body: B) => Promise<R>;
	/** 成功時の監査の値と resource_id。 */
	audit: (result: R, id: string | null) => { resourceId: string | null; metadata: AccountingAuditMetadata };
	/** 監査の後に返す本文の data。 */
	respond: (client: SupabaseClient, result: R) => Promise<unknown>;
};

/**
 * 書き込み: 認可(spec.permission。省くと admin.accounting.settings.manage) → CSRF → IP の制限 → actor の制限 → 入力 → store → 監査 → 応答。
 * 途中で断ったら以降を呼ばない。actor は認可の結果の userId だけで、本文からは受け取らない。
 */
export async function handleAccountingWrite<B, R>(
	request: Request,
	context: AccountingContext | null,
	spec: AccountingWriteSpec<B, R>,
): Promise<Response> {
	let audit: ((outcome: 'success' | 'failure' | 'error', resourceId: string | null, metadata: AccountingAuditMetadata) => Promise<void>) | undefined;
	let id: string | null = null;
	try {
		const authz = await authorizeAdminPermission(spec.permission ?? MANAGE, request);
		if (!authz.ok) return noStore(authz.response);
		const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
		const csrf = await requireCsrfOrDeny();
		if (csrf instanceof Response) return noStore(csrf);
		const limited = await limitIpAndActor(request, authz.userId);
		if (limited) return limited;
		audit = async (outcome, resourceId, metadata) => {
			await logAudit({ action: spec.action, actor_id: authz.userId, resource: 'accounting', resource_id: resourceId, outcome, metadata });
		};
		if (spec.withId) {
			const parsedId = (spec.idSchema ?? uuidSchema).safeParse((await context?.params)?.id);
			if (!parsedId.success) throw invalid();
			id = parsedId.data;
		}
		const body = spec.schema.safeParse(await request.json().catch(() => null));
		if (!body.success) throw invalid();
		const client = await createServiceRoleClient();
		const result = await spec.run(client, authz.userId, id, body.data);
		const success = spec.audit(result, id);
		// 書き込みは済んでいる。監査の障害で成功を500に変えない（logAudit 自身も例外を握る）。
		await audit('success', success.resourceId, success.metadata).catch(() => {});
		audit = undefined;
		return json({ data: await spec.respond(client, result) }, spec.status);
	} catch (error) {
		const failure = asStoreError(error);
		logUnexpected(spec.label, failure);
		const resultCode = failure.code ?? 'ACCOUNTING_FAILED';
		if (audit) {
			await audit(failure.status >= 500 ? 'error' : 'failure', id, { ...(id ? { [spec.idKey ?? 'period_id']: id } : {}), result_code: resultCode }).catch(() => {});
		}
		return failureResponse(failure);
	}
}
