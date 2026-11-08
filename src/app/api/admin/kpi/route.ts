import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getAccountingSettings, listAccountingPeriods, parse, rpc } from '@/lib/accounting/accounting-store';
import { AccountingStoreError } from '@/lib/accounting/accounting-types';
import { toJstDate } from '@/lib/accounting/jst-date';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';

type OrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled';
type PublishStatus = 'private' | 'published';

// 注文の作成日の月で数える CVR・返品率の入力（受注高そのものは帳簿の読み口から数える）
type OrderMetricRow = {
  id: string;
  status: OrderStatus;
  created_at: string;
};

type CustomerKeyRow = {
  id: string;
  session_id: string;
  user_id: string | null;
};

type OrderItemMetricRow = {
  order_id: string;
  item_id: number;
  item_name: string;
  quantity: number;
  line_total: number;
  // 'exchange' は返品の交換でお店が足した品の行（値段は 0）。お金が動かないので、セット注文と販売実績の数に入れない
  line_kind: 'order' | 'exchange';
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
  // 支払いを受けた日の月で数える注文（客単価・LTV・リピート率・セット購入率の分母）
  paidOrders: number;
  // 注文を作った月で数える、支払いを受けた注文（CVR の分子）
  createdPaidOrders: number;
  // 受注高。支払い・出荷前の取り消し・支払いの取り消し（出荷前）の合計
  paidSales: number;
  setOrderCount: number;
  cancelledOrders: number;
  soldItemIds: Set<number>;
  customerOrderCount: Map<string, number>;
};

const SEASON_HISTORY_YEARS = 3;
// 顧客の鍵を注文の番号で引く1回の件数
const CUSTOMER_LOOKUP_CHUNK = 200;
// 受注高の出来事を続きの目印で読む1回の件数と、読む回数の上限（上限を超えたら読み込みの失敗にする）
const INTAKE_PAGE_SIZE = 5000;
const MAX_INTAKE_PAGES = 200;

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  }).format(amount);
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
  return seasonKeyOf(getJstYear(dateInput), getJstMonthNumber(dateInput));
}

// 月のキー（YYYY-MM）が属するシーズン
function getSeasonKeyFromMonthKey(monthKey: string): string {
  return seasonKeyOf(Number.parseInt(monthKey.slice(0, 4), 10), Number.parseInt(monthKey.slice(5, 7), 10));
}

function seasonKeyOf(year: number, month: number): string {
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
    createdPaidOrders: 0,
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

function resolveCustomerKey(orderId: string, customer: Pick<CustomerKeyRow, 'user_id' | 'session_id'> | undefined): string {
  if (!customer) {
    return `order:${orderId}`;
  }

  if (customer.user_id) {
    return `user:${customer.user_id}`;
  }

  return `guest:${customer.session_id}`;
}

// 注文を作った月の数え方（CVR の分母と分子・返品率）。受注高は含めない。
function applyCreatedOrderToAccumulator(accumulator: PeriodAccumulator, order: OrderMetricRow, isPaid: boolean): void {
  accumulator.allOrders += 1;

  if (order.status === 'cancelled') {
    accumulator.cancelledOrders += 1;
  }

  if (isPaid) {
    accumulator.createdPaidOrders += 1;
  }
}

// 支払いを受けた日の月の数え方（客単価・LTV・リピート率・セット購入率・販売実績商品数）
function applyPaidOrderToAccumulator(
  accumulator: PeriodAccumulator,
  customerKey: string,
  orderAggregation: OrderAggregation,
): void {
  accumulator.paidOrders += 1;

  if (orderAggregation.totalUnits >= 2) {
    accumulator.setOrderCount += 1;
  }

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
  setOrderCount: number;
  cancelledOrderCount: number;
  soldItemCount: number;
  publishedItemCount: number;
} {
  const cvr = accumulator.allOrders === 0 ? 0 : (accumulator.createdPaidOrders / accumulator.allOrders) * 100;
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

  // salesAmount・formattedSales は受注高。鍵は目標の鍵 `sales` と同じ理由で据え置き
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
    setOrderCount: accumulator.setOrderCount,
    cancelledOrderCount: accumulator.cancelledOrders,
    soldItemCount: accumulator.soldItemIds.size,
    publishedItemCount: publishedItemsCount,
  };
}

