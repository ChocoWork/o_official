// 保存した仕訳の型と、既存の画面の仕訳の型（JournalEntry）へ直す関数。

import type { Account } from '@/lib/finance/accounts';
import type { JournalEntry } from '@/lib/finance/journal';
import type { AccountingEventKind } from '@/lib/accounting/event-kinds';
import { parseEventKey } from '@/lib/accounting/event-key';

/** 仕訳の行の補助の符号が指す勘定（設計 7-d・7-f・7-a）。processor は `processor:<決済会社>` で使う。 */
export const ACCOUNTING_SUB_ACCOUNTS = {
	return_refund: { accountCode: '2130' },
	dispute_pending: { accountCode: '1470' },
	processor: { accountCode: '1130' },
} as const;

export type SavedJournalLine = {
	lineNo: number;
	accountCode: string;
	debit: number;
	credit: number;
	subAccount: string | null;
	counterparty: string | null;
	orderId: string | null;
	memo: string | null;
};

export type SavedJournalEntry = {
	id: string;
	periodId: string;
	entryNo: number;
	entryDate: string;
	eventKind: AccountingEventKind;
	dedupeKey: string;
	description: string;
	recordedAt: string;
	recordedBy: string | null;
	isLate: boolean;
	reversesEntryId: string | null;
	reason: string | null;
	sourceTable: string | null;
	sourceId: string | null;
	migratedFrom: string | null;
	migratedAt: string | null;
	sourceRecordedAt: string | null;
	legacy?: { revisionCount: number; receiptCount: number };
	lines: readonly SavedJournalLine[];
};

/** 手入力の行の番号が印から分かるときだけ返す（manual_entry・migrated_entry の1つ目の番号）。 */
function manualEntryId(saved: SavedJournalEntry): number {
	if (saved.eventKind !== 'manual_entry' && saved.eventKind !== 'migrated_entry') return -1;
	const parsed = parseEventKey(saved.dedupeKey);
	const first = parsed?.kind === saved.eventKind ? parsed.parts[0] : undefined;
	if (!first || !/^[1-9]\d*$/.test(first)) return -1;
	const id = Number(first);
	return Number.isSafeInteger(id) ? id : -1;
}

export function savedEntryToJournalEntry(
	saved: SavedJournalEntry,
	accounts: (code: string) => Account,
): JournalEntry {
	const lines = [...saved.lines].sort((a, b) => a.lineNo - b.lineNo);
	return {
		entryId: manualEntryId(saved),
		sourceKey: saved.dedupeKey,
		number: `JE-${String(saved.entryNo).padStart(6, '0')}`,
		date: saved.entryDate,
		description: saved.description,
		partner: lines.find((line) => line.counterparty)?.counterparty ?? '',
		lines: lines.map((line) => ({ account: accounts(line.accountCode), debit: line.debit, credit: line.credit })),
	};
}
