import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
	ACCOUNTING_ERRORS,
	AccountingStoreError,
	DEFAULT_JOURNAL_PAGE,
	MAX_JOURNAL_PAGE,
	SOLE_ENDED_NOT_SWITCHED,
	type AccountingErrorCode,
	type AccountingSettings,
	type OpeningBalanceRow,
	type SavedJournalPage,
	type SavedJournalQuery,
} from '@/lib/accounting/accounting-types';
import { ACCOUNTING_EVENT_KINDS } from '@/lib/accounting/event-kinds';
import type { SavedJournalEntry } from '@/lib/accounting/journal-types';
import { formatPeriodName, validateNewPeriod, type AccountingPeriod, type ValidateNewPeriodResult } from '@/lib/accounting/period';

const sqlstateOf = (error: unknown): unknown =>
	error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;

/** message と SQLSTATE の両方が表の1行と一致した時だけ固定コードにする。DETAIL は固定の語だけを見る。 */
function classify(error: unknown): AccountingStoreError {
	if (
		error !== null &&
		typeof error === 'object' &&
		'message' in error &&
		'code' in error &&
		typeof error.message === 'string' &&
		Object.hasOwn(ACCOUNTING_ERRORS, error.message) &&
		ACCOUNTING_ERRORS[error.message as AccountingErrorCode][0] === error.code
	) {
		const details = 'details' in error ? error.details : undefined;
		return new AccountingStoreError(error.message, undefined, { soleEndedNotSwitched: details === SOLE_ENDED_NOT_SWITCHED });
	}
	return new AccountingStoreError(null, sqlstateOf(error));
}

async function rpc(client: SupabaseClient, name: string, args?: Record<string, unknown>): Promise<unknown> {
	let response;
	try {
		response = args === undefined ? await client.rpc(name) : await client.rpc(name, args);
	} catch (error) {
		throw new AccountingStoreError(null, sqlstateOf(error));
	}
	if (response.error) throw classify(response.error);
	return response.data as unknown;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
	const result = schema.safeParse(raw);
	if (!result.success) throw new AccountingStoreError();
	return result.data;
}

const invalid = (): AccountingStoreError => new AccountingStoreError('ACCOUNTING_ARGUMENT_INVALID');
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)));
const version = z.string().regex(/^[1-9][0-9]*$/);
const businessType = z.enum(['soleProprietor', 'corporation']);
const yen = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const periodSchema = z
	.object({
		id: uuid,
		business_type: businessType,
		name: z.string().min(1),
		starts_on: date,
		ends_on: date,
		corporate_tax_extension_months: z.union([z.literal(0), z.literal(1)]),
		consumption_tax_extension_months: z.union([z.literal(0), z.literal(1)]),
		consumption_tax_status: z.enum(['exempt', 'taxable']),
		consumption_taxable_from: date.nullable(),
		version,
		legacy_fiscal_year: z.number().int().nullable(),
	})
	.strict()
	.transform(
		(p): AccountingPeriod => ({
			id: p.id,
			businessType: p.business_type,
			name: p.name,
			startsOn: p.starts_on,
			endsOn: p.ends_on,
			corporateTaxExtensionMonths: p.corporate_tax_extension_months,
			consumptionTaxExtensionMonths: p.consumption_tax_extension_months,
			consumptionTaxStatus: p.consumption_tax_status,
			consumptionTaxableFrom: p.consumption_taxable_from,
			version: p.version,
		}),
	);

const settingsSchema = z
	.object({
		business_start_date: date.nullable(),
		cutover_on: date,
		current_business_type: businessType,
		sole_business_ended_on: date.nullable(),
		version,
		sole_end_changes: z.array(
			z
				.object({ previousEndedOn: date.nullable(), newEndedOn: date, reason: z.string().nullable(), changedAt: timestamp })
				.strict(),
		),
	})
	.strict()
	.transform(
		(s): AccountingSettings => ({
			businessStartDate: s.business_start_date,
			cutoverOn: s.cutover_on,
			currentBusinessType: s.current_business_type,
			soleBusinessEndedOn: s.sole_business_ended_on,
			version: s.version,
			// 初めての登録は理由が無い（DB は NULL）。画面には空の文で渡す。
			soleEndChanges: s.sole_end_changes.map((c) => ({ ...c, reason: c.reason ?? '' })),
		}),
	);

const lineSchema = z
	.object({
		line_no: z.number().int().min(1),
		account_code: z.string().min(1),
		debit: yen,
		credit: yen,
		sub_account: z.string().nullable(),
		counterparty: z.string().nullable(),
		order_id: z.string().nullable(),
		memo: z.string().nullable(),
	})
	.strict();

