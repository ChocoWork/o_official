import type { BusinessType } from '@/lib/finance/accounts';
import { depreciationSchedule, type FixedAsset } from '@/lib/finance/depreciation';
import {
	buildDepreciationEntries,
	buildGeneralLedger,
	buildJournal,
	buildTrialBalance,
	type FinanceEntry,
} from '@/lib/finance/journal';
import { buildBalanceSheet } from '@/lib/finance/statements';
import {
	buildAllowanceEntries,
	buildClosingBalances,
	buildInventoryEntries,
	EMPTY_YEAR_END_ADJUSTMENT,
	verifyOpeningBalances,
	type YearEndAdjustment,
} from '@/lib/finance/year-end';

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

/** 画面と同じ導出経路で1年度分を閉める。 */
function closeYear(options: {
	fiscalYear: number;
	entries: FinanceEntry[];
	opening?: Map<string, number>;
	assets?: FixedAsset[];
	adjustment?: YearEndAdjustment;
	businessType?: BusinessType;
}) {
	const {
		fiscalYear,
		entries,
		opening = new Map<string, number>(),
		assets = [],
		adjustment = EMPTY_YEAR_END_ADJUSTMENT,
		businessType = 'soleProprietor',
	} = options;

	const depreciation = depreciationSchedule(assets, fiscalYear);
	const journal = [
		...buildJournal(entries, businessType),
		...buildDepreciationEntries(depreciation.rows, fiscalYear),
		...buildInventoryEntries(adjustment, opening, fiscalYear),
		...buildAllowanceEntries(adjustment, fiscalYear),
	];
	const ledger = buildGeneralLedger(journal, opening);
	const trial = buildTrialBalance(ledger);
	const bs = buildBalanceSheet(trial);
	const closing = buildClosingBalances(trial, businessType);
	return { trial, bs, closing, ledger };
}

describe('buildInventoryEntries（三分法の棚卸振替）', () => {
	it('期首在庫を費用へ振替し、期末在庫を資産へ計上する', () => {
		const journal = buildInventoryEntries(
			{ ...EMPTY_YEAR_END_ADJUSTMENT, closingInventoryGoods: 180_000 },
			new Map([['1310', 120_000]]),
			2026,
		);

		expect(journal).toHaveLength(2);
		expect(journal[0].lines[0].account.name).toBe('期首商品棚卸高');
		expect(journal[0].lines[1].account.name).toBe('商品');
		expect(journal[0].lines[0].debit).toBe(120_000);

		expect(journal[1].lines[0].account.name).toBe('商品');
		expect(journal[1].lines[1].account.name).toBe('期末商品棚卸高');
		expect(journal[1].lines[0].debit).toBe(180_000);
	});

	it('棚卸後の商品勘定の残高が実地棚卸額に一致する', () => {
		const { ledger } = closeYear({
			fiscalYear: 2026,
			entries: [entry({ id: 1, amount: 500_000, category: '仕入高', paymentMethod: '買掛金' })],
			opening: new Map([
				['1310', 120_000],
				['2910', 120_000],
			]),
			adjustment: { ...EMPTY_YEAR_END_ADJUSTMENT, closingInventoryGoods: 180_000 },
		});

		const goods = ledger.find((row) => row.account.code === '1310');
		expect(goods?.closingBalance).toBe(180_000);
	});

	it('期首・期末いずれも0なら仕訳を作らない', () => {
		expect(buildInventoryEntries(EMPTY_YEAR_END_ADJUSTMENT, new Map(), 2026)).toHaveLength(0);
	});

	it('材料も同様に振替する', () => {
		const journal = buildInventoryEntries(
			{ ...EMPTY_YEAR_END_ADJUSTMENT, closingInventoryMaterials: 60_000 },
			new Map([['1330', 40_000]]),
			2026,
		);
		expect(journal.map((row) => row.lines[0].account.name)).toEqual(['期首材料棚卸高', '材料']);
	});
});

