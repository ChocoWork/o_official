import { ACCOUNTS, accountByName } from '@/lib/finance/accounts';
import {
	EXPENSE_PAYMENT_METHODS,
	INCOME_PAYMENT_METHODS,
	paymentMethodAccountName,
} from '@/lib/finance/payment-methods';
import {
	buildGeneralLedger,
	buildJournal,
	buildTrialBalance,
	type FinanceEntry,
} from '@/lib/finance/journal';

function entry(partial: Partial<FinanceEntry> & Pick<FinanceEntry, 'id' | 'amount'>): FinanceEntry {
	return {
		entryType: 'expense',
		date: '2026-04-01',
		category: '広告宣伝費',
		item: '広告出稿',
		partner: '',
		paymentMethod: '現金',
		memo: '',
		seasonTag: null,
		...partial,
	};
}

describe('勘定科目マスタ', () => {
	it('159科目すべてに会計区分と貸借を持つ', () => {
		expect(ACCOUNTS).toHaveLength(159);
		for (const account of ACCOUNTS) {
			expect(['asset', 'liability', 'equity', 'revenue', 'expense']).toContain(account.type);
			expect(['debit', 'credit']).toContain(account.normalSide);
		}
	});

	it('評価性・控除性の科目は会計区分と貸借が逆になる', () => {
		// 減価償却累計額は資産だが貸方残（評価性引当）
		expect(accountByName('減価償却累計額')).toMatchObject({ type: 'asset', normalSide: 'credit' });
		// 売上値引・返品は収益だが借方残（控除性）
		expect(accountByName('売上値引・返品')).toMatchObject({ type: 'revenue', normalSide: 'debit' });
		// 仕入値引・返品は費用だが貸方残
		expect(accountByName('仕入値引・返品')).toMatchObject({ type: 'expense', normalSide: 'credit' });
	});
});

describe('buildJournal', () => {
	it('支出は相手科目を借方、資金科目を貸方に立てる', () => {
		const [journal] = buildJournal(
			[entry({ id: 1, amount: 30000, category: '広告宣伝費', paymentMethod: '現金' })],
			'soleProprietor',
		);
		expect(journal.lines[0]).toMatchObject({ debit: 30000, credit: 0 });
		expect(journal.lines[0].account.name).toBe('広告宣伝費');
		expect(journal.lines[1]).toMatchObject({ debit: 0, credit: 30000 });
		expect(journal.lines[1].account.name).toBe('現金');
	});

	it('収入は資金科目を借方、相手科目を貸方に立てる', () => {
		const [journal] = buildJournal(
			[entry({ id: 1, amount: 120000, entryType: 'income', category: '売上高', paymentMethod: '銀行' })],
			'soleProprietor',
		);
		// 「銀行」は普通預金へ変換される
		expect(journal.lines[0].account.name).toBe('普通預金');
		expect(journal.lines[0].debit).toBe(120000);
		expect(journal.lines[1].account.name).toBe('売上高');
		expect(journal.lines[1].credit).toBe(120000);
	});

	it('Stripe注文はクレジット売掛金を借方、売上高を貸方に立てる', () => {
		const [journal] = buildJournal(
			[entry({
				id: 1,
				amount: 59600,
				entryType: 'income',
				category: '売上高',
				item: 'オンライン注文',
				paymentMethod: 'Stripe',
			})],
			'soleProprietor',
		);

		expect(journal.lines[0]).toMatchObject({
			account: {
				code: '1130',
				name: 'クレジット売掛金',
				type: 'asset',
				normalSide: 'debit',
			},
			debit: 59600,
			credit: 0,
		});
		expect(journal.lines[1]).toMatchObject({
			account: { name: '売上高' },
			debit: 0,
			credit: 59600,
		});
		expect(journal.lines.some((line) => line.account.code === '9999')).toBe(false);
	});

	it('すべての入出金方法が登録済み勘定科目へ解決される', () => {
		const methods = [
			...EXPENSE_PAYMENT_METHODS.map((method) => ({ direction: 'expense' as const, method })),
			...INCOME_PAYMENT_METHODS.map((method) => ({ direction: 'income' as const, method })),
			{ direction: 'income' as const, method: 'Stripe' },
		];

		for (const { direction, method } of methods) {
			const accountName = paymentMethodAccountName(
				method,
				'soleProprietor',
				direction,
			);
			expect(accountByName(accountName)).toBeDefined();
		}
	});

	it('プライベートは事業形態と方向で振替先が変わる', () => {
		// 経費を私費で支払った → 事業が事業主から借りた（事業主借）
		const [soleExpense] = buildJournal(
			[entry({ id: 1, amount: 5000, paymentMethod: 'プライベート' })],
			'soleProprietor',
		);
		expect(soleExpense.lines[1].account.name).toBe('事業主借');

		// 売上を個人口座で受け取った → 事業が事業主へ貸した（事業主貸）
		const [soleIncome] = buildJournal(
			[entry({ id: 1, amount: 5000, entryType: 'income', category: '売上高', paymentMethod: 'プライベート' })],
			'soleProprietor',
		);
		expect(soleIncome.lines[0].account.name).toBe('事業主貸');

		const [corp] = buildJournal(
			[entry({ id: 1, amount: 5000, paymentMethod: 'プライベート' })],
			'corporation',
		);
		expect(corp.lines[1].account.name).toBe('役員借入金');
	});

	it('伝票番号は日付内の連番になる', () => {
		const journal = buildJournal(
			[
				entry({ id: 2, amount: 100, date: '2026-04-01' }),
				entry({ id: 1, amount: 200, date: '2026-04-01' }),
				entry({ id: 3, amount: 300, date: '2026-04-02' }),
			],
			'soleProprietor',
		);
		expect(journal.map((row) => row.number)).toEqual([
			'JE-20260401-001',
			'JE-20260401-002',
			'JE-20260402-001',
		]);
		// 同日は id 昇順
		expect(journal[0].entryId).toBe(1);
	});
});

