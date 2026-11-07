import { ACCOUNTS, accountByCode, resolveAccount, type Account } from '@/lib/finance/accounts';
import {
	ACCOUNTING_SUB_ACCOUNTS,
	savedEntryToJournalEntry,
	type SavedJournalEntry,
} from '@/lib/accounting/journal-types';
import { buildAccountsSeedRows, buildAccountsSeedSql } from '@/../scripts/accounting/emit-accounts-seed';

function lookup(code: string): Account {
	const account = accountByCode(code);
	if (!account) throw new Error(`unknown ${code}`);
	return account;
}

function saved(partial: Partial<SavedJournalEntry> = {}): SavedJournalEntry {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		periodId: '00000000-0000-4000-8000-000000000002',
		entryNo: 42,
		entryDate: '2026-08-15',
		eventKind: 'payment_confirmed',
		dedupeKey: 'payment_confirmed:pi_1',
		description: 'Stripe決済売上',
		recordedAt: '2026-08-15T01:00:00.000Z',
		recordedBy: null,
		isLate: false,
		reversesEntryId: null,
		reason: null,
		sourceTable: null,
		sourceId: null,
		migratedFrom: null,
		migratedAt: null,
		sourceRecordedAt: null,
		lines: [
			{ lineNo: 1, accountCode: '1130', debit: 10_000, credit: 0, subAccount: 'processor:stripe', counterparty: '顧客', orderId: 'order-1', memo: null },
			{ lineNo: 2, accountCode: '4010', debit: 0, credit: 10_000, subAccount: null, counterparty: '顧客', orderId: 'order-1', memo: null },
		],
		...partial,
	};
}

describe('FREQ-554-AC-06: 勘定の一覧は162件で1130と1150と4020の名前と区分が変わらず1160と4050が増える', () => {
	it('162件で既存の3件は変わらず2件が増える', () => {
		expect(ACCOUNTS).toHaveLength(162);
		expect(accountByCode('1130')).toEqual({ code: '1130', type: 'asset', normalSide: 'debit', name: 'クレジット売掛金', section: '売上債権', cashOut: true, cashIn: true, scope: 'common' });
		expect(accountByCode('1150')).toEqual({ code: '1150', type: 'asset', normalSide: 'debit', name: 'Stripe入金途上', section: 'その他流動資産', cashOut: false, cashIn: false, scope: 'common' });
		expect(accountByCode('4020')).toEqual({ code: '4020', type: 'revenue', normalSide: 'debit', name: '売上値引・返品', section: '売上（収入）金額', cashOut: true, cashIn: false, scope: 'common' });
		expect(accountByCode('1160')).toEqual({ code: '1160', type: 'asset', normalSide: 'debit', name: 'Stripe未収金', section: 'その他流動資産', cashOut: false, cashIn: false, scope: 'common' });
		expect(accountByCode('4050')).toEqual({ code: '4050', type: 'revenue', normalSide: 'credit', name: '返品の手数料', section: '売上（収入）金額', cashOut: false, cashIn: false, scope: 'common' });
		expect(accountByCode('6320')?.name).toBe('寄附金');
		expect(accountByCode('9999')).toBeUndefined();
	});
});

describe('FREQ-554-AC-06: 勘定の符号は重ならず、補助の符号は存在する勘定を指す', () => {
	it('勘定の符号と名前は重ならない', () => {
		expect(new Set(ACCOUNTS.map((account) => account.code)).size).toBe(ACCOUNTS.length);
		expect(new Set(ACCOUNTS.map((account) => account.name)).size).toBe(ACCOUNTS.length);
	});

	it('補助の符号は決めた勘定を指し、その勘定は一覧にある', () => {
		expect(ACCOUNTING_SUB_ACCOUNTS).toEqual({
			return_refund: { accountCode: '2130' },
			dispute_pending: { accountCode: '1470' },
			processor: { accountCode: '1130' },
		});
		for (const { accountCode } of Object.values(ACCOUNTING_SUB_ACCOUNTS)) {
			expect(accountByCode(accountCode)).toBeDefined();
		}
	});
});