const money = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// 受注高の出来事（Task 7 の list_order_intake_events）。種類は支払い・出荷前の取り消し・支払いの取り消し（出荷前）とその戻し
const intakePageSchema = z
  .object({
    events: z.array(
      z
        .object({
          order_id: z.string().min(1),
          event_date: dateText,
          kind: z.enum(['payment', 'pre_shipment_cancel', 'dispute_unshipped', 'dispute_unshipped_restored']),
          amount: money,
          key: z.string().min(1),
        })
        .strict(),
    ),
    next_after_date: dateText.nullable(),
    next_after_key: z.string().nullable(),
  })
  .strict();

const backlogSchema = z.object({ backlog_total: money, order_count: count }).strict();

const breakdownSchema = z
  .object({
    subtotal_before_discount: money,
    discount: money,
    shipping: money,
    payment: money,
    pre_shipment_cancel: money,
    dispute_unshipped: money,
    dispute_unshipped_restored: money,
    intake: money,
    order_count: count,
    breakdown_ok: z.boolean(),
  })
  .strict();

// 照らし合わせの答えは、返品の額だけを使う
const returnsSchema = z.object({ returns: money });

type IntakeEvent = z.infer<typeof intakePageSchema>['events'][number];

// 会計の最初の期間の初日（期間が無ければ切り替えの日）。ここより前は帳簿に注文の行が無い（Ruling P2-M8）
async function resolveIntakeStart(client: SupabaseClient): Promise<string> {
  const periods = await listAccountingPeriods(client);
  if (periods.length > 0) {
    return periods.reduce((earliest, period) => (period.startsOn < earliest ? period.startsOn : earliest), periods[0].startsOn);
  }
  return (await getAccountingSettings(client)).cutoverOn;
}

// 受注高の出来事を、続きの目印で最後まで読む
async function readIntakeEvents(client: SupabaseClient, from: string, to: string): Promise<IntakeEvent[]> {
  const events: IntakeEvent[] = [];
  let afterDate: string | null = null;
  let afterKey: string | null = null;

  for (let page = 0; page < MAX_INTAKE_PAGES; page += 1) {
    const result: z.infer<typeof intakePageSchema> = parse(
      intakePageSchema,
      await rpc(client, 'list_order_intake_events', {
        _from: from,
        _to: to,
        _limit: INTAKE_PAGE_SIZE,
        _after_date: afterDate,
        _after_key: afterKey,
      }),
    );
    events.push(...result.events);

    if (result.next_after_date === null && result.next_after_key === null) {
      return events;
    }
    if (result.next_after_date === null || result.next_after_key === null) {
      throw new AccountingStoreError();
    }
    afterDate = result.next_after_date;
    afterKey = result.next_after_key;
  }

  throw new AccountingStoreError();
}

type IntakeReads = {
  events: IntakeEvent[];
  backlog: { total: number; orderCount: number; asOf: string };
  intakeBreakdown: {
    from: string;
    to: string;
    subtotalBeforeDiscount: number;
    discount: number;
    shipping: number;
    payment: number;
    preShipmentCancel: number;
    disputeUnshipped: number;
    disputeUnshippedRestored: number;
    intake: number;
    orderCount: number;
    breakdownOk: boolean;
  };
  returnsThisMonth: { month: string; amount: number };
};