describe('buildGeneralLedger', () => {
	it('科目ごとに残高を積み上げる（借方残の科目）', () => {
		const journal = buildJournal(
			[
				entry({ id: 1, amount: 10000, entryType: 'income', category: '売上高', paymentMethod: '現金' }),
				entry({ id: 2, amount: 3000, category: '通信費', paymentMethod: '現金' }),
			],
			'soleProprietor',
		);
		const ledger = buildGeneralLedger(journal);
		const cash = ledger.find((row) => row.account.name === '現金');

		expect(cash).toBeDefined();
		// 現金は借方残：入金10000 − 出金3000 = 7000
		expect(cash?.debitTotal).toBe(10000);
		expect(cash?.creditTotal).toBe(3000);
		expect(cash?.closingBalance).toBe(7000);
		expect(cash?.rows.at(-1)?.balance).toBe(7000);
	});

	it('貸方残の科目は入金側で残高が増える', () => {
		const journal = buildJournal(
			[entry({ id: 1, amount: 50000, entryType: 'income', category: '売上高', paymentMethod: '現金' })],
			'soleProprietor',
		);
		const ledger = buildGeneralLedger(journal);
		const sales = ledger.find((row) => row.account.name === '売上高');
		expect(sales?.closingBalance).toBe(50000);
	});

	it('相手科目を元帳に記録する', () => {
		const journal = buildJournal(
			[entry({ id: 1, amount: 3000, category: '通信費', paymentMethod: '銀行' })],
			'soleProprietor',
		);
		const ledger = buildGeneralLedger(journal);
		expect(ledger.find((row) => row.account.name === '通信費')?.rows[0].counterAccount).toBe('普通預金');
		expect(ledger.find((row) => row.account.name === '普通預金')?.rows[0].counterAccount).toBe('通信費');
	});

	it('期首残高を起点に残高を積む', () => {
		const journal = buildJournal(
			[entry({ id: 1, amount: 3000, category: '通信費', paymentMethod: '現金' })],
			'soleProprietor',
		);
		const opening = new Map([['1010', 100000]]);
		const ledger = buildGeneralLedger(journal, opening);
		const cash = ledger.find((row) => row.account.name === '現金');
		expect(cash?.openingBalance).toBe(100000);
		expect(cash?.closingBalance).toBe(97000);
	});
});