describe('FREQ-554-AC-06: 保存した仕訳を画面の仕訳の型へ直しても貸借と科目が変わらない', () => {
	it('貸借・科目・印・日付・説明を保ち、番号は期間の通し番号を使う', () => {
		const entry = savedEntryToJournalEntry(saved(), lookup);
		expect(entry).toEqual({
			entryId: -1,
			sourceKey: 'payment_confirmed:pi_1',
			number: 'JE-000042',
			date: '2026-08-15',
			description: 'Stripe決済売上',
			partner: '顧客',
			lines: [
				{ account: lookup('1130'), debit: 10_000, credit: 0 },
				{ account: lookup('4010'), debit: 0, credit: 10_000 },
			],
		});
	});

	it('行は行番号の順に並べる', () => {
		const base = saved();
		const entry = savedEntryToJournalEntry(saved({ lines: [base.lines[1], base.lines[0]] }), lookup);
		expect(entry.lines.map((line) => line.account.code)).toEqual(['1130', '4010']);
	});

	it('手入力の行の番号が分かるときだけ entryId を数値にする', () => {
		expect(savedEntryToJournalEntry(saved({ eventKind: 'manual_entry', dedupeKey: 'manual_entry:17:0' }), lookup).entryId).toBe(17);
		expect(savedEntryToJournalEntry(saved({ eventKind: 'migrated_entry', dedupeKey: 'migrated_entry:23' }), lookup).entryId).toBe(23);
		expect(savedEntryToJournalEntry(saved({ eventKind: 'manual_entry', dedupeKey: 'manual_entry:abc:0' }), lookup).entryId).toBe(-1);
	});

	it('取引先が無ければ空にし、未登録の科目は渡した関数に任せる', () => {
		const entry = savedEntryToJournalEntry(saved({
			lines: [
				{ lineNo: 1, accountCode: '9999', debit: 500, credit: 0, subAccount: null, counterparty: null, orderId: null, memo: null },
				{ lineNo: 2, accountCode: '1010', debit: 0, credit: 500, subAccount: null, counterparty: null, orderId: null, memo: null },
			],
		}), (code) => accountByCode(code) ?? resolveAccount('不明な科目'));
		expect(entry.partner).toBe('');
		expect(entry.lines[0].account.code).toBe('9999');
		expect(entry.lines[0].debit + entry.lines[1].debit).toBe(entry.lines[0].credit + entry.lines[1].credit);
	});
});

describe('勘定の種の出力', () => {
	it('163行（9999 を含む）を出し、繰り越しの役割を決める', () => {
		const rows = buildAccountsSeedRows();
		expect(rows).toHaveLength(163);
		expect(new Set(rows.map((row) => row.code)).size).toBe(163);
		const byCode = new Map(rows.map((row) => [row.code, row]));
		expect(byCode.get('9999')).toEqual({ code: '9999', accountType: 'expense', normalSide: 'debit', scope: 'common', carryoverRole: 'pl_zero' });
		expect(byCode.get('2910')?.carryoverRole).toBe('capital_sole');
		expect(byCode.get('1910')?.carryoverRole).toBe('owner_draw');
		expect(byCode.get('1920')?.carryoverRole).toBe('owner_draw');
		expect(byCode.get('2920')?.carryoverRole).toBe('owner_contribution');
		expect(byCode.get('3040')?.carryoverRole).toBe('retained_corp');
		expect(byCode.get('4010')?.carryoverRole).toBe('pl_zero');
		expect(byCode.get('5010')?.carryoverRole).toBe('pl_zero');
		expect(byCode.get('1130')?.carryoverRole).toBe('carry');
		expect(byCode.get('1160')).toEqual({ code: '1160', accountType: 'asset', normalSide: 'debit', scope: 'common', carryoverRole: 'carry' });
		expect(byCode.get('4050')).toEqual({ code: '4050', accountType: 'revenue', normalSide: 'credit', scope: 'common', carryoverRole: 'pl_zero' });
	});

	it('INSERT の本文を1行1勘定で出す', () => {
		const sql = buildAccountsSeedSql();
		const lines = sql.trimEnd().split('\n');
		expect(lines[0]).toBe('INSERT INTO public.accounting_accounts (code,account_type,normal_side,scope,carryover_role) VALUES');
		expect(lines).toHaveLength(164);
		expect(lines[1]).toBe("  ('1010','asset','debit','common','carry'),");
		expect(lines[163]).toBe("  ('9999','expense','debit','common','pl_zero');");
	});
});