// 受注高の出来事・受注残・今の月の内訳と返品を、サービスロールの読み口から読む（個人の情報は返らない）
async function readIntake(client: SupabaseClient, today: string): Promise<IntakeReads> {
  const monthStart = `${today.slice(0, 7)}-01`;
  const start = await resolveIntakeStart(client);

  const [events, backlog, breakdown, reconciliation] = await Promise.all([
    // 切り替えの日が今日より後の間は、読む範囲が無い
    start > today ? Promise.resolve<IntakeEvent[]>([]) : readIntakeEvents(client, start, today),
    rpc(client, 'get_order_backlog', { _as_of: today }),
    rpc(client, 'get_intake_breakdown', { _from: monthStart, _to: today }),
    rpc(client, 'get_intake_reconciliation', { _from: monthStart, _to: today }),
  ]);

  const parsedBacklog = parse(backlogSchema, backlog);
  const parsedBreakdown = parse(breakdownSchema, breakdown);
  const parsedReturns = parse(returnsSchema, reconciliation);

  return {
    events,
    backlog: { total: parsedBacklog.backlog_total, orderCount: parsedBacklog.order_count, asOf: today },
    intakeBreakdown: {
      from: monthStart,
      to: today,
      subtotalBeforeDiscount: parsedBreakdown.subtotal_before_discount,
      discount: parsedBreakdown.discount,
      shipping: parsedBreakdown.shipping,
      payment: parsedBreakdown.payment,
      preShipmentCancel: parsedBreakdown.pre_shipment_cancel,
      disputeUnshipped: parsedBreakdown.dispute_unshipped,
      disputeUnshippedRestored: parsedBreakdown.dispute_unshipped_restored,
      intake: parsedBreakdown.intake,
      orderCount: parsedBreakdown.order_count,
      breakdownOk: parsedBreakdown.breakdown_ok,
    },
    returnsThisMonth: { month: today.slice(0, 7), amount: parsedReturns.returns },
  };
}

