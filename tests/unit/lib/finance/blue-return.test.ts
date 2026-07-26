import {
	BLUE_RETURN_DEDUCTION_MAX,
	BLUE_RETURN_DEDUCTION_WITHOUT_ETAX,
	BREAKDOWN_ACCOUNT_CODES,
	buildBalanceSheetComparison,
	buildBlueReturnDeduction,
	buildMonthlySummary,
	buildPartnerBreakdown,
} from '@/lib/finance/blue-return';
import { buildJournal, type FinanceEntry } from '@/lib/finance/journal';

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

function journalOf(entries: FinanceEntry[]) {
	return buildJournal(entries, 'soleProprietor');
}

describe('buildMonthlySummary（2ページ 月別売上・仕入）', () => {
	it('売上と仕入を月別に集計する', () => {
		const summary = buildMonthlySummary(
			journalOf([
				entry({ id: 1, date: '2026-01-15', amount: 100_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, date: '2026-01-20', amount: 50_000, entryType: 'income', category: '売上高', paymentMethod: '現金' }),
				entry({ id: 3, date: '2026-06-01', amount: 300_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 4, date: '2026-02-10', amount: 80_000, category: '仕入高', paymentMethod: '買掛金' }),
			]),
			2026,
		);

		expect(summary.rows[0].sales).toBe(150_000);
		expect(summary.rows[5].sales).toBe(300_000);
		expect(summary.rows[1].purchases).toBe(80_000);
		expect(summary.salesTotal).toBe(450_000);
		expect(summary.purchasesTotal).toBe(80_000);
		expect(summary.rows).toHaveLength(12);
	});

	it('売上値引・返品は該当月の売上から差し引く', () => {
		const summary = buildMonthlySummary(
			journalOf([
				entry({ id: 1, date: '2026-03-01', amount: 200_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, date: '2026-03-20', amount: 30_000, category: '売上値引・返品', paymentMethod: '現金' }),
			]),
			2026,
		);
		expect(summary.rows[2].sales).toBe(170_000);
		expect(summary.salesTotal).toBe(170_000);
	});

	it('仕入値引・返品は該当月の仕入から差し引く', () => {
		const summary = buildMonthlySummary(
			journalOf([
				entry({ id: 1, date: '2026-05-01', amount: 100_000, category: '仕入高', paymentMethod: '買掛金' }),
				entry({ id: 2, date: '2026-05-15', amount: 20_000, entryType: 'income', category: '仕入値引・返品', paymentMethod: '現金' }),
			]),
			2026,
		);
		expect(summary.rows[4].purchases).toBe(80_000);
	});

	it('雑収入は月別欄と分けて集計する', () => {
		const summary = buildMonthlySummary(
			journalOf([
				entry({ id: 1, date: '2026-04-01', amount: 100_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, date: '2026-04-05', amount: 8_000, entryType: 'income', category: '雑収入', paymentMethod: '現金' }),
			]),
			2026,
		);
		expect(summary.rows[3].sales).toBe(100_000);
		expect(summary.miscIncome).toBe(8_000);
	});

	it('会計期間外の仕訳は集計しない', () => {
		const summary = buildMonthlySummary(
			journalOf([
				entry({ id: 1, date: '2026-12-31', amount: 100_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, date: '2027-01-05', amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
			]),
			2026,
		);
		expect(summary.salesTotal).toBe(100_000);
		expect(summary.rows[11].sales).toBe(100_000);
	});
});

describe('buildPartnerBreakdown（内訳欄）', () => {
	const journal = journalOf([
		entry({ id: 1, amount: 250_000, category: '給料賃金', partner: '山田太郎', paymentMethod: '銀行' }),
		entry({ id: 2, amount: 250_000, category: '給料賃金', partner: '山田太郎', paymentMethod: '銀行' }),
		entry({ id: 3, amount: 180_000, category: '給料賃金', partner: '佐藤花子', paymentMethod: '銀行' }),
		entry({ id: 4, amount: 96_000, category: '地代家賃', partner: '大家不動産', paymentMethod: '銀行' }),
		entry({ id: 5, amount: 60_000, category: '支払報酬', partner: '', paymentMethod: '銀行' }),
	]);

	it('給料賃金を支払先別に集計し金額降順で並べる', () => {
		const rows = buildPartnerBreakdown(journal, BREAKDOWN_ACCOUNT_CODES.wages);
		expect(rows).toEqual([
			{ partner: '山田太郎', amount: 500_000, count: 2 },
			{ partner: '佐藤花子', amount: 180_000, count: 1 },
		]);
	});

	it('地代家賃の内訳を集計する', () => {
		const rows = buildPartnerBreakdown(journal, BREAKDOWN_ACCOUNT_CODES.rent);
		expect(rows).toEqual([{ partner: '大家不動産', amount: 96_000, count: 1 }]);
	});

	it('取引先未入力は「（取引先未設定）」でまとめる', () => {
		const rows = buildPartnerBreakdown(journal, BREAKDOWN_ACCOUNT_CODES.professionalFees);
		expect(rows[0].partner).toBe('（取引先未設定）');
		expect(rows[0].amount).toBe(60_000);
	});

	it('対象科目がなければ空を返す', () => {
		expect(buildPartnerBreakdown(journal, BREAKDOWN_ACCOUNT_CODES.familyWages)).toEqual([]);
	});
});

describe('buildBlueReturnDeduction（青色申告特別控除額の計算）', () => {
	it('e-Tax利用なら65万円が上限', () => {
		const result = buildBlueReturnDeduction(3_000_000, true);
		expect(result.limit).toBe(BLUE_RETURN_DEDUCTION_MAX);
		expect(result.deduction).toBe(650_000);
		expect(result.incomeAfterDeduction).toBe(2_350_000);
	});

	it('e-Tax未利用なら55万円が上限', () => {
		const result = buildBlueReturnDeduction(3_000_000, false);
		expect(result.limit).toBe(BLUE_RETURN_DEDUCTION_WITHOUT_ETAX);
		expect(result.deduction).toBe(550_000);
	});

	it('所得を超えて控除しない', () => {
		const result = buildBlueReturnDeduction(400_000, true);
		expect(result.deduction).toBe(400_000);
		expect(result.incomeAfterDeduction).toBe(0);
	});

	it('赤字なら控除は0', () => {
		const result = buildBlueReturnDeduction(-200_000, true);
		expect(result.deduction).toBe(0);
		expect(result.incomeAfterDeduction).toBe(-200_000);
	});
});

describe('buildBalanceSheetComparison（4ページ 貸借対照表）', () => {
	it('期首と期末の2時点を並べ、貸借の合計が一致する', () => {
		// 期首: 現金300,000 / 元入金300,000
		const opening = new Map([
			['1010', 300_000],
			['2910', 300_000],
		]);
		// 期末: 現金500,000 + 売掛金200,000 / 買掛金100,000 + 元入金600,000
		const closing = new Map([
			['1010', 500_000],
			['1120', 200_000],
			['2020', 100_000],
			['2910', 600_000],
		]);

		const bs = buildBalanceSheetComparison(opening, closing);

		expect(bs.openingAssetTotal).toBe(300_000);
		expect(bs.openingLiabilityEquityTotal).toBe(300_000);
		expect(bs.closingAssetTotal).toBe(700_000);
		expect(bs.closingLiabilityEquityTotal).toBe(700_000);
	});

	it('期首・期末どちらかにだけある科目も行として出す', () => {
		const bs = buildBalanceSheetComparison(
			new Map([['1010', 100_000]]),
			new Map([['1120', 50_000]]),
		);
		expect(bs.assets.map((row) => row.code)).toEqual(['1010', '1120']);
		expect(bs.assets[0]).toMatchObject({ opening: 100_000, closing: 0 });
		expect(bs.assets[1]).toMatchObject({ opening: 0, closing: 50_000 });
	});

	it('両方0の科目は出さない', () => {
		const bs = buildBalanceSheetComparison(new Map([['1010', 0]]), new Map([['1010', 0]]));
		expect(bs.assets).toHaveLength(0);
	});

	it('評価性科目（減価償却累計額）は資産のマイナスとして扱う', () => {
		const bs = buildBalanceSheetComparison(
			new Map(),
			new Map([
				['1535', 600_000],
				['1590', 100_200],
			]),
		);
		const accumulated = bs.assets.find((row) => row.code === '1590');
		expect(accumulated?.closing).toBe(-100_200);
		expect(bs.closingAssetTotal).toBe(499_800);
	});
});
