import { expect, Page, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

function metric(period: string) {
  return {
    period, salesAmount: 0, formattedSales: '¥0', cvr: 0, formattedCvr: '0.0%',
    aov: 0, formattedAov: '¥0', setPurchaseRate: 0, formattedSetPurchaseRate: '0.0%',
    inventoryConsumptionRate: 0, formattedInventoryConsumptionRate: '0.0%', ltv: 0,
    formattedLtv: '¥0', repeatRate: 0, formattedRepeatRate: '0.0%', returnRate: 0,
    formattedReturnRate: '0.0%', orderCount: 0, paidOrderCount: 0, customerCount: 0,
    repeatCustomerCount: 0, setOrderCount: 0, cancelledOrderCount: 0,
    soldItemCount: 0, publishedItemCount: 0,
  };
}

async function mockApis(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: { id: 'admin', email: 'admin@example.com', role: 'admin', mfaVerified: true } }) }));
  await page.route('**/api/admin/kpi', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { targetYear: 2026, monthlyYearOptions: [2026], monthlyKpiByYear: [{ year: 2026, metrics: Array.from({ length: 12 }, (_, index) => metric(`${index + 1}月`)) }], seasonalKpi: [metric('2026SS')] } }) }));
  await page.route('**/api/admin/kpi/targets', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { currentSeason: '2026SS', seasons: ['2026SS'], definitions: [], values: {} } }) }));
  await page.route('**/api/admin/kpi/monthly-record**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { season: '2026SS', monthKeys: [], values: {} } }) }));
  await page.route('**/api/admin/kpi/cost-profit**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { fiscalYear: 2026, seasonKey: '2026SS', plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 }, expenses: [], incomes: [], products: [], partners: [], templates: [], fixedAssets: [], closing: { closingInventoryGoods: 0, closingInventoryMaterials: 0, allowanceForDoubtful: 0, closingBalances: {}, closedAt: null }, previousClosingBalances: null, revisions: [], cumulativeEntries: [] } }) }));
  await page.route('**/api/admin/accounting/product-costs**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
    seasonKey: '2026SS',
    items: [{ id: 1, seasonKey: '2026SS', category: 'TOPS', provisionalName: 'リネンシャツ', plannedQuantity: 10, sellingPrice: 20000, fabricMetersPerUnit: 1.25, updatedAt: '2026-08-01T00:00:00Z', directCost: 50000, unitCost: 5000, projectedSales: 200000, projectedProfit: 150000, unitProfit: 15000, profitMargin: 75, requiredFabricMeters: 12.5, costBreakdown: { material: 0, sewing: 50000, pattern: 0, planning: 0, accessories: 0, processing: 0, inspection_finishing: 0, logistics: 0, advertising: 0, photography: 0, exhibition: 0, other: 0 } }],
    expenses: [{ id: 10, date: '2026-06-01', category: '外注費', item: '縫製費', partner: '縫製会社', amount: 60000, allocations: [], allocated: false }],
    summary: { projectedSales: 200000, directCost: 50000, commonCost: 10000, unallocatedCost: 60000, totalExpense: 120000, productGrossProfit: 150000, seasonProfit: 80000, seasonProfitMargin: 40, costBreakdown: { material: 0, sewing: 50000, pattern: 0, planning: 10000, accessories: 0, processing: 0, inspection_finishing: 0, logistics: 0, advertising: 0, photography: 0, exhibition: 0, other: 0 } },
  } }) }));
}

for (const viewport of viewports) {
  test(`商品原価を安全に表示・配賦できる (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockApis(page);
    await page.goto('/admin');
    await page.getByRole('button', { name: 'ACCOUNTING' }).click();
    await page.getByRole('tab', { name: '商品原価', exact: true }).click();

    await expect(page.getByText('シーズン利益見込み', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: '支出配賦', exact: true }).click();
    await page.getByRole('button', { name: '配賦する', exact: true }).click();
    await expect(page.getByRole('button', { name: '原価配賦を確定', exact: true })).toBeDisabled();
    await page.locator('select').filter({ has: page.locator('option[value="1"]') }).selectOption('1');
    await expect(page.getByRole('button', { name: '原価配賦を確定', exact: true })).toBeEnabled();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
