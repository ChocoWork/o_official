import { accountByName } from '@/lib/finance/accounts';
import { buildCashFlow } from '@/lib/finance/cash-flow';
import { buildGeneralLedger, buildJournal, type FinanceEntry } from '@/lib/finance/journal';

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

function cashFlowOf(entries: FinanceEntry[], opening = new Map<string, number>()) {
	const ledger = buildGeneralLedger(buildJournal(entries, 'soleProprietor'), opening);
	return buildCashFlow(ledger, accountByName);
}

describe('buildCashFlow（直接法）', () => {
	it('売上入金は営業活動、経費支払も営業活動', () => {
		const flow = cashFlowOf([
			entry({ id: 1, amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
			entry({ id: 2, amount: 80_000, category: '広告宣伝費', paymentMethod: '銀行' }),
		]);
		expect(flow.operating).toBe(420_000);
		expect(flow.investing).toBe(0);
		expect(flow.financing).toBe(0);
	});

	it('固定資産の取得は投資活動', () => {
		const flow = cashFlowOf([
			entry({ id: 1, amount: 600_000, category: '工具器具備品', paymentMethod: '銀行' }),
		]);
		expect(flow.investing).toBe(-600_000);
		expect(flow.operating).toBe(0);
	});

	it('借入は財務活動', () => {
		const flow = cashFlowOf([
			entry({ id: 1, amount: 1_000_000, entryType: 'income', category: '短期借入金', paymentMethod: '銀行' }),
			entry({ id: 2, amount: 100_000, category: '短期借入金', paymentMethod: '銀行' }),
		]);
		expect(flow.financing).toBe(900_000);
	});

	it('事業主との資金移動は財務活動', () => {
		const flow = cashFlowOf([
			entry({ id: 1, amount: 300_000, entryType: 'income', category: '事業主借', paymentMethod: '銀行' }),
		]);
		expect(flow.financing).toBe(300_000);
	});

	it('現金と預金の間の振替は資金総額を動かさないので計上しない', () => {
		const flow = cashFlowOf([
			// 現金を普通預金へ預け入れ（出金方法=現金、勘定科目=普通預金）
			entry({ id: 1, amount: 200_000, category: '普通預金', paymentMethod: '現金' }),
		]);
		expect(flow.operating).toBe(0);
		expect(flow.investing).toBe(0);
		expect(flow.financing).toBe(0);
		expect(flow.lines).toHaveLength(0);
	});

	// verify: 期首 + 増減 = 期末（直接法なので誤差0）
	it('期首＋増減が期末残高と一致する', () => {
		const flow = cashFlowOf(
			[
				entry({ id: 1, amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 600_000, category: '工具器具備品', paymentMethod: '銀行' }),
				entry({ id: 3, amount: 1_000_000, entryType: 'income', category: '短期借入金', paymentMethod: '銀行' }),
				entry({ id: 4, amount: 45_000, category: '通信費', paymentMethod: '現金' }),
			],
			new Map([['1010', 100_000]]),
		);

		expect(flow.difference).toBe(0);
		expect(
			flow.openingCash + flow.operating + flow.investing + flow.financing,
		).toBe(flow.closingCash);
		expect(flow.openingCash).toBe(100_000);
		expect(flow.closingCash).toBe(100_000 + 500_000 - 600_000 + 1_000_000 - 45_000);
	});

	it('掛取引は入出金があった時点だけ計上する', () => {
		// 掛売上（売掛金）は資金が動かないので C/F に出ない
		const onCredit = cashFlowOf([
			entry({ id: 1, amount: 300_000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
		]);
		expect(onCredit.operating).toBe(0);
		expect(onCredit.closingCash).toBe(0);

		// 回収時に営業CFへ入る
		const collected = cashFlowOf([
			entry({ id: 1, amount: 300_000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
			entry({ id: 2, amount: 300_000, entryType: 'income', category: '売掛金', paymentMethod: '銀行' }),
		]);
		expect(collected.operating).toBe(300_000);
	});

	it('相手科目ごとに明細を集約する', () => {
		const flow = cashFlowOf([
			entry({ id: 1, amount: 30_000, category: '広告宣伝費', paymentMethod: '銀行' }),
			entry({ id: 2, amount: 20_000, category: '広告宣伝費', paymentMethod: '銀行' }),
			entry({ id: 3, amount: 5_000, category: '通信費', paymentMethod: '銀行' }),
		]);
		const ad = flow.lines.find((line) => line.account === '広告宣伝費');
		expect(ad?.amount).toBe(-50_000);
		expect(flow.lines).toHaveLength(2);
	});
});
