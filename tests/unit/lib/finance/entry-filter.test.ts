import {
	activeConditionCount,
	EMPTY_ENTRY_FILTER,
	filterEntries,
	isFilterActive,
	type EntryFilter,
} from '@/lib/finance/entry-filter';
import type { FinanceEntry } from '@/lib/finance/journal';

const ENTRIES: FinanceEntry[] = [
	{
		id: 1, entryType: 'expense', date: '2026-01-15', category: '広告宣伝費', item: '広告出稿',
		partner: 'A社', amount: 10000, paymentMethod: '現金', memo: '冬キャンペーン', seasonTag: null,
	},
	{
		id: 2, entryType: 'expense', date: '2026-03-31', category: '仕入高', item: '生地・材料仕入',
		partner: 'B社', amount: 90000, paymentMethod: '買掛金', memo: '', seasonTag: '2026SS',
	},
	{
		id: 3, entryType: 'expense', date: '2026-06-01', category: '通信費', item: 'システム・ツール利用料',
		partner: '', amount: 3300, paymentMethod: '銀行', memo: 'SaaS', seasonTag: null,
	},
	{
		id: 4, entryType: 'income', date: '2026-06-20', category: '売上高', item: 'オンライン販売',
		partner: '', amount: 120000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
	},
	{
		id: 5, entryType: 'income', date: '2026-12-31', category: '売上高', item: '卸売',
		partner: 'A社', amount: 250000, paymentMethod: '売掛金', memo: '年末締め', seasonTag: '2026AW',
	},
];

function withFilter(partial: Partial<EntryFilter>): EntryFilter {
	return { ...EMPTY_ENTRY_FILTER, ...partial };
}

function ids(entries: FinanceEntry[]): number[] {
	return entries.map((entry) => entry.id);
}

describe('filterEntries', () => {
	it('条件なしでは全件返す', () => {
		expect(ids(filterEntries(ENTRIES, EMPTY_ENTRY_FILTER))).toEqual([1, 2, 3, 4, 5]);
	});

	// 電帳法 要件1: 取引年月日で検索できる
	describe('要件1: 取引年月日・取引金額・取引先を条件にできる', () => {
		it('取引年月日で絞り込める', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ dateFrom: '2026-06-01', dateTo: '2026-06-01' })))).toEqual([3]);
		});

		it('取引金額で絞り込める', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ amountFrom: '120000', amountTo: '120000' })))).toEqual([4]);
		});

		it('取引先で絞り込める', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ partner: 'A社' })))).toEqual([1, 5]);
		});

		it('勘定科目で絞り込める', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ account: '売上高' })))).toEqual([4, 5]);
		});
	});

	// 電帳法 要件2: 日付・金額は範囲指定
	describe('要件2: 日付・金額は範囲を指定できる', () => {
		it('日付の範囲指定', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ dateFrom: '2026-03-01', dateTo: '2026-06-30' })))).toEqual([2, 3, 4]);
		});

		it('日付の片側だけの指定（以降）', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ dateFrom: '2026-06-20' })))).toEqual([4, 5]);
		});

		it('日付の片側だけの指定（以前）', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ dateTo: '2026-01-31' })))).toEqual([1]);
		});

		it('金額の範囲指定', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ amountFrom: '10000', amountTo: '120000' })))).toEqual([1, 2, 4]);
		});

		it('金額の片側だけの指定（以上）', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ amountFrom: '120000' })))).toEqual([4, 5]);
		});

		it('境界値を含む（以上・以下）', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ amountFrom: '3300', amountTo: '10000' })))).toEqual([1, 3]);
		});
	});

	// 電帳法 要件3: 2以上の記録項目の組み合わせ
	describe('要件3: 2以上の条件を組み合わせられる', () => {
		it('取引先 + 日付範囲', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ partner: 'A社', dateFrom: '2026-06-01' })))).toEqual([5]);
		});

		it('取引先 + 金額範囲', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ partner: 'A社', amountTo: '50000' })))).toEqual([1]);
		});

		it('日付範囲 + 金額範囲 + 勘定科目（3条件）', () => {
			expect(
				ids(
					filterEntries(
						ENTRIES,
						withFilter({ dateFrom: '2026-01-01', dateTo: '2026-12-31', amountFrom: '100000', account: '売上高' }),
					),
				),
			).toEqual([4, 5]);
		});

		it('該当なしの組み合わせは空になる', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ partner: 'B社', account: '売上高' })))).toEqual([]);
		});
	});

	describe('補助条件', () => {
		it('種別で絞り込める', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ entryType: 'income' })))).toEqual([4, 5]);
		});

		it('キーワードは概要・メモ・取引先を横断して部分一致する', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ keyword: 'キャンペーン' })))).toEqual([1]);
			expect(ids(filterEntries(ENTRIES, withFilter({ keyword: '仕入' })))).toEqual([2]);
			expect(ids(filterEntries(ENTRIES, withFilter({ keyword: 'b社' })))).toEqual([2]);
		});

		it('不正な金額入力は無制限として扱う', () => {
			expect(ids(filterEntries(ENTRIES, withFilter({ amountFrom: 'abc' })))).toEqual([1, 2, 3, 4, 5]);
		});
	});
});

describe('isFilterActive / activeConditionCount', () => {
	it('条件なしは非アクティブ', () => {
		expect(isFilterActive(EMPTY_ENTRY_FILTER)).toBe(false);
		expect(activeConditionCount(EMPTY_ENTRY_FILTER)).toBe(0);
	});

	it('条件数を数える', () => {
		const filter = withFilter({ partner: 'A社', dateFrom: '2026-01-01', amountTo: '50000' });
		expect(isFilterActive(filter)).toBe(true);
		expect(activeConditionCount(filter)).toBe(3);
	});
});