describe('buildAllowanceEntries', () => {
	it('貸倒引当金繰入を計上する', () => {
		const journal = buildAllowanceEntries(
			{ ...EMPTY_YEAR_END_ADJUSTMENT, allowanceForDoubtful: 30_000 },
			2026,
		);
		expect(journal[0].lines[0].account.name).toBe('貸倒引当金繰入');
		expect(journal[0].lines[1].account.name).toBe('貸倒引当金');
		expect(journal[0].lines[0].debit).toBe(30_000);
	});

	it('0円なら仕訳を作らない', () => {
		expect(buildAllowanceEntries(EMPTY_YEAR_END_ADJUSTMENT, 2026)).toHaveLength(0);
	});
});

describe('buildClosingBalances（決算振替）', () => {
	it('個人事業主は元入金へ振り替え、事業主貸借を0にする', () => {
		const { closing } = closeYear({
			fiscalYear: 2026,
			entries: [
				entry({ id: 1, amount: 900_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 200_000, category: '仕入高', paymentMethod: '銀行' }),
				// 経費を私費で支払った → 事業主借 50,000
				entry({ id: 3, amount: 50_000, category: '消耗品費', paymentMethod: 'プライベート' }),
				// 売上を個人口座で受け取った → 事業主貸 300,000
				entry({ id: 4, amount: 300_000, entryType: 'income', category: '売上高', paymentMethod: 'プライベート' }),
			],
			opening: new Map([['2910', 100_000]]),
		});

		// 損益科目は繰り越さない
		expect(closing.has('4010')).toBe(false);
		expect(closing.has('6120')).toBe(false);
		// 事業主貸・事業主借は0になる
		expect(closing.has('1910')).toBe(false);
		expect(closing.has('2920')).toBe(false);
		// 当期純利益 = 売上(900,000+300,000) − 仕入200,000 − 消耗品50,000 = 950,000
		// 元入金 = 100,000 + 950,000 + 事業主借50,000 − 事業主貸300,000
		expect(closing.get('2910')).toBe(100_000 + 950_000 + 50_000 - 300_000);
	});

	it('法人は繰越利益剰余金へ振り替える', () => {
		const { closing } = closeYear({
			fiscalYear: 2026,
			businessType: 'corporation',
			entries: [
				entry({ id: 1, amount: 500_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
				entry({ id: 2, amount: 120_000, category: '役員報酬', paymentMethod: '銀行' }),
			],
			opening: new Map([
				['3010', 1_000_000],
				['1040', 1_000_000],
			]),
		});

		expect(closing.get('3010')).toBe(1_000_000);
		expect(closing.get('3040')).toBe(380_000);
	});

	it('資産・負債はそのまま繰り越す', () => {
		const { closing } = closeYear({
			fiscalYear: 2026,
			entries: [
				entry({ id: 1, amount: 300_000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
				entry({ id: 2, amount: 120_000, category: '仕入高', paymentMethod: '買掛金' }),
			],
		});
		// 売掛金(1120) / 買掛金(2020)
		expect(closing.get('1120')).toBe(300_000);
		expect(closing.get('2020')).toBe(120_000);
	});
});

describe('翌年期首BS = 当年期末BS（verify）', () => {
	const assets: FixedAsset[] = [
		{
			id: 1, name: 'ミシン', account: '工具器具備品', acquiredOn: '2026-01-10',
			acquisitionCost: 600_000, usefulLife: 6, method: 'straightLine',
			businessUseRatio: 100, disposedOn: null, memo: '',
		},
	];

	const year2026 = {
		fiscalYear: 2026,
		entries: [
			entry({ id: 1, amount: 2_000_000, entryType: 'income', category: '事業主借', paymentMethod: '銀行' }),
			entry({ id: 2, amount: 600_000, category: '工具器具備品', paymentMethod: '銀行' }),
			entry({ id: 3, amount: 800_000, category: '仕入高', paymentMethod: '買掛金' }),
			entry({ id: 4, amount: 1_500_000, entryType: 'income', category: '売上高', paymentMethod: '売掛金' }),
			entry({ id: 5, amount: 1_000_000, entryType: 'income', category: '売掛金', paymentMethod: '銀行' }),
			entry({ id: 6, amount: 120_000, category: '地代家賃', paymentMethod: '銀行' }),
			entry({ id: 7, amount: 45_000, category: '消耗品費', paymentMethod: 'プライベート' }),
		],
		assets,
		adjustment: {
			closingInventoryGoods: 200_000,
			closingInventoryMaterials: 50_000,
			allowanceForDoubtful: 10_000,
		},
	};

	it('当年度の貸借が一致する', () => {
		const { trial, bs } = closeYear(year2026);
		expect(trial.isBalanced).toBe(true);
		expect(bs.isBalanced).toBe(true);
	});

	it('期末スナップショットの貸借が一致する', () => {
		const { closing } = closeYear(year2026);
		const check = verifyOpeningBalances(closing);
		expect(check.isBalanced).toBe(true);
		expect(check.debitTotal).toBe(check.creditTotal);
	});

	it('翌年度を期首0取引で開いても貸借が一致する', () => {
		const { closing } = closeYear(year2026);
		const next = closeYear({ fiscalYear: 2027, entries: [], opening: closing, assets });
		expect(next.trial.isBalanced).toBe(true);
		expect(next.bs.isBalanced).toBe(true);
	});

	it('翌年度の期首資産合計が当年度の期末資産合計と一致する（事業主貸を除く）', () => {
		const { bs: closingBs, closing } = closeYear(year2026);
		const next = closeYear({ fiscalYear: 2027, entries: [], opening: closing, assets });

		// 当年度の期末資産から事業主貸を除いた額
		const ownerDraw = closingBs.assetSections
			.flatMap((section) => section.lines)
			.filter((line) => line.account.code === '1910')
			.reduce((sum, line) => sum + line.amount, 0);
		const assetsExOwnerDraw = closingBs.assetTotal - ownerDraw;

		// 翌年度は減価償却が進むので、期首時点の資産（＝当年度期末）と比較するため
		// 翌年度の期首残高から直接検算する。
		const openingAssetTotal = [...closing.entries()]
			.filter(([code]) => code.startsWith('1'))
			.reduce((sum, [, amount]) => sum + amount, 0);

		expect(openingAssetTotal).toBe(assetsExOwnerDraw);
		expect(next.bs.isBalanced).toBe(true);
	});

	it('翌年度の期首棚卸が当年度の期末棚卸と一致する', () => {
		const { closing } = closeYear(year2026);
		expect(closing.get('1310')).toBe(200_000);
		expect(closing.get('1330')).toBe(50_000);
	});

	it('3年連続で締めても毎年貸借が一致する', () => {
		let opening = new Map<string, number>();
		for (const fiscalYear of [2026, 2027, 2028]) {
			const result = closeYear({
				fiscalYear,
				entries: [
					entry({ id: 1, date: `${fiscalYear}-05-01`, amount: 900_000, entryType: 'income', category: '売上高', paymentMethod: '銀行' }),
					entry({ id: 2, date: `${fiscalYear}-06-01`, amount: 300_000, category: '仕入高', paymentMethod: '銀行' }),
				],
				opening,
				assets,
				adjustment: { ...EMPTY_YEAR_END_ADJUSTMENT, closingInventoryGoods: 100_000 },
			});
			expect(result.trial.isBalanced).toBe(true);
			expect(result.bs.isBalanced).toBe(true);
			expect(verifyOpeningBalances(result.closing).isBalanced).toBe(true);
			opening = result.closing;
		}
		// 3年目終了時点の元入金には3年分の利益が累積している
		expect(opening.get('2910')).toBeGreaterThan(0);
	});
});