const entrySchema = z
	.object({
		id: uuid,
		period_id: uuid,
		entry_no: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		entry_date: date,
		event_kind: z.enum(ACCOUNTING_EVENT_KINDS),
		dedupe_key: z.string().min(1),
		description: z.string(),
		recorded_at: timestamp,
		recorded_by: uuid.nullable(),
		is_late: z.boolean(),
		reverses_entry_id: uuid.nullable(),
		reason: z.string().nullable(),
		source_table: z.string().nullable(),
		source_id: z.string().nullable(),
		migrated_from: z.string().nullable(),
		migrated_at: timestamp.nullable(),
		source_recorded_at: timestamp.nullable(),
		lines: z.array(lineSchema).min(1),
		legacy: z.object({ revision_count: count, receipt_count: count }).strict().optional(),
	})
	.strict()
	.transform((e): SavedJournalEntry => ({
		id: e.id,
		periodId: e.period_id,
		entryNo: e.entry_no,
		entryDate: e.entry_date,
		eventKind: e.event_kind,
		dedupeKey: e.dedupe_key,
		description: e.description,
		recordedAt: e.recorded_at,
		recordedBy: e.recorded_by,
		isLate: e.is_late,
		reversesEntryId: e.reverses_entry_id,
		reason: e.reason,
		sourceTable: e.source_table,
		sourceId: e.source_id,
		migratedFrom: e.migrated_from,
		migratedAt: e.migrated_at,
		sourceRecordedAt: e.source_recorded_at,
		...(e.legacy ? { legacy: { revisionCount: e.legacy.revision_count, receiptCount: e.legacy.receipt_count } } : {}),
		lines: e.lines.map((l) => ({
			lineNo: l.line_no,
			accountCode: l.account_code,
			debit: l.debit,
			credit: l.credit,
			subAccount: l.sub_account,
			counterparty: l.counterparty,
			orderId: l.order_id,
			memo: l.memo,
		})),
	}));

const journalPageSchema = z
	.object({
		entries: z.array(entrySchema).max(MAX_JOURNAL_PAGE),
		next_after_date: date.nullable(),
		next_after_no: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
	})
	.strict()
	.refine((p) => (p.next_after_date === null) === (p.next_after_no === null));

const openingSchema = z.array(
	z
		.object({
			account_code: z.string().min(1),
			signed_amount: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
			basis: z.enum(['stored', 'carryover']),
		})
		.strict()
		.transform((o): OpeningBalanceRow => ({ accountCode: o.account_code, signedAmount: o.signed_amount, basis: o.basis })),
);

export async function listAccountingPeriods(client: SupabaseClient): Promise<AccountingPeriod[]> {
	return parse(z.array(periodSchema), await rpc(client, 'list_accounting_periods'));
}

export async function getAccountingSettings(client: SupabaseClient): Promise<AccountingSettings> {
	return parse(settingsSchema, await rpc(client, 'get_accounting_settings'));
}

const PRECHECK_ERRORS: Record<Exclude<ValidateNewPeriodResult, { ok: true }>['code'], AccountingErrorCode> = {
	overlap: 'ACCOUNTING_PERIOD_OVERLAP',
	gap: 'ACCOUNTING_PERIOD_GAP',
	too_long: 'ACCOUNTING_PERIOD_TOO_LONG',
	bad_range: 'ACCOUNTING_ARGUMENT_INVALID',
	sole_not_calendar: 'ACCOUNTING_ARGUMENT_INVALID',
};

export type CreateAccountingPeriodInput = {
	businessType: AccountingPeriod['businessType'];
	startsOn: string;
	endsOn: string;
	requestKey: string;
};

/**
 * 期間を作る。名前はサーバーが `formatPeriodName` で作り（法人は自分より前に始まる法人の期間の数＋1、DB の既定と同じ）、
 * 書き込みの前に `validateNewPeriod` を通して DB と同じ code で断る。
 * 同じ事業の形・範囲の期間が既にある時（同じ要求番号の再送かもしれない）は事前検査で断らず、DB の答え（前の結果か拒否）を返す。
 */
export async function createAccountingPeriod(
	client: SupabaseClient,
	actorId: string,
	input: CreateAccountingPeriodInput,
): Promise<AccountingPeriod> {
	const existing = await listAccountingPeriods(client);
	const sameRange = existing.some(
		(p) => p.businessType === input.businessType && p.startsOn === input.startsOn && p.endsOn === input.endsOn,
	);
	// DB と同じ順に断る: 範囲・長さ・個人の暦年（既存の期間によらない）を先に、重なり・すき間を後に見る。
	const shape = validateNewPeriod({ ...input, existing: [] });
	if (!shape.ok) throw new AccountingStoreError(PRECHECK_ERRORS[shape.code]);
	if (!sameRange) {
		const checked = validateNewPeriod({ ...input, existing });
		if (!checked.ok) throw new AccountingStoreError(PRECHECK_ERRORS[checked.code]);
	}
	const termNumber =
		existing.filter((p) => p.businessType === 'corporation' && p.startsOn < input.startsOn).length + 1;
	const raw = await rpc(client, 'admin_create_accounting_period', {
		_actor_id: actorId,
		_business_type: input.businessType,
		_starts_on: input.startsOn,
		_ends_on: input.endsOn,
		_name: formatPeriodName({ ...input, termNumber }),
		_request_key: input.requestKey,
	});
	const period = parse(periodSchema, raw);
	if (period.businessType !== input.businessType || period.startsOn !== input.startsOn) throw new AccountingStoreError();
	return period;
}

