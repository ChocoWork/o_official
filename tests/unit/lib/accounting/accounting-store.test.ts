/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import {
	createAccountingPeriod,
	getAccountingSettings,
	getOpeningBalances,
	listAccountingPeriods,
	listSavedJournal,
	shortenFinalSolePeriod,
	updateAccountingSettings,
	updatePeriodFiling,
} from '@/lib/accounting/accounting-store';
import { ACCOUNTING_ERRORS, AccountingStoreError } from '@/lib/accounting/accounting-types';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = uuid(90);
const KEY = uuid(91);

const periodRow = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: uuid(n),
	business_type: 'soleProprietor',
	name: '2026年（個人）',
	starts_on: '2026-01-01',
	ends_on: '2026-12-31',
	corporate_tax_extension_months: 0,
	consumption_tax_extension_months: 0,
	consumption_tax_status: 'exempt',
	consumption_taxable_from: null,
	version: '1',
	legacy_fiscal_year: 2026,
	...overrides,
});
const corpRow = (n: number, startsOn: string, endsOn: string, name: string): Record<string, unknown> =>
	periodRow(n, { business_type: 'corporation', name, starts_on: startsOn, ends_on: endsOn, legacy_fiscal_year: null });
const settingsRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	business_start_date: null,
	cutover_on: '2026-11-07',
	current_business_type: 'soleProprietor',
	sole_business_ended_on: null,
	version: '1',
	sole_end_changes: [],
	...overrides,
});
const line = (lineNo: number, debit: number, credit: number): Record<string, unknown> => ({
	line_no: lineNo,
	account_code: debit > 0 ? '5110' : '1040',
	debit,
	credit,
	sub_account: null,
	counterparty: null,
	order_id: null,
	memo: null,
});
const entryRow = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: uuid(n),
	period_id: uuid(1),
	entry_no: n,
	entry_date: '2026-03-01',
	event_kind: 'manual_entry',
	dedupe_key: `manual_entry:${n}:0`,
	description: '文具',
	recorded_at: '2026-03-01T01:00:00+00:00',
	recorded_by: ACTOR,
	is_late: false,
	reverses_entry_id: null,
	reason: null,
	source_table: 'admin_finance_expenses',
	source_id: String(n),
	migrated_from: null,
	migrated_at: null,
	source_recorded_at: null,
	lines: [line(1, 1200, 0), line(2, 0, 1200)],
	...overrides,
});

