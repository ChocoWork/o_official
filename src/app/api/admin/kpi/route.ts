import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

type OrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled';
type PublishStatus = 'private' | 'published';

type OrderMetricRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  status: OrderStatus;
  total_amount: number;
  created_at: string;
};

type OrderItemMetricRow = {
  order_id: string;
  item_id: number;
  item_name: string;
  quantity: number;
  line_total: number;
  created_at: string;
};

type ItemMetricRow = {
  id: number;
  status: PublishStatus;
};

type OrderAggregation = {
  totalUnits: number;
  itemIds: number[];
};

type PeriodAccumulator = {
  allOrders: number;
  paidOrders: number;
  paidSales: number;
  setOrderCount: number;
  cancelledOrders: number;
  soldItemIds: Set<number>;
  customerOrderCount: Map<string, number>;
};

const SEASON_HISTORY_YEARS = 3;

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('ja-JP').format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function getJstDateParts(dateInput: Date | string): { year: string; month: string; day: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(new Date(dateInput));
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';

  return { year, month, day };
}

function getJstDayKey(dateInput: Date | string): string {
  const { year, month, day } = getJstDateParts(dateInput);
  return `${year}-${month}-${day}`;
}

function getJstMonthKey(dateInput: Date | string): string {
  const { year, month } = getJstDateParts(dateInput);
  return `${year}-${month}`;
}

function getJstYear(dateInput: Date | string): number {
  return Number.parseInt(getJstDateParts(dateInput).year, 10);
}

function getJstMonthNumber(dateInput: Date | string): number {
  return Number.parseInt(getJstDateParts(dateInput).month, 10);
}

function getSeasonKeyFromDate(dateInput: Date): string {
  const year = getJstYear(dateInput);
  const month = getJstMonthNumber(dateInput);

  if (month >= 4 && month <= 9) {
    return `${year}SS`;
  }

  if (month >= 10) {
    return `${year}AW`;
  }

  return `${year - 1}AW`;
}

function getPreviousSeasonKey(seasonKey: string): string {
  const matched = seasonKey.match(/^(\d{4})(SS|AW)$/);
  if (!matched) {
    return seasonKey;
  }

  const year = Number.parseInt(matched[1], 10);
  const seasonType = matched[2];

  if (seasonType === 'SS') {
    return `${year - 1}AW`;
  }

  return `${year}SS`;
}

function buildRecentSeasonKeys(currentSeasonKey: string, count: number): string[] {
  const keys: string[] = [];
  let cursor = currentSeasonKey;

  for (let index = 0; index < count; index += 1) {
    keys.push(cursor);
    cursor = getPreviousSeasonKey(cursor);
  }

  return keys;
}

function createMonthSeries(year: number): Array<{ key: string; label: string }> {
  return Array.from({ length: 12 }, (_, index) => {
    const monthNumber = index + 1;
    const key = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const label = `${monthNumber}月`;
    return { key, label };
  });
}

function createPeriodAccumulator(): PeriodAccumulator {
  return {
    allOrders: 0,
    paidOrders: 0,
    paidSales: 0,
    setOrderCount: 0,
    cancelledOrders: 0,
    soldItemIds: new Set<number>(),
    customerOrderCount: new Map<string, number>(),
  };
}

function getOrCreatePeriodAccumulator(map: Map<string, PeriodAccumulator>, key: string): PeriodAccumulator {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const created = createPeriodAccumulator();
  map.set(key, created);
  return created;
}

function resolveCustomerKey(order: Pick<OrderMetricRow, 'user_id' | 'session_id'>): string {
  if (order.user_id) {
    return `user:${order.user_id}`;
  }

  return `guest:${order.session_id}`;
}

function applyOrderToAccumulator(
  accumulator: PeriodAccumulator,
  order: OrderMetricRow,
  orderAggregation: OrderAggregation,
): void {
  accumulator.allOrders += 1;

  if (order.status === 'cancelled') {
    accumulator.cancelledOrders += 1;
  }

  if (order.status !== 'paid') {
    return;
  }

  accumulator.paidOrders += 1;
  accumulator.paidSales += order.total_amount;

  if (orderAggregation.totalUnits >= 2) {
    accumulator.setOrderCount += 1;
  }

  const customerKey = resolveCustomerKey(order);
  accumulator.customerOrderCount.set(customerKey, (accumulator.customerOrderCount.get(customerKey) ?? 0) + 1);

  for (const itemId of orderAggregation.itemIds) {
    accumulator.soldItemIds.add(itemId);
  }
}