describe('buildTrialBalance（貸借一致の検証基盤）', () => {
	// verify: 全科目の借方合計 = 貸方合計
	const cases: Array<{ name: string; entries: FinanceEntry[] }> = [
		{
			name: '支出のみ',
			entries: [
				entry({ id: 1, amount: 30000, category: '広告宣伝費', paymentMethod: '現金' }),
				entry({ id: 2, amount: 12000, category: '通信費', paymentMethod: '銀行' }),
			],
		},
		{
			name: '収入のみ',
			entries: [
				entry({ id: 1, amount: 120000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 8000, entryType: 'income', category: '雑収入', paymentMethod: '現金' }),
			],
		},
		{
			name: '債権債務をまたぐ取引',
			entries: [
				// 掛売上 → 回収
				entry({ id: 1, amount: 200000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
				entry({ id: 2, amount: 200000, entryType: 'income', category: '売掛金', paymentMethod: '銀行' }),
				// 掛仕入 → 支払
				entry({ id: 3, amount: 90000, category: '仕入高', paymentMethod: '買掛金' }),
				entry({ id: 4, amount: 90000, category: '買掛金', paymentMethod: '銀行' }),
			],
		},
		{
			name: '控除性科目を含む',
			entries: [
				entry({ id: 1, amount: 5000, category: '売上値引・返品', paymentMethod: '現金' }),
				entry({ id: 2, amount: 3000, entryType: 'income', category: '仕入値引・返品', paymentMethod: '現金' }),
			],
		},
		{
			name: 'プライベート立替と固定資産取得',
			entries: [
				entry({ id: 1, amount: 45000, category: '工具器具備品', paymentMethod: 'プライベート' }),
				entry({ id: 2, amount: 1200, category: '消耗品費', paymentMethod: 'クレジットカード' }),
			],
		},
	];

	for (const testCase of cases) {
		it(`${testCase.name}：借方合計と貸方合計が一致する`, () => {
			const journal = buildJournal(testCase.entries, 'soleProprietor');
			const trial = buildTrialBalance(buildGeneralLedger(journal));

			expect(trial.debitTotal).toBe(trial.creditTotal);
			expect(trial.debitBalanceTotal).toBe(trial.creditBalanceTotal);
			expect(trial.difference).toBe(0);
			expect(trial.isBalanced).toBe(true);
		});
	}

	it('全取引の合計が仕訳金額の総和と一致する', () => {
		const entries = cases.flatMap((testCase, index) =>
			testCase.entries.map((row) => ({ ...row, id: index * 100 + row.id })),
		);
		const journal = buildJournal(entries, 'soleProprietor');
		const trial = buildTrialBalance(buildGeneralLedger(journal));
		const expected = entries.reduce((sum, row) => sum + row.amount, 0);

		expect(trial.debitTotal).toBe(expected);
		expect(trial.creditTotal).toBe(expected);
		expect(trial.isBalanced).toBe(true);
	});

	it('期首残高を含めても貸借が一致する', () => {
		const journal = buildJournal(
			[entry({ id: 1, amount: 30000, category: '広告宣伝費', paymentMethod: '現金' })],
			'soleProprietor',
		);
		// 現金100000（借方）／元入金100000（貸方）の期首。
		const opening = new Map([
			['1010', 100000],
			['2910', 100000],
		]);
		const ledger = buildGeneralLedger(journal, opening);
		const trial = buildTrialBalance(ledger);
		// 期首を含めた残高でも借方 = 貸方
		expect(trial.debitBalanceTotal).toBe(trial.creditBalanceTotal);
	});
});
