export const PRODUCT_CATEGORIES = [
  'TOPS',
  'BOTTOMS',
  'OUTERWEAR',
  'ACCESSORIES',
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_COST_TYPES = [
  'material',
  'sewing',
  'pattern',
  'planning',
  'accessories',
  'processing',
  'inspection_finishing',
  'logistics',
  'advertising',
  'photography',
  'exhibition',
  'other',
] as const;

export type ProductCostType = (typeof PRODUCT_COST_TYPES)[number];
export type AllocationTargetType = 'item' | 'season_common';

export const PRODUCT_COST_TYPE_LABELS: Record<ProductCostType, string> = {
  material: '生地・材料費',
  sewing: '縫製費',
  pattern: 'パターン費',
  planning: '企画費',
  accessories: '付属品費',
  processing: '加工費',
  inspection_finishing: '検品・仕上げ費',
  logistics: '物流費',
  advertising: '広告費',
  photography: '撮影費',
  exhibition: '展示会費',
  other: 'その他',
};

export type CostingItem = {
  id: number;
  seasonKey: string;
  category: ProductCategory;
  provisionalName: string;
  plannedQuantity: number;
  sellingPrice: number;
  fabricMetersPerUnit: number;
  updatedAt: string;
};

export type CostAllocation = {
  id: number;
  expenseId: number;
  seasonKey: string;
  targetType: AllocationTargetType;
  itemId: number | null;
  costType: ProductCostType;
  otherLabel: string | null;
  amount: number;
};

export type AllocationDraftLine = Omit<CostAllocation, 'id' | 'expenseId' | 'seasonKey'>;

export type CostingExpense = {
  id: number;
  date: string;
  category: string;
  item: string;
  partner: string;
  amount: number;
  allocations: CostAllocation[];
  allocated: boolean;
};

export type ItemCostSummary = CostingItem & {
  directCost: number;
  unitCost: number | null;
  projectedSales: number;
  projectedProfit: number;
  unitProfit: number | null;
  profitMargin: number | null;
  requiredFabricMeters: number;
  costBreakdown: Record<ProductCostType, number>;
};

export type SeasonCostSummary = {
  projectedSales: number;
  directCost: number;
  commonCost: number;
  unallocatedCost: number;
  totalExpense: number;
  productGrossProfit: number;
  seasonProfit: number;
  seasonProfitMargin: number | null;
  costBreakdown: Record<ProductCostType, number>;
};

export type ProductCostingResponse = {
  data: {
    seasonKey: string;
    items: ItemCostSummary[];
    expenses: CostingExpense[];
    summary: SeasonCostSummary;
  };
};

export function emptyCostBreakdown(): Record<ProductCostType, number> {
  return Object.fromEntries(PRODUCT_COST_TYPES.map((type) => [type, 0])) as Record<ProductCostType, number>;
}

export function calculateProductCosting(
  items: CostingItem[],
  expenses: Array<Omit<CostingExpense, 'allocations' | 'allocated'>>,
  allocations: CostAllocation[],
): { items: ItemCostSummary[]; expenses: CostingExpense[]; summary: SeasonCostSummary } {
  const allocationsByExpense = new Map<number, CostAllocation[]>();
  const allocationsByItem = new Map<number, CostAllocation[]>();
  for (const allocation of allocations) {
    allocationsByExpense.set(allocation.expenseId, [
      ...(allocationsByExpense.get(allocation.expenseId) ?? []),
      allocation,
    ]);
    if (allocation.itemId !== null) {
      allocationsByItem.set(allocation.itemId, [
        ...(allocationsByItem.get(allocation.itemId) ?? []),
        allocation,
      ]);
    }
  }

  const itemSummaries = items.map((item): ItemCostSummary => {
    const itemAllocations = allocationsByItem.get(item.id) ?? [];
    const costBreakdown = emptyCostBreakdown();
    for (const allocation of itemAllocations) costBreakdown[allocation.costType] += allocation.amount;
    const directCost = itemAllocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    const projectedSales = item.sellingPrice * item.plannedQuantity;
    const projectedProfit = projectedSales - directCost;
    return {
      ...item,
      directCost,
      unitCost: item.plannedQuantity > 0 ? directCost / item.plannedQuantity : null,
      projectedSales,
      projectedProfit,
      unitProfit: item.plannedQuantity > 0 ? item.sellingPrice - directCost / item.plannedQuantity : null,
      profitMargin: projectedSales > 0 ? (projectedProfit / projectedSales) * 100 : null,
      requiredFabricMeters: item.fabricMetersPerUnit * item.plannedQuantity,
      costBreakdown,
    };
  });

  const expenseSummaries = expenses.map((expense): CostingExpense => {
    const expenseAllocations = allocationsByExpense.get(expense.id) ?? [];
    return { ...expense, allocations: expenseAllocations, allocated: expenseAllocations.length > 0 };
  });
  const projectedSales = itemSummaries.reduce((sum, item) => sum + item.projectedSales, 0);
  const directCost = allocations
    .filter((allocation) => allocation.targetType === 'item')
    .reduce((sum, allocation) => sum + allocation.amount, 0);
  const commonCost = allocations
    .filter((allocation) => allocation.targetType === 'season_common')
    .reduce((sum, allocation) => sum + allocation.amount, 0);
  const unallocatedCost = expenseSummaries
    .filter((expense) => !expense.allocated)
    .reduce((sum, expense) => sum + expense.amount, 0);
  const totalExpense = expenseSummaries.reduce((sum, expense) => sum + expense.amount, 0);
  const costBreakdown = emptyCostBreakdown();
  for (const allocation of allocations) costBreakdown[allocation.costType] += allocation.amount;
  const productGrossProfit = projectedSales - directCost;
  const seasonProfit = projectedSales - totalExpense;

  return {
    items: itemSummaries,
    expenses: expenseSummaries,
    summary: {
      projectedSales,
      directCost,
      commonCost,
      unallocatedCost,
      totalExpense,
      productGrossProfit,
      seasonProfit,
      seasonProfitMargin: projectedSales > 0 ? (seasonProfit / projectedSales) * 100 : null,
      costBreakdown,
    },
  };
}
