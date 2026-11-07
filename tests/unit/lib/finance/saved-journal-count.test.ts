/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import { listSavedJournal } from '@/lib/accounting/accounting-store';
import type { JournalCursor } from '@/lib/accounting/accounting-types';
import { savedEntryToJournalEntry, type SavedJournalEntry } from '@/lib/accounting/journal-types';
import { accountByCode, type Account } from '@/lib/finance/accounts';
import { buildGeneralLedger, buildTrialBalance } from '@/lib/finance/journal';
import { buildProfitAndLoss } from '@/lib/finance/statements';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PERIOD = uuid(9000);

/** n 件目の仕訳は n 円の広告宣伝費（6060）。101件目と201件目だけ1万円を足して、合計に入ったかを見分ける。 */
function entryRow(n: number): Record<string, unknown> {
	const amount = n === 101 || n === 201 ? n + 10_000 : n;
	return {
		id: uuid(n), period_id: PERIOD, entry_no: n, entry_date: '2026-03-01', event_kind: 'manual_entry',
		dedupe_key: `manual_entry:${n}:0`, description: `広告${n}`, recorded_at: '2026-03-01T01:00:00+00:00',
		recorded_by: null, is_late: false, reverses_entry_id: null, reason: null,
		source_table: 'admin_finance_expenses', source_id: String(n), migrated_from: null, migrated_at: null,
		source_recorded_at: null,
		lines: [
			{ line_no: 1, account_code: '6060', debit: amount, credit: 0, sub_account: null, counterparty: null, order_id: null, memo: null },
			{ line_no: 2, account_code: '1010', debit: 0, credit: amount, sub_account: null, counterparty: null, order_id: null, memo: null },
		],
	};
}

describe('保存した仕訳を続きの目印で最後まで読む', () => {
	it('FREQ-557-AC-06: 保存した仕訳が201件ある期間は101件目と201件目も読み試算表と元帳と決算書の合計に入る', async () => {
		// store の既定の100件で読むと 100件＋100件＋1件 の3ページになる。
		const pages = [
			{ entries: Array.from({ length: 100 }, (_, i) => entryRow(i + 1)), next_after_date: '2026-03-01', next_after_no: 100 },
			{ entries: Array.from({ length: 100 }, (_, i) => entryRow(i + 101)), next_after_date: '2026-03-01', next_after_no: 200 },
			{ entries: [entryRow(201)], next_after_date: null, next_after_no: null },
		];
		const rpc = jest.fn(async () => ({ data: pages.shift(), error: null }));
		const client = { rpc } as unknown as SupabaseClient;

		const saved: SavedJournalEntry[] = [];
		let after: JournalCursor | null = null;
		do {
			const page = await listSavedJournal(client, {
				periodId: PERIOD,
				...(after ? { afterEntryDate: after.entryDate, afterEntryNo: after.entryNo } : {}),
			});
			saved.push(...page.entries);
			after = page.nextAfter;
		} while (after !== null);

		expect(rpc).toHaveBeenCalledTimes(3);
		expect(rpc).toHaveBeenNthCalledWith(2, 'list_accounting_journal', expect.objectContaining({ _limit: 100, _after_entry_date: '2026-03-01', _after_entry_no: 100 }));
		expect(rpc).toHaveBeenNthCalledWith(3, 'list_accounting_journal', expect.objectContaining({ _after_entry_no: 200 }));
		expect(saved).toHaveLength(201);

		const journal = saved.map((entry) => savedEntryToJournalEntry(entry, (code) => accountByCode(code) as Account));
		const ledger = buildGeneralLedger(journal);
		const trial = buildTrialBalance(ledger);
		const total = (201 * 202) / 2 + 20_000;
		const advertising = ledger.find((account) => account.account.code === '6060');
		expect(advertising?.rows).toHaveLength(201);
		expect(advertising?.rows.map((row) => row.number)).toEqual(expect.arrayContaining(['JE-000101', 'JE-000201']));
		expect(advertising?.closingBalance).toBe(total);
		expect(trial.debitTotal).toBe(total);
		expect(trial.isBalanced).toBe(true);
		expect(buildProfitAndLoss(trial).operatingExpenses).toBe(total);
	});
});
