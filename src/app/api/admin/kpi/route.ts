import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

type OrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled';
type ItemCategory = 'TOPS' | 'BOTTOMS' | 'OUTERWEAR' | 'ACCESSORIES';
type PublishStatus = 'private' | 'published';

type OrderMetricRow = {
  id: string;
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
  category: ItemCategory;
  status: PublishStatus;
};

type StatusMetricRow = {
  status: PublishStatus;
};

type UserMetricRow = {
  id: string;
  last_sign_in_at: string | null;
};

const CATEGORY_LABELS: Record<ItemCategory, string> = {
  TOPS: 'トップス',
  BOTTOMS: 'ボトムス',
  OUTERWEAR: 'アウター',
  ACCESSORIES: 'アクセサリー',
};

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '未決済',
  paid: '決済完了',
  failed: '決済失敗',
  cancelled: 'キャンセル',
};

const TREND_WINDOW_DAYS = 30;

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

  return keys.reverse();
}

function shiftUtcDate(baseDate: Date, dayOffset: number): Date {
  const nextDate = new Date(baseDate);
  nextDate.setUTCDate(nextDate.getUTCDate() + dayOffset);
  return nextDate;
}

function createMonthSeries(year: number): Array<{ key: string; label: string }> {
  return Array.from({ length: 12 }, (_, index) => {
    const monthNumber = index + 1;
    const key = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const label = `${monthNumber}月`;
    return { key, label };
  });
}

function getPercentChange(currentValue: number, previousValue: number): number | null {
  if (previousValue === 0) {
    return currentValue === 0 ? 0 : null;
  }

  return ((currentValue - previousValue) / previousValue) * 100;
}

function getDifference(currentValue: number, previousValue: number): number {
  return currentValue - previousValue;
}

function getTrendTone(value: number | null): 'positive' | 'negative' | 'neutral' {
  if (value === null || value === 0) {
    return 'neutral';
  }

  return value > 0 ? 'positive' : 'negative';
}

function getDifferenceTone(value: number): 'positive' | 'negative' | 'neutral' {
  if (value === 0) {
    return 'neutral';
  }

  return value > 0 ? 'positive' : 'negative';
}

