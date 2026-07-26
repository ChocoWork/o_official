import { depreciationSchedule, type FixedAsset } from '@/lib/finance/depreciation';
import {
	buildDepreciationEntries,
	buildGeneralLedger,
	buildJournal,
	buildTrialBalance,
	type FinanceEntry,
} from '@/lib/finance/journal';
import { buildBalanceSheet, buildProfitAndLoss } from '@/lib/finance/statements';

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

/** 取引・期首残高・固定資産から試算表を組む（画面と同じ導出経路）。 */
function buildStatements(options: {
	entries: FinanceEntry[];
	opening?: Map<string, number>;
	assets?: FixedAsset[];
	fiscalYear?: number;
}) {
	const fiscalYear = options.fiscalYear ?? 2026;
	const depreciation = depreciationSchedule(options.assets ?? [], fiscalYear);
	const journal = [
		...buildJournal(options.entries, 'soleProprietor'),
		...buildDepreciationEntries(depreciation.rows, fiscalYear),
	];
	const trial = buildTrialBalance(buildGeneralLedger(journal, options.opening ?? new Map()));
	return { trial, pl: buildProfitAndLoss(trial), bs: buildBalanceSheet(trial), depreciation };
}

describe('buildProfitAndLoss', () => {
	it('売上・仕入・経費から売上総利益と営業利益を出す', () => {
		const { pl } = buildStatements({
			entries: [
				entry({ id: 1, amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 200_000, category: '仕入高', paymentMethod: '買掛金' }),
				entry({ id: 3, amount: 80_000, category: '広告宣伝費', paymentMethod: '現金' }),
				entry({ id: 4, amount: 12_000, category: '通信費', paymentMethod: '銀行' }),
			],
		});

		expect(pl.sales).toBe(500_000);
		expect(pl.purchases).toBe(200_000);
		expect(pl.costOfSales).toBe(200_000);
		expect(pl.grossProfit).toBe(300_000);
		expect(pl.operatingExpenses).toBe(92_000);
		expect(pl.operatingProfit).toBe(208_000);
		expect(pl.netIncome).toBe(208_000);
	});

	it('売上値引・返品を売上から控除する', () => {
		const { pl } = buildStatements({
			entries: [
				entry({ id: 1, amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 30_000, category: '売上値引・返品', paymentMethod: '現金' }),
			],
		});
		// 控除性科目なので売上（収入）金額から自動的に差し引かれる
		expect(pl.sales).toBe(470_000);
	});

	it('仕入値引・返品を当期仕入高から控除する', () => {
		const { pl } = buildStatements({
			entries: [
				entry({ id: 1, amount: 200_000, category: '仕入高', paymentMethod: '買掛金' }),
				entry({ id: 2, amount: 20_000, entryType: 'income', category: '仕入値引・返品', paymentMethod: '現金' }),
			],
		});
		expect(pl.purchases).toBe(180_000);
	});

	it('雑収入を売上（収入）金額に含める', () => {
		const { pl } = buildStatements({
			entries: [
				entry({ id: 1, amount: 100_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 5_000, entryType: 'income', category: '雑収入', paymentMethod: '現金' }),
			],
		});
		expect(pl.sales).toBe(105_000);
	});

	it('決算書区分ごとに明細を並べる', () => {
		const { pl } = buildStatements({
			entries: [
				entry({ id: 1, amount: 100_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 50_000, category: '仕入高', paymentMethod: '買掛金' }),
				entry({ id: 3, amount: 8_000, category: '通信費', paymentMethod: '銀行' }),
			],
		});
		// 決算書の並び順（売上 → 仕入 → 経費）
		expect(pl.sections.map((section) => section.section)).toEqual([
			'売上（収入）金額',
			'当期仕入高',
			'経費',
		]);
		expect(pl.sections.at(-1)?.total).toBe(8_000);
	});

	it('残高0の科目は決算書に出さない', () => {
		const { pl } = buildStatements({
			entries: [
				// 掛売上をそのまま回収 → 売掛金の残高は0
				entry({ id: 1, amount: 100_000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
				entry({ id: 2, amount: 100_000, entryType: 'income', category: '売掛金', paymentMethod: '銀行' }),
			],
		});
		expect(pl.sections.flatMap((s) => s.lines).map((l) => l.account.name)).not.toContain('売掛金');
	});
});

describe('buildBalanceSheet', () => {
	// verify: 資産 = 負債 + 純資産（当期純利益を含む）
	it('資産合計と負債・純資産合計が一致する（現金取引のみ）', () => {
		const { bs } = buildStatements({
			entries: [
				entry({ id: 1, amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 80_000, category: '広告宣伝費', paymentMethod: '現金' }),
			],
		});
		expect(bs.isBalanced).toBe(true);
		expect(bs.difference).toBe(0);
		expect(bs.assetTotal).toBe(bs.liabilityAndEquityTotal);
	});

	it('債権債務と期首残高を含めても一致する', () => {
		const { bs } = buildStatements({
			entries: [
				entry({ id: 1, amount: 300_000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
				entry({ id: 2, amount: 120_000, category: '仕入高', paymentMethod: '買掛金' }),
				entry({ id: 3, amount: 45_000, category: '工具器具備品', paymentMethod: '銀行' }),
				entry({ id: 4, amount: 15_000, category: '消耗品費', paymentMethod: 'プライベート' }),
			],
			// 期首：現金 200,000（借方）／元入金 200,000（貸方）
			opening: new Map([
				['1010', 200_000],
				['2910', 200_000],
			]),
		});

		expect(bs.isBalanced).toBe(true);
		// 元入金200,000 ＋ 私費立替15,000（事業主借）
		expect(bs.equityTotal).toBe(215_000);
		// 当期純利益 = 売上300,000 − 仕入120,000 − 消耗品15,000
		expect(bs.netIncome).toBe(165_000);
	});

	it('減価償却の決算整理仕訳を含めても一致する', () => {
		const assets: FixedAsset[] = [
			{
				id: 1, name: 'ミシン', account: '工具器具備品', acquiredOn: '2026-01-01',
				acquisitionCost: 600_000, usefulLife: 6, method: 'straightLine',
				businessUseRatio: 100, disposedOn: null, memo: '',
			},
		];
		const { bs, pl } = buildStatements({
			entries: [
				entry({ id: 1, amount: 600_000, category: '工具器具備品', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 900_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
			],
			assets,
		});

		expect(bs.isBalanced).toBe(true);
		// 減価償却費 100,200 が経費に入る
		expect(pl.operatingExpenses).toBe(100_200);
		// 固定資産は直接法で減額 → 600,000 − 100,200 = 499,800
		const tools = bs.assetSections
			.flatMap((section) => section.lines)
			.find((line) => line.account.name === '工具器具備品');
		expect(tools?.amount).toBe(499_800);
	});

	it('家事按分ぶんは事業主貸へ振り替えても貸借が一致する', () => {
		const assets: FixedAsset[] = [
			{
				id: 1, name: '自宅兼用PC', account: '工具器具備品', acquiredOn: '2026-01-01',
				acquisitionCost: 240_000, usefulLife: 4, method: 'straightLine',
				businessUseRatio: 70, disposedOn: null, memo: '',
			},
		];
		const { bs, pl } = buildStatements({
			entries: [entry({ id: 1, amount: 240_000, category: '工具器具備品', paymentMethod: '銀行' })],
			assets,
		});

		expect(bs.isBalanced).toBe(true);
		// 償却費 60,000 のうち事業70% = 42,000 が経費、18,000 は事業主貸
		expect(pl.operatingExpenses).toBe(42_000);
		const owner = bs.assetSections
			.flatMap((section) => section.lines)
			.find((line) => line.account.name === '事業主貸');
		expect(owner?.amount).toBe(18_000);
	});

	it('資産・負債・純資産を決算書区分ごとに分類する', () => {
		const { bs } = buildStatements({
			entries: [
				entry({ id: 1, amount: 300_000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
				entry({ id: 2, amount: 120_000, category: '仕入高', paymentMethod: '買掛金' }),
			],
			opening: new Map([['2910', 100_000]]),
		});

		expect(bs.assetSections.map((s) => s.section)).toContain('売上債権');
		expect(bs.liabilitySections.map((s) => s.section)).toContain('仕入債務');
		expect(bs.equitySections.map((s) => s.section)).toContain('資本の部');
	});
});

describe('試算表とのクロスチェック', () => {
	it('借方残高合計 = 貸方残高合計 のとき必ず BS が一致する', () => {
		const { trial, bs } = buildStatements({
			entries: [
				entry({ id: 1, amount: 777_000, entryType: 'income', category: '売上高', paymentMethod: '受取手形' }),
				entry({ id: 2, amount: 333_333, category: '外注工賃', paymentMethod: '未払金' }),
				entry({ id: 3, amount: 1, category: '雑費', paymentMethod: '現金' }),
			],
		});
		expect(trial.isBalanced).toBe(true);
		expect(bs.isBalanced).toBe(true);
	});

	it('PL の当期純利益が BS の当期純利益と一致する', () => {
		const { pl, bs } = buildStatements({
			entries: [
				entry({ id: 1, amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 210_000, category: '仕入高', paymentMethod: '買掛金' }),
				entry({ id: 3, amount: 44_000, category: '地代家賃', paymentMethod: '銀行' }),
			],
		});
		expect(pl.netIncome).toBe(bs.netIncome);
		expect(pl.netIncome).toBe(246_000);
	});
});
