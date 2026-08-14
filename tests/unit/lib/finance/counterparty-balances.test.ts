import { buildCounterpartyBalances } from '@/lib/finance/counterparty-balances';
import type { FinanceEntry } from '@/lib/finance/journal';

function entry(partial: Partial<FinanceEntry> & Pick<FinanceEntry, 'id' | 'amount'>): FinanceEntry {
	return { entryType: 'expense', date: '2026-04-01', category: '広告宣伝費', item: '取引', partner: '', paymentMethod: '銀行', memo: '', seasonTag: null, ...partial };
}

describe('buildCounterpartyBalances', () => {
	it('借入先別に累計借入、返済、返済残高を集計する', () => {
		const result = buildCounterpartyBalances([
			entry({ id: 1, amount: 1_000_000, date: '2025-03-01', entryType: 'income', category: '役員借入金', partner: '山田太郎' }),
			entry({ id: 2, amount: 300_000, date: '2026-08-01', category: '役員借入金', partner: '山田太郎' }),
		], 'corporation', '2026-12-31', new Map([['2120', 700_000]]));
		expect(result.funding.rows).toContainEqual({ counterparty: '山田太郎', accountCode: '2120', accountName: '役員借入金', received: 1_000_000, settled: 300_000, balance: 700_000, lastActivityDate: '2026-08-01', ownerFunding: false, unattributedOpening: false });
	});

	it('私費払いの返済残高を全期間の投入累計から引出済みを差し引いて算出する', () => {
		const result = buildCounterpartyBalances([
			entry({ id: 1, amount: 50_000, date: '2025-06-01', paymentMethod: 'プライベート', partner: '事業主' }),
			entry({ id: 2, amount: 20_000, date: '2026-06-01', paymentMethod: 'プライベート', partner: '事業主' }),
		], 'soleProprietor', '2026-12-31', new Map([['2920', 20_000]]));
		expect(result.funding.rows[0]).toMatchObject({ received: 70_000, settled: 0, balance: 70_000, ownerFunding: true });
		expect(result.funding.totals.balance).toBe(70_000);
		expect(result.funding.rows).not.toContainEqual(expect.objectContaining({ unattributedOpening: true }));
	});

	it('買掛金をその他の支払債務へ分離する', () => {
		const result = buildCounterpartyBalances([
			entry({ id: 1, amount: 120_000, category: '仕入高', paymentMethod: '買掛金', partner: '生地商店' }),
			entry({ id: 2, amount: 40_000, category: '買掛金', partner: '生地商店' }),
		], 'corporation', '2026-12-31', new Map([['2020', 80_000]]));
		expect(result.funding.rows).toHaveLength(0);
		expect(result.payables.rows[0]).toMatchObject({ counterparty: '生地商店', received: 120_000, settled: 40_000, balance: 80_000 });
	});

	it('その他の支払債務は帳簿との差額を相手先不明の繰越として残す', () => {
		const result = buildCounterpartyBalances([], 'corporation', '2026-12-31', new Map([['2020', 250_000]]));
		expect(result.payables.rows[0]).toMatchObject({ counterparty: '繰越・相手先未設定', balance: 250_000, unattributedOpening: true });
	});
});