function getTrendLabel(currentValue: number, previousValue: number, unit: 'currency' | 'count' | 'percent'): string {
  if (previousValue === 0 && currentValue > 0) {
    return '比較対象なし';
  }

  const diff = currentValue - previousValue;
  if (unit === 'currency') {
    const prefix = diff > 0 ? '+' : '';
    return `${prefix}${formatCurrency(diff)} 前期間比`;
  }

  if (unit === 'percent') {
    const prefix = diff > 0 ? '+' : '';
    return `${prefix}${diff.toFixed(1)}pt 前期間比`;
  }

  const prefix = diff > 0 ? '+' : '';
  return `${prefix}${formatInteger(diff)} 前日比`;
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
    const firstMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const fromIso = firstMonthDate.toISOString();

    const [ordersResult, orderItemsResult, itemsResult, looksResult, newsResult, usersResult] = await Promise.all([
      supabase
        .from('orders')
        .select('id, status, total_amount, created_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('order_items')
        .select('order_id, item_id, item_name, quantity, line_total, created_at')
        .gte('created_at', fromIso),
      supabase.from('items').select('id, category, status'),
      supabase.from('looks').select('status'),
      supabase.from('news_articles').select('status'),
      supabase.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      }),
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

    if (looksResult.error) {
      console.error('[admin.kpi] Failed to fetch looks:', looksResult.error);
      return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
    }

    if (newsResult.error) {
      console.error('[admin.kpi] Failed to fetch news:', newsResult.error);
      return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
    }

    if (usersResult.error) {
      console.error('[admin.kpi] Failed to fetch users:', usersResult.error);
      return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
    }

    const orders = (ordersResult.data ?? []) as OrderMetricRow[];
    const orderItems = (orderItemsResult.data ?? []) as OrderItemMetricRow[];
    const items = (itemsResult.data ?? []) as ItemMetricRow[];
    const looks = (looksResult.data ?? []) as StatusMetricRow[];
    const newsArticles = (newsResult.data ?? []) as StatusMetricRow[];
    const users = (usersResult.data.users ?? []) as UserMetricRow[];

    const ordersById = new Map<string, OrderMetricRow>(orders.map((order) => [order.id, order]));
    const itemCategoryById = new Map<number, ItemCategory>(items.map((item) => [item.id, item.category]));
    const paidOrders = orders.filter((order) => order.status === 'paid');

    const todayKey = getJstDayKey(now);
    const yesterdayKey = getJstDayKey(shiftUtcDate(now, -1));
    const currentWindowStartKey = getJstDayKey(shiftUtcDate(now, -(TREND_WINDOW_DAYS - 1)));
    const previousWindowStartKey = getJstDayKey(shiftUtcDate(now, -((TREND_WINDOW_DAYS * 2) - 1)));
    const previousWindowEndKey = getJstDayKey(shiftUtcDate(now, -TREND_WINDOW_DAYS));
    const last30LoginStartKey = getJstDayKey(shiftUtcDate(now, -29));

    const todayOrders = orders.filter((order) => getJstDayKey(order.created_at) === todayKey);
    const yesterdayOrders = orders.filter((order) => getJstDayKey(order.created_at) === yesterdayKey);
    const todayPaidOrders = todayOrders.filter((order) => order.status === 'paid');
    const yesterdayPaidOrders = yesterdayOrders.filter((order) => order.status === 'paid');

    const currentWindowOrders = orders.filter((order) => {
      const dayKey = getJstDayKey(order.created_at);
      return dayKey >= currentWindowStartKey;
    });

    const previousWindowOrders = orders.filter((order) => {
      const dayKey = getJstDayKey(order.created_at);
      return dayKey >= previousWindowStartKey && dayKey <= previousWindowEndKey;
    });

    const currentWindowPaidOrders = currentWindowOrders.filter((order) => order.status === 'paid');
    const previousWindowPaidOrders = previousWindowOrders.filter((order) => order.status === 'paid');

    const todaySalesAmount = todayPaidOrders.reduce((sum, order) => sum + order.total_amount, 0);
    const yesterdaySalesAmount = yesterdayPaidOrders.reduce((sum, order) => sum + order.total_amount, 0);
    const todayOrdersCount = todayOrders.length;
    const yesterdayOrdersCount = yesterdayOrders.length;

    const currentCompletionRate = currentWindowOrders.length === 0
      ? 0
      : (currentWindowPaidOrders.length / currentWindowOrders.length) * 100;
    const previousCompletionRate = previousWindowOrders.length === 0
      ? 0
      : (previousWindowPaidOrders.length / previousWindowOrders.length) * 100;

    const currentAov = currentWindowPaidOrders.length === 0
      ? 0
      : currentWindowPaidOrders.reduce((sum, order) => sum + order.total_amount, 0) / currentWindowPaidOrders.length;
    const previousAov = previousWindowPaidOrders.length === 0
      ? 0
      : previousWindowPaidOrders.reduce((sum, order) => sum + order.total_amount, 0) / previousWindowPaidOrders.length;

    const monthlyYearOptions = Array.from(new Set(paidOrders.map((order) => getJstYear(order.created_at))))
      .sort((left, right) => right - left);

    if (!monthlyYearOptions.includes(targetYear)) {
      monthlyYearOptions.unshift(targetYear);
    }

    const monthSeriesByYear = new Map<number, Array<{ key: string; label: string }>>();
    for (const year of monthlyYearOptions) {
      monthSeriesByYear.set(year, createMonthSeries(year));
    }

    const monthSalesMap = new Map<string, number>();
    const monthOrderCountMap = new Map<string, number>();

    for (const order of paidOrders) {
      const monthKey = getJstMonthKey(order.created_at);
      monthSalesMap.set(monthKey, (monthSalesMap.get(monthKey) ?? 0) + order.total_amount);
      monthOrderCountMap.set(monthKey, (monthOrderCountMap.get(monthKey) ?? 0) + 1);
    }

    const monthlySalesByYear = monthlyYearOptions.map((year) => {
      const series = monthSeriesByYear.get(year) ?? createMonthSeries(year);

      return {
        year,
        monthlySales: series.map((month) => {
          const amount = monthSalesMap.get(month.key) ?? 0;
          return {
            month: month.label,
            salesAmount: amount,
            formattedSales: formatCurrency(amount),
            orderCount: monthOrderCountMap.get(month.key) ?? 0,
          };
        }),
      };
    });

    const monthlySales = monthlySalesByYear.find((entry) => entry.year === targetYear)?.monthlySales ?? createMonthSeries(targetYear).map((month) => ({
      month: month.label,
      salesAmount: 0,
      formattedSales: formatCurrency(0),
      orderCount: 0,
    }));

    const annualSalesMap = new Map<number, { salesAmount: number; orderCount: number }>();
    for (const order of paidOrders) {
      const year = getJstYear(order.created_at);
      const current = annualSalesMap.get(year) ?? { salesAmount: 0, orderCount: 0 };
      current.salesAmount += order.total_amount;
      current.orderCount += 1;
      annualSalesMap.set(year, current);
    }

    const recentAnnualYears = Array.from({ length: 10 }, (_, index) => targetYear - 9 + index);

    const annualSales = recentAnnualYears.map((year) => {
      const metric = annualSalesMap.get(year) ?? { salesAmount: 0, orderCount: 0 };
      return {
        year,
        salesAmount: metric.salesAmount,
        formattedSales: formatCurrency(metric.salesAmount),
        orderCount: metric.orderCount,
      };
    });

    const seasonalSalesMap = new Map<string, { salesAmount: number; orderCount: number }>();

    for (const order of paidOrders) {
      const orderYear = getJstYear(order.created_at);
      const orderMonth = getJstMonthNumber(order.created_at);
      const seasonType = orderMonth >= 4 && orderMonth <= 9 ? 'SS' : 'AW';
      const seasonYear = seasonType === 'AW' && orderMonth <= 3 ? orderYear - 1 : orderYear;
      const seasonKey = `${seasonYear}${seasonType}`;
      const currentSeasonValue = seasonalSalesMap.get(seasonKey) ?? { salesAmount: 0, orderCount: 0 };

      currentSeasonValue.salesAmount += order.total_amount;
      currentSeasonValue.orderCount += 1;
      seasonalSalesMap.set(seasonKey, currentSeasonValue);
    }

    const recentSeasonKeys = buildRecentSeasonKeys(getSeasonKeyFromDate(now), 10);
    const seasonalSales = recentSeasonKeys.map((seasonKey) => {
      const metric = seasonalSalesMap.get(seasonKey) ?? { salesAmount: 0, orderCount: 0 };

      return {
        season: seasonKey,
        salesAmount: metric.salesAmount,
        formattedSales: formatCurrency(metric.salesAmount),
        orderCount: metric.orderCount,
      };
    });

    const categorySalesAmountMap = new Map<ItemCategory, number>();
    const topProductMap = new Map<number, { itemName: string; salesAmount: number; units: number }>();

    for (const orderItem of orderItems) {
      const order = ordersById.get(orderItem.order_id);
      if (!order || order.status !== 'paid') {
        continue;
      }

      const category = itemCategoryById.get(orderItem.item_id);
      if (category) {
        categorySalesAmountMap.set(category, (categorySalesAmountMap.get(category) ?? 0) + orderItem.line_total);
      }

      const currentTopProduct = topProductMap.get(orderItem.item_id) ?? {
        itemName: orderItem.item_name,
        salesAmount: 0,
        units: 0,
      };

      currentTopProduct.salesAmount += orderItem.line_total;
      currentTopProduct.units += orderItem.quantity;
      topProductMap.set(orderItem.item_id, currentTopProduct);
    }

    const totalCategorySalesAmount = Array.from(categorySalesAmountMap.values()).reduce((sum, amount) => sum + amount, 0);
    const categorySales = (Object.keys(CATEGORY_LABELS) as ItemCategory[]).map((category) => {
      const salesAmount = categorySalesAmountMap.get(category) ?? 0;
      const percentage = totalCategorySalesAmount === 0 ? 0 : (salesAmount / totalCategorySalesAmount) * 100;
      return {
        name: CATEGORY_LABELS[category],
        salesAmount,
        formattedSales: formatCurrency(salesAmount),
        percentage,
      };
    });

    const topProducts = Array.from(topProductMap.entries())
      .map(([itemId, value]) => ({
        itemId,
        name: value.itemName,
        salesAmount: value.salesAmount,
        units: value.units,
      }))
      .sort((left, right) => right.salesAmount - left.salesAmount)
      .slice(0, 5)
      .map((product, index) => ({
        rank: index + 1,
        name: product.name,
        formattedSales: formatCurrency(product.salesAmount),
        unitsLabel: `${formatInteger(product.units)}点`,
      }));

    const publishedItems = items.filter((item) => item.status === 'published').length;
    const privateItems = items.length - publishedItems;
    const publishedLooks = looks.filter((item) => item.status === 'published').length;
    const privateLooks = looks.length - publishedLooks;
    const publishedNews = newsArticles.filter((item) => item.status === 'published').length;
    const privateNews = newsArticles.length - publishedNews;
    const activeUsersLast30Days = users.filter((user) => {
      if (!user.last_sign_in_at) {
        return false;
      }

      return getJstDayKey(user.last_sign_in_at) >= last30LoginStartKey;
    }).length;

    const salesPercentChange = getPercentChange(todaySalesAmount, yesterdaySalesAmount);
    const completionRateDiff = getDifference(currentCompletionRate, previousCompletionRate);

    return NextResponse.json(
      {
        data: {
          summaryCards: [
            {
              label: '本日の売上',
              value: formatCurrency(todaySalesAmount),
              trend: salesPercentChange === null
                ? '比較対象なし'
                : `${salesPercentChange > 0 ? '+' : ''}${salesPercentChange.toFixed(1)}% 前日比`,
              tone: getTrendTone(salesPercentChange),
            },
            {
              label: '本日の注文数',
              value: formatInteger(todayOrdersCount),
              trend: getTrendLabel(todayOrdersCount, yesterdayOrdersCount, 'count'),
              tone: getDifferenceTone(getDifference(todayOrdersCount, yesterdayOrdersCount)),
            },
            {
              label: `決済完了率（直近${TREND_WINDOW_DAYS}日）`,
              value: formatPercent(currentCompletionRate),
              trend: getTrendLabel(currentCompletionRate, previousCompletionRate, 'percent'),
              tone: getDifferenceTone(completionRateDiff),
            },
            {
              label: `平均注文単価（直近${TREND_WINDOW_DAYS}日）`,
              value: formatCurrency(Math.round(currentAov)),
              trend: getTrendLabel(Math.round(currentAov), Math.round(previousAov), 'currency'),
              tone: getDifferenceTone(Math.round(currentAov - previousAov)),
            },
          ],
          targetYear,
          monthlySales,
          monthlyYearOptions,
          monthlySalesByYear,
          annualSales,
          seasonalSales,
          categorySales,
          operationalCards: [
            {
              label: '登録顧客数',
              value: formatInteger(users.length),
              detail: `直近30日ログイン ${formatInteger(activeUsersLast30Days)}名`,
            },
            {
              label: '公開商品数',
              value: formatInteger(publishedItems),
              detail: `非公開 ${formatInteger(privateItems)}件`,
            },
            {
              label: '公開コンテンツ数',
              value: formatInteger(publishedLooks + publishedNews),
              detail: `LOOK ${formatInteger(publishedLooks)} / NEWS ${formatInteger(publishedNews)}`,
            },
          ],
          topProducts,
          managementSummary: [
            {
              label: `直近12か月 ${ORDER_STATUS_LABELS.pending}`,
              value: formatInteger(
                orders.filter((order) => {
                  if (order.status !== 'pending') {
                    return false;
                  }

                  return new Date(order.created_at) >= firstMonthDate;
                }).length,
              ),
              tone: 'warning',
            },
            {
              label: `直近12か月 ${ORDER_STATUS_LABELS.paid}`,
              value: formatInteger(
                orders.filter((order) => {
                  if (order.status !== 'paid') {
                    return false;
                  }

                  return new Date(order.created_at) >= firstMonthDate;
                }).length,
              ),
              tone: 'success',
            },
            {
              label: '公開商品 / 非公開商品',
              value: `${formatInteger(publishedItems)} / ${formatInteger(privateItems)}`,
              tone: 'neutral',
            },
            {
              label: '公開LOOK / 非公開LOOK',
              value: `${formatInteger(publishedLooks)} / ${formatInteger(privateLooks)}`,
              tone: 'neutral',
            },
            {
              label: '公開NEWS / 非公開NEWS',
              value: `${formatInteger(publishedNews)} / ${formatInteger(privateNews)}`,
              tone: 'neutral',
            },
          ],
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/kpi error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}