import {
  calculateProductCosting,
  type CostAllocation,
  type CostingItem,
} from '@/lib/finance/product-costing';

const items: CostingItem[] = [
  {
    id: 1,
    seasonKey: '2026AW',
    category: 'TOPS',
    provisionalName: 'ウールシャツ',
    plannedQuantity: 10,
    sellingPrice: 20_000,
    fabricMetersPerUnit: 1.25,
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 2,
    seasonKey: '2026AW',
    category: 'BOTTOMS',
    provisionalName: '試作パンツ',
    plannedQuantity: 0,
    sellingPrice: 30_000,
    fabricMetersPerUnit: 1.8,
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

const expenses = [
  { id: 101, date: '2026-08-01', category: '仕入', item: '生産費', partner: '縫製会社', amount: 80_000 },
  { id: 102, date: '2026-08-02', category: '企画', item: '撮影費', partner: 'スタジオ', amount: 20_000 },
  { id: 103, date: '2026-08-03', category: '物流', item: '運送費', partner: '運送会社', amount: 5_000 },
];

const allocations: CostAllocation[] = [
  { id: 1, expenseId: 101, seasonKey: '2026AW', targetType: 'item', itemId: 1, costType: 'sewing', otherLabel: null, amount: 50_000 },
  { id: 2, expenseId: 101, seasonKey: '2026AW', targetType: 'item', itemId: 2, costType: 'pattern', otherLabel: null, amount: 10_000 },
  { id: 3, expenseId: 101, seasonKey: '2026AW', targetType: 'season_common', itemId: null, costType: 'planning', otherLabel: null, amount: 20_000 },
  { id: 4, expenseId: 102, seasonKey: '2026AW', targetType: 'season_common', itemId: null, costType: 'photography', otherLabel: null, amount: 20_000 },
];

describe('calculateProductCosting', () => {
  it('商品直接原価とシーズン共通費を混在させず集計する', () => {
    const result = calculateProductCosting(items, expenses, allocations);

    expect(result.items[0]).toMatchObject({
      directCost: 50_000,
      unitCost: 5_000,
      projectedSales: 200_000,
      projectedProfit: 150_000,
      unitProfit: 15_000,
      requiredFabricMeters: 12.5,
    });
    expect(result.items[0].costBreakdown.planning).toBe(0);
    expect(result.items[1]).toMatchObject({
      directCost: 10_000,
      unitCost: null,
      unitProfit: null,
      projectedSales: 0,
      profitMargin: null,
      requiredFabricMeters: 0,
    });
    expect(result.summary).toMatchObject({
      projectedSales: 200_000,
      directCost: 60_000,
      commonCost: 40_000,
      unallocatedCost: 5_000,
      totalExpense: 105_000,
      productGrossProfit: 140_000,
      seasonProfit: 95_000,
      seasonProfitMargin: 47.5,
    });
    expect(result.expenses.map((expense) => expense.allocated)).toEqual([true, true, false]);
  });

  it('売上が0円ならシーズン利益率を未入力扱いにする', () => {
    const result = calculateProductCosting(
      [{ ...items[0], plannedQuantity: 0, sellingPrice: 0 }],
      [expenses[2]],
      [],
    );

    expect(result.summary.seasonProfit).toBe(-5_000);
    expect(result.summary.seasonProfitMargin).toBeNull();
  });
});