type RpcResult = { data: unknown; error: unknown };
function clientWith(handler: (name: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult>) {
	const rpc = jest.fn(async (name: string, args: Record<string, unknown> = {}) => handler(name, args));
	return { client: { rpc } as unknown as SupabaseClient, rpc };
}
const dbError = (message: string, code: string, details: string | null = null) => ({ message, code, details, hint: null });

describe('accounting store', () => {
	test('FREQ-555-AC-04: storeはlegacyのrevision_countとreceipt_countをrevisionCountとreceiptCountへ直し、無い仕訳にはlegacyを足さない', async () => {
		const manual = entryRow(1, { legacy: { revision_count: 2, receipt_count: 1 } });
		const order = entryRow(2, { event_kind: 'payment_confirmed', dedupe_key: 'payment_confirmed:pi_1', source_table: null, source_id: null });
		const { client, rpc } = clientWith(() => ({ data: { entries: [manual, order], next_after_date: null, next_after_no: null }, error: null }));
		const page = await listSavedJournal(client, { periodId: uuid(1) });
		expect(rpc).toHaveBeenCalledWith('list_accounting_journal', {
			_period_id: uuid(1), _from: null, _to: null, _limit: 100, _after_entry_date: null, _after_entry_no: null,
		});
		expect(page.nextAfter).toBeNull();
		expect(page.entries[0]).toEqual({
			id: uuid(1), periodId: uuid(1), entryNo: 1, entryDate: '2026-03-01', eventKind: 'manual_entry', dedupeKey: 'manual_entry:1:0',
			description: '文具', recordedAt: '2026-03-01T01:00:00+00:00', recordedBy: ACTOR, isLate: false, reversesEntryId: null,
			reason: null, sourceTable: 'admin_finance_expenses', sourceId: '1', migratedFrom: null, migratedAt: null, sourceRecordedAt: null,
			legacy: { revisionCount: 2, receiptCount: 1 },
			lines: [
				{ lineNo: 1, accountCode: '5110', debit: 1200, credit: 0, subAccount: null, counterparty: null, orderId: null, memo: null },
				{ lineNo: 2, accountCode: '1040', debit: 0, credit: 1200, subAccount: null, counterparty: null, orderId: null, memo: null },
			],
		});
		expect(page.entries[1]).not.toHaveProperty('legacy');
		expect(JSON.stringify(page)).not.toMatch(/revision_count|receipt_count|_id"|entry_no/);
	});

	test('FREQ-555-AC-04: 仕訳の読みは2つの目印を一緒に渡し、続きの目印を日と番号の組で返す', async () => {
		const { client, rpc } = clientWith(() => ({ data: { entries: [entryRow(5)], next_after_date: '2026-03-01', next_after_no: 5 }, error: null }));
		const page = await listSavedJournal(client, {
			periodId: uuid(1), from: '2026-01-01', to: '2026-03-31', limit: 1, afterEntryDate: '2026-02-01', afterEntryNo: 4,
		});
		expect(rpc).toHaveBeenCalledWith('list_accounting_journal', {
			_period_id: uuid(1), _from: '2026-01-01', _to: '2026-03-31', _limit: 1, _after_entry_date: '2026-02-01', _after_entry_no: 4,
		});
		expect(page.nextAfter).toEqual({ entryDate: '2026-03-01', entryNo: 5 });
		rpc.mockClear();
		await expect(listSavedJournal(client, { periodId: uuid(1), afterEntryDate: '2026-02-01' })).rejects.toMatchObject({ code: 'ACCOUNTING_ARGUMENT_INVALID', status: 400 });
		await expect(listSavedJournal(client, { periodId: uuid(1), limit: 201 })).rejects.toMatchObject({ code: 'ACCOUNTING_ARGUMENT_INVALID' });
		expect(rpc).not.toHaveBeenCalled();
	});

	test('FREQ-555-AC-04: DBの形が違う仕訳は500にして返さない', async () => {
		for (const bad of [
			{ entries: [entryRow(1, { event_kind: 'unknown_kind' })], next_after_date: null, next_after_no: null },
			{ entries: [entryRow(1, { lines: [{ ...line(1, 1.5, 0) }] })], next_after_date: null, next_after_no: null },
			{ entries: [entryRow(1, { extra: 'x' })], next_after_date: null, next_after_no: null },
			{ entries: [], next_after_date: '2026-03-01', next_after_no: null },
		]) {
			const { client } = clientWith(() => ({ data: bad, error: null }));
			await expect(listSavedJournal(client, { periodId: uuid(1) })).rejects.toMatchObject({ status: 500, code: null });
		}
	});

	test('FREQ-555-AC-03: 期首の行を直し、行が無ければ空の配列を返す', async () => {
		const { client, rpc } = clientWith(() => ({ data: [{ account_code: '2910', signed_amount: -5000, basis: 'carryover' }, { account_code: '1040', signed_amount: 5000, basis: 'carryover' }], error: null }));
		expect(await getOpeningBalances(client, uuid(1))).toEqual([
			{ accountCode: '2910', signedAmount: -5000, basis: 'carryover' },
			{ accountCode: '1040', signedAmount: 5000, basis: 'carryover' },
		]);
		expect(rpc).toHaveBeenCalledWith('get_accounting_opening', { _period_id: uuid(1) });
		const empty = clientWith(() => ({ data: [], error: null }));
		expect(await getOpeningBalances(empty.client, uuid(1))).toEqual([]);
	});

	test('FREQ-555-AC-04: 期間と設定の読みは camelCase へ直し、legacy_fiscal_year と変更者を出さない', async () => {
		const change = { previousEndedOn: null, newEndedOn: '2026-08-31', reason: '法人へ移るため', changedAt: '2026-09-01T00:00:00+00:00' };
		const { client } = clientWith((name) => name === 'list_accounting_periods'
			? { data: [periodRow(1)], error: null }
			: { data: settingsRow({ sole_business_ended_on: '2026-08-31', sole_end_changes: [change], business_start_date: '2025-04-01' }), error: null });
		expect(await listAccountingPeriods(client)).toEqual([{
			id: uuid(1), businessType: 'soleProprietor', name: '2026年（個人）', startsOn: '2026-01-01', endsOn: '2026-12-31',
			corporateTaxExtensionMonths: 0, consumptionTaxExtensionMonths: 0, consumptionTaxStatus: 'exempt', consumptionTaxableFrom: null, version: '1',
		}]);
		expect(await getAccountingSettings(client)).toEqual({
			businessStartDate: '2025-04-01', cutoverOn: '2026-11-07', currentBusinessType: 'soleProprietor', soleBusinessEndedOn: '2026-08-31',
			version: '1', soleEndChanges: [change],
		});
		const none = clientWith(() => ({ data: [], error: null }));
		expect(await listAccountingPeriods(none.client)).toEqual([]);
	});

	test('FREQ-555-AC-01: 期間の作成は事前検査で断った時は書き込みを呼ばず、DBと同じcodeで断る', async () => {
		const existing = [corpRow(1, '2027-07-01', '2028-06-30', '第1期')];
		const cases: [Record<string, string>, string, number][] = [
			[{ startsOn: '2028-01-01', endsOn: '2028-12-31' }, 'ACCOUNTING_PERIOD_OVERLAP', 409],
			[{ startsOn: '2028-08-01', endsOn: '2029-06-30' }, 'ACCOUNTING_PERIOD_GAP', 409],
			[{ startsOn: '2028-07-01', endsOn: '2029-07-01' }, 'ACCOUNTING_PERIOD_TOO_LONG', 409],
			[{ startsOn: '2028-07-01', endsOn: '2028-06-30' }, 'ACCOUNTING_ARGUMENT_INVALID', 400],
		];
		for (const [range, code, status] of cases) {
			const { client, rpc } = clientWith((name) => ({ data: name === 'list_accounting_periods' ? existing : null, error: null }));
			await expect(createAccountingPeriod(client, ACTOR, { businessType: 'corporation', ...range, requestKey: KEY } as never))
				.rejects.toMatchObject({ code, status });
			expect(rpc.mock.calls.map(([name]) => name)).toEqual(['list_accounting_periods']);
		}
		const sole = clientWith((name) => ({ data: name === 'list_accounting_periods' ? [] : null, error: null }));
		await expect(createAccountingPeriod(sole.client, ACTOR, { businessType: 'soleProprietor', startsOn: '2026-02-01', endsOn: '2026-12-31', requestKey: KEY }))
			.rejects.toMatchObject({ code: 'ACCOUNTING_ARGUMENT_INVALID', status: 400 });
	});

	test('FREQ-555-AC-01: 期間の名前はサーバーがformatPeriodNameで作り、同じ範囲の再送はDBの答えに任せる', async () => {
		const existing = [corpRow(1, '2027-07-01', '2028-06-30', '第1期')];
		const created = corpRow(2, '2028-07-01', '2029-06-30', '第2期');
		const { client, rpc } = clientWith((name) => ({ data: name === 'list_accounting_periods' ? existing : created, error: null }));
		const period = await createAccountingPeriod(client, ACTOR, { businessType: 'corporation', startsOn: '2028-07-01', endsOn: '2029-06-30', requestKey: KEY });
		expect(rpc).toHaveBeenLastCalledWith('admin_create_accounting_period', {
			_actor_id: ACTOR, _business_type: 'corporation', _starts_on: '2028-07-01', _ends_on: '2029-06-30', _name: '第2期', _request_key: KEY,
		});
		expect(period).toMatchObject({ id: uuid(2), name: '第2期', businessType: 'corporation' });

		// 同じ範囲が既にある（再送）: 事前検査の重なりで断らず、DB の再送の答え（または拒否）を返す。
		const replay = clientWith((name) => ({ data: name === 'list_accounting_periods' ? [...existing, created] : created, error: null }));
		await expect(createAccountingPeriod(replay.client, ACTOR, { businessType: 'corporation', startsOn: '2028-07-01', endsOn: '2029-06-30', requestKey: KEY }))
			.resolves.toMatchObject({ id: uuid(2) });
		expect(replay.rpc).toHaveBeenLastCalledWith('admin_create_accounting_period', expect.objectContaining({ _name: '第2期' }));

		const sole = clientWith((name) => ({ data: name === 'list_accounting_periods' ? [] : periodRow(3), error: null }));
		await createAccountingPeriod(sole.client, ACTOR, { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31', requestKey: KEY });
		expect(sole.rpc).toHaveBeenLastCalledWith('admin_create_accounting_period', expect.objectContaining({ _name: '2026年（個人）' }));
	});

	test('FREQ-555-AC-01: 拒否はmessageとSQLSTATEの完全一致だけで分類し、未知は500にして生の文を持たない', async () => {
		for (const [code, [sqlstate, status, message]] of Object.entries(ACCOUNTING_ERRORS)) {
			const { client } = clientWith(() => ({ data: null, error: dbError(code, sqlstate) }));
			const failure = await getAccountingSettings(client).catch((e: unknown) => e);
			expect(failure).toBeInstanceOf(AccountingStoreError);
			expect(failure).toMatchObject({ status, message, code });
		}
		const unknown: [string, string][] = [
			['ACCOUNTING_VERSION_CONFLICT', '23505'],
			['accounting_version_conflict', '40001'],
			['ACCOUNTING_VERSION_CONFLICT: secret', '40001'],
			['duplicate key value violates unique constraint "secret"', '23505'],
		];
		for (const [message, sqlstate] of unknown) {
			const { client } = clientWith(() => ({ data: null, error: dbError(message, sqlstate) }));
			const failure = (await getAccountingSettings(client).catch((e: unknown) => e)) as AccountingStoreError;
			expect([failure.status, failure.code, failure.message]).toEqual([500, null, '会計の処理に失敗しました。']);
			expect(JSON.stringify(failure)).not.toContain('secret');
		}
		const thrown = clientWith(() => { throw new Error('network secret'); });
		await expect(getAccountingSettings(thrown.client)).rejects.toMatchObject({ status: 500, message: '会計の処理に失敗しました。' });
	});

	test('FREQ-555-AC-09: PERIOD_MISSINGはDETAILの固定の語だけで本文を選び、生のDETAILを返さない', async () => {
		const ended = clientWith(() => ({ data: null, error: dbError('ACCOUNTING_PERIOD_MISSING', '55000', 'sole_ended_not_switched') }));
		await expect(getAccountingSettings(ended.client)).rejects.toMatchObject({
			code: 'ACCOUNTING_PERIOD_MISSING', status: 409,
			message: 'やめた日より後の日付です。やめた日が正しいか確かめ、正しければ事業の形を法人へ切り替えてください。',
		});
		for (const details of [null, 'other detail', 'sole_ended_not_switched extra']) {
			const plain = clientWith(() => ({ data: null, error: dbError('ACCOUNTING_PERIOD_MISSING', '55000', details) }));
			const failure = (await getAccountingSettings(plain.client).catch((e: unknown) => e)) as AccountingStoreError;
			expect(failure.message).toBe('この日付の会計の期間がありません。先に期間を作ってください。');
			expect(JSON.stringify({ ...failure, message: failure.message })).not.toContain('other detail');
		}
	});

	test('FREQ-555-AC-07: 個人の最後の期間の入口と、設定・申告の入口へ引数を渡す', async () => {
		const { client, rpc } = clientWith((name) => ({ data: name === 'admin_update_accounting_settings' ? settingsRow({ version: '2' }) : periodRow(1, { version: '2' }), error: null }));
		await shortenFinalSolePeriod(client, ACTOR, { periodId: uuid(1), endedOn: '2026-08-31', expectedPeriodVersion: '1', expectedSettingsVersion: '3', reason: null, requestKey: KEY });
		expect(rpc).toHaveBeenLastCalledWith('admin_shorten_final_sole_period', {
			_actor_id: ACTOR, _period_id: uuid(1), _ended_on: '2026-08-31', _expected_period_version: '1', _expected_settings_version: '3', _reason: null, _request_key: KEY,
		});
		await updatePeriodFiling(client, ACTOR, {
			periodId: uuid(1), corporateTaxExtensionMonths: 0, consumptionTaxExtensionMonths: 0, consumptionTaxStatus: 'taxable',
			consumptionTaxableFrom: '2026-10-01', expectedVersion: '2', requestKey: KEY,
		});
		expect(rpc).toHaveBeenLastCalledWith('admin_update_accounting_period_filing', {
			_actor_id: ACTOR, _period_id: uuid(1), _corporate_tax_extension_months: 0, _consumption_tax_extension_months: 0,
			_consumption_tax_status: 'taxable', _consumption_taxable_from: '2026-10-01', _expected_version: '2', _request_key: KEY,
		});
		const settings = await updateAccountingSettings(client, ACTOR, { businessStartDate: '2025-04-01', currentBusinessType: 'soleProprietor', expectedVersion: '1', requestKey: KEY });
		expect(rpc).toHaveBeenLastCalledWith('admin_update_accounting_settings', {
			_actor_id: ACTOR, _business_start_date: '2025-04-01', _current_business_type: 'soleProprietor', _expected_version: '1', _request_key: KEY,
		});
		expect(settings.version).toBe('2');
		// 書き込みの答えの期間が求めた期間でなければ 500。
		const wrong = clientWith(() => ({ data: periodRow(2), error: null }));
		await expect(shortenFinalSolePeriod(wrong.client, ACTOR, { periodId: uuid(1), endedOn: '2026-08-31', expectedPeriodVersion: '1', expectedSettingsVersion: '3', reason: null, requestKey: KEY }))
			.rejects.toMatchObject({ status: 500 });
	});
});