function toKpiMetricsResponse(
  period: string,
  accumulator: PeriodAccumulator,
  publishedItemsCount: number,
): {
  period: string;
  salesAmount: number;
  formattedSales: string;
  cvr: number;
  formattedCvr: string;
  aov: number;
  formattedAov: string;
  setPurchaseRate: number;
  formattedSetPurchaseRate: string;
  inventoryConsumptionRate: number;
  formattedInventoryConsumptionRate: string;
  ltv: number;
  formattedLtv: string;
  repeatRate: number;
  formattedRepeatRate: string;
  returnRate: number;
  formattedReturnRate: string;
  orderCount: number;
  paidOrderCount: number;
  customerCount: number;
  repeatCustomerCount: number;
} {
  const cvr = accumulator.allOrders === 0 ? 0 : (accumulator.paidOrders / accumulator.allOrders) * 100;
  const aov = accumulator.paidOrders === 0 ? 0 : accumulator.paidSales / accumulator.paidOrders;
  const setPurchaseRate = accumulator.paidOrders === 0 ? 0 : (accumulator.setOrderCount / accumulator.paidOrders) * 100;
  const inventoryConsumptionRate =
    publishedItemsCount === 0 ? 0 : (accumulator.soldItemIds.size / publishedItemsCount) * 100;
  const customerCount = accumulator.customerOrderCount.size;
  const ltv = customerCount === 0 ? 0 : accumulator.paidSales / customerCount;

  let repeatCustomerCount = 0;
  for (const orderCount of accumulator.customerOrderCount.values()) {
    if (orderCount >= 2) {
      repeatCustomerCount += 1;
    }
  }

  const repeatRate = customerCount === 0 ? 0 : (repeatCustomerCount / customerCount) * 100;
  const returnRate = accumulator.allOrders === 0 ? 0 : (accumulator.cancelledOrders / accumulator.allOrders) * 100;

  return {
    period,
    salesAmount: accumulator.paidSales,
    formattedSales: formatCurrency(accumulator.paidSales),
    cvr,
    formattedCvr: formatPercent(cvr),
    aov,
    formattedAov: formatCurrency(Math.round(aov)),
    setPurchaseRate,
    formattedSetPurchaseRate: formatPercent(setPurchaseRate),
    inventoryConsumptionRate,
    formattedInventoryConsumptionRate: formatPercent(inventoryConsumptionRate),
    ltv,
    formattedLtv: formatCurrency(Math.round(ltv)),
    repeatRate,
    formattedRepeatRate: formatPercent(repeatRate),
    returnRate,
    formattedReturnRate: formatPercent(returnRate),
    orderCount: accumulator.allOrders,
    paidOrderCount: accumulator.paidOrders,
    customerCount,
    repeatCustomerCount,
  };
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.orders.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    if (authz.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const supabase = await createServiceRoleClient();
    const now = new Date();
    const targetYear = getJstYear(now);

    const [ordersResult, orderItemsResult, itemsResult] = await Promise.all([
      supabase
        .from('orders')
        .select('id, session_id, user_id, status, total_amount, created_at')
        .order('created_at', { ascending: false }),
      supabase.from('order_items').select('order_id, item_id, item_name, quantity, line_total, created_at'),
      supabase.from('items').select('id, status'),
    ]);

    if (ordersResult.error) {
      console.error('[admin.kpi] Failed to fetch orders:', ordersResult.error);
      return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
    }

    if (orderItemsResult.error) {
      console.error('[admin.kpi] Failed to fetch order items:', orderItemsResult.error);
      return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
    }

    if (itemsResult.error) {
      console.error('[admin.kpi] Failed to fetch items:', itemsResult.error);
      return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
    }

    const orders = (ordersResult.data ?? []) as OrderMetricRow[];
    const orderItems = (orderItemsResult.data ?? []) as OrderItemMetricRow[];
    const items = (itemsResult.data ?? []) as ItemMetricRow[];

    const paidOrders = orders.filter((order) => order.status === 'paid');

    const monthlyYearOptions = Array.from(new Set(paidOrders.map((order) => getJstYear(order.created_at))))
      .sort((left, right) => right - left);

    if (!monthlyYearOptions.includes(targetYear)) {
      monthlyYearOptions.unshift(targetYear);
    }

    const orderAggregationByOrderId = new Map<string, OrderAggregation>();
    for (const orderItem of orderItems) {
      const current = orderAggregationByOrderId.get(orderItem.order_id) ?? { totalUnits: 0, itemIds: [] };
      current.totalUnits += orderItem.quantity;
      current.itemIds.push(orderItem.item_id);
      orderAggregationByOrderId.set(orderItem.order_id, current);
    }

    const monthlyAccumulatorMap = new Map<string, PeriodAccumulator>();
    const seasonalAccumulatorMap = new Map<string, PeriodAccumulator>();

    for (const order of orders) {
      const monthKey = getJstMonthKey(order.created_at);
      const seasonKey = getSeasonKeyFromDate(new Date(order.created_at));
      const orderAggregation = orderAggregationByOrderId.get(order.id) ?? { totalUnits: 0, itemIds: [] };

      applyOrderToAccumulator(getOrCreatePeriodAccumulator(monthlyAccumulatorMap, monthKey), order, orderAggregation);
      applyOrderToAccumulator(getOrCreatePeriodAccumulator(seasonalAccumulatorMap, seasonKey), order, orderAggregation);
    }

    const publishedItems = items.filter((item) => item.status === 'published').length;

    const monthlyKpiByYear = monthlyYearOptions.map((year) => {
      const monthSeries = createMonthSeries(year);

      return {
        year,
        metrics: monthSeries.map((month) => {
          const accumulator = monthlyAccumulatorMap.get(month.key) ?? createPeriodAccumulator();
          return toKpiMetricsResponse(month.label, accumulator, publishedItems);
        }),
      };
    });

    const recentSeasonKeys = buildRecentSeasonKeys(getSeasonKeyFromDate(now), SEASON_HISTORY_YEARS * 2);
    const seasonalKpi = recentSeasonKeys.map((seasonKey) => {
      const accumulator = seasonalAccumulatorMap.get(seasonKey) ?? createPeriodAccumulator();
      return toKpiMetricsResponse(seasonKey, accumulator, publishedItems);
    });

    return NextResponse.json(
      {
        data: {
          targetYear,
          monthlyYearOptions,
          monthlyKpiByYear,
          seasonalKpi,
          returnRateNote: '返品データが未保持のため、返品率はキャンセル率を代替表示しています。',
          inventoryConsumptionRateNote: '在庫数量を保持していないため、在庫消化率は「販売実績のある公開商品数 / 公開商品数」で算出しています。',
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/kpi error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}