// 出来事の日の月ごとの受注高と、(注文, 月) ごとの支払いの正味
function summarizeIntakeEvents(events: IntakeEvent[]): {
  salesByMonth: Map<string, number>;
  paymentNetByOrder: Map<string, Map<string, number>>;
} {
  const salesByMonth = new Map<string, number>();
  const paymentNetByOrder = new Map<string, Map<string, number>>();

  for (const event of events) {
    const monthKey = event.event_date.slice(0, 7);
    salesByMonth.set(monthKey, (salesByMonth.get(monthKey) ?? 0) + event.amount);

    if (event.kind === 'payment') {
      const months = paymentNetByOrder.get(event.order_id) ?? new Map<string, number>();
      months.set(monthKey, (months.get(monthKey) ?? 0) + event.amount);
      paymentNetByOrder.set(event.order_id, months);
    }
  }

  return { salesByMonth, paymentNetByOrder };
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

    const supabase = await createClient(request);
    const now = new Date();
    const targetYear = getJstYear(now);

    const [ordersResult, orderItemsResult, itemsResult] = await Promise.all([
      supabase
        .from('orders')
        .select('id, status, created_at')
        // 受付の前の注文（支払い手続き中・放棄）は数えない。CVR と返品率を下げないため
        .not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
        .order('created_at', { ascending: false }),
      supabase.from('order_items').select('order_id, item_id, item_name, quantity, line_total, line_kind, created_at'),
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

    // 受注高は帳簿（保存した仕訳）から数える。計上待ちの注文（支払いの仕訳がまだ無い）は入らない
    let intake: IntakeReads;
    try {
      intake = await readIntake(await createServiceRoleClient(), toJstDate(now));
    } catch (error) {
      console.error('[admin.kpi] Failed to read order intake:', error);
      return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
    }

    const { salesByMonth, paymentNetByOrder } = summarizeIntakeEvents(intake.events);

    // 支払いを受けた注文（どこかの月で正味がプラス）の顧客の鍵を、注文の番号で200件ずつ引く
    const paidOrderIds = Array.from(paymentNetByOrder.entries())
      .filter(([, months]) => Array.from(months.values()).some((net) => net > 0))
      .map(([orderId]) => orderId);
    const paidOrderIdSet = new Set(paidOrderIds);
    const customerByOrderId = new Map<string, CustomerKeyRow>();
    for (let offset = 0; offset < paidOrderIds.length; offset += CUSTOMER_LOOKUP_CHUNK) {
      const customersResult = await supabase
        .from('orders')
        .select('id, session_id, user_id')
        .in('id', paidOrderIds.slice(offset, offset + CUSTOMER_LOOKUP_CHUNK));
      if (customersResult.error) {
        console.error('[admin.kpi] Failed to fetch order customers:', customersResult.error);
        return NextResponse.json({ error: 'Failed to fetch KPI data' }, { status: 500 });
      }
      for (const row of (customersResult.data ?? []) as CustomerKeyRow[]) {
        customerByOrderId.set(row.id, row);
      }
    }

    const monthlyYearOptions = Array.from(
      new Set(Array.from(salesByMonth.keys()).map((monthKey) => Number.parseInt(monthKey.slice(0, 4), 10))),
    ).sort((left, right) => right - left);

    if (!monthlyYearOptions.includes(targetYear)) {
      monthlyYearOptions.unshift(targetYear);
    }

    const orderAggregationByOrderId = new Map<string, OrderAggregation>();
    for (const orderItem of orderItems) {
      // 交換の品の行は数えない。数えると、1点の注文に交換の品が付いただけで「セット注文」になり、同じ商品が2回売れたことになる
      if (orderItem.line_kind === 'exchange') {
        continue;
      }

      const current = orderAggregationByOrderId.get(orderItem.order_id) ?? { totalUnits: 0, itemIds: [] };
      current.totalUnits += orderItem.quantity;
      current.itemIds.push(orderItem.item_id);
      orderAggregationByOrderId.set(orderItem.order_id, current);
    }

    const monthlyAccumulatorMap = new Map<string, PeriodAccumulator>();
    const seasonalAccumulatorMap = new Map<string, PeriodAccumulator>();

    // CVR・返品率は注文を作った日の月で数える
    for (const order of orders) {
      const monthKey = getJstMonthKey(order.created_at);
      const seasonKey = getSeasonKeyFromDate(new Date(order.created_at));
      const isPaid = paidOrderIdSet.has(order.id);

      applyCreatedOrderToAccumulator(getOrCreatePeriodAccumulator(monthlyAccumulatorMap, monthKey), order, isPaid);
      applyCreatedOrderToAccumulator(getOrCreatePeriodAccumulator(seasonalAccumulatorMap, seasonKey), order, isPaid);
    }

    // 受注高は、出来事の日（支払いを受けた日・取り消した日）の月に足す。前の月の数字を後から変えない
    for (const [monthKey, amount] of salesByMonth) {
      getOrCreatePeriodAccumulator(monthlyAccumulatorMap, monthKey).paidSales += amount;
      getOrCreatePeriodAccumulator(seasonalAccumulatorMap, getSeasonKeyFromMonthKey(monthKey)).paidSales += amount;
    }

    // 客単価・LTV・リピート率・セット購入率は、支払いを受けた日の月に、支払いの正味がプラスの注文を数える
    for (const [orderId, months] of paymentNetByOrder) {
      const orderAggregation = orderAggregationByOrderId.get(orderId) ?? { totalUnits: 0, itemIds: [] };
      const customerKey = resolveCustomerKey(orderId, customerByOrderId.get(orderId));

      for (const [monthKey, net] of months) {
        if (net <= 0) {
          continue;
        }
        applyPaidOrderToAccumulator(getOrCreatePeriodAccumulator(monthlyAccumulatorMap, monthKey), customerKey, orderAggregation);
        applyPaidOrderToAccumulator(
          getOrCreatePeriodAccumulator(seasonalAccumulatorMap, getSeasonKeyFromMonthKey(monthKey)),
          customerKey,
          orderAggregation,
        );
      }
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
          backlog: intake.backlog,
          intakeBreakdown: intake.intakeBreakdown,
          returnsThisMonth: intake.returnsThisMonth,
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