export type UpdateAccountingSettingsInput = {
	businessStartDate: string | null;
	currentBusinessType: AccountingPeriod['businessType'];
	expectedVersion: string;
	requestKey: string;
};

export async function updateAccountingSettings(
	client: SupabaseClient,
	actorId: string,
	input: UpdateAccountingSettingsInput,
): Promise<AccountingSettings> {
	const raw = await rpc(client, 'admin_update_accounting_settings', {
		_actor_id: actorId,
		_business_start_date: input.businessStartDate,
		_current_business_type: input.currentBusinessType,
		_expected_version: input.expectedVersion,
		_request_key: input.requestKey,
	});
	return parse(settingsSchema, raw);
}

export type UpdatePeriodFilingInput = {
	periodId: string;
	corporateTaxExtensionMonths: 0 | 1;
	consumptionTaxExtensionMonths: 0 | 1;
	consumptionTaxStatus: AccountingPeriod['consumptionTaxStatus'];
	consumptionTaxableFrom: string | null;
	expectedVersion: string;
	requestKey: string;
};

export async function updatePeriodFiling(
	client: SupabaseClient,
	actorId: string,
	input: UpdatePeriodFilingInput,
): Promise<AccountingPeriod> {
	const raw = await rpc(client, 'admin_update_accounting_period_filing', {
		_actor_id: actorId,
		_period_id: input.periodId,
		_corporate_tax_extension_months: input.corporateTaxExtensionMonths,
		_consumption_tax_extension_months: input.consumptionTaxExtensionMonths,
		_consumption_tax_status: input.consumptionTaxStatus,
		_consumption_taxable_from: input.consumptionTaxableFrom,
		_expected_version: input.expectedVersion,
		_request_key: input.requestKey,
	});
	const period = parse(periodSchema, raw);
	if (!sameId(period.id, input.periodId)) throw new AccountingStoreError();
	return period;
}

export type ShortenFinalSolePeriodInput = {
	periodId: string;
	endedOn: string;
	expectedPeriodVersion: string;
	expectedSettingsVersion: string;
	reason: string | null;
	requestKey: string;
};

/** 個人の最後の期間をやめた日までにする（Task 7 の専用入口）。 */
export async function shortenFinalSolePeriod(
	client: SupabaseClient,
	actorId: string,
	input: ShortenFinalSolePeriodInput,
): Promise<AccountingPeriod> {
	const raw = await rpc(client, 'admin_shorten_final_sole_period', {
		_actor_id: actorId,
		_period_id: input.periodId,
		_ended_on: input.endedOn,
		_expected_period_version: input.expectedPeriodVersion,
		_expected_settings_version: input.expectedSettingsVersion,
		_reason: input.reason,
		_request_key: input.requestKey,
	});
	const period = parse(periodSchema, raw);
	if (!sameId(period.id, input.periodId)) throw new AccountingStoreError();
	return period;
}

/** 期間の仕訳を日→通し番号の順に1ページ読む。続きの2つの目印は一緒に渡す。 */
export async function listSavedJournal(client: SupabaseClient, query: SavedJournalQuery): Promise<SavedJournalPage> {
	const limit = query.limit ?? DEFAULT_JOURNAL_PAGE;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > MAX_JOURNAL_PAGE ||
		(query.afterEntryDate === undefined) !== (query.afterEntryNo === undefined)
	) {
		throw invalid();
	}
	const raw = await rpc(client, 'list_accounting_journal', {
		_period_id: query.periodId,
		_from: query.from ?? null,
		_to: query.to ?? null,
		_limit: limit,
		_after_entry_date: query.afterEntryDate ?? null,
		_after_entry_no: query.afterEntryNo ?? null,
	});
	const page = parse(journalPageSchema, raw);
	if (page.entries.length > limit) throw new AccountingStoreError();
	return {
		entries: page.entries,
		nextAfter:
			page.next_after_date !== null && page.next_after_no !== null
				? { entryDate: page.next_after_date, entryNo: page.next_after_no }
				: null,
	};
}

/** 期首の残高。行が1つも無ければ期首は無い（basis none）ので空の配列。 */
export async function getOpeningBalances(client: SupabaseClient, periodId: string): Promise<OpeningBalanceRow[]> {
	return parse(openingSchema, await rpc(client, 'get_accounting_opening', { _period_id: periodId }));
}
