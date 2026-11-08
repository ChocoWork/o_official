/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));

type Row = Record<string, unknown>;

// 窓口が読む表の中身と、サービスロールで呼ぶ読み口の答え。試験ごとに入れ替える
let mockOrders: Row[] = [];
let mockOrderItems: Row[] = [];
let mockCustomers: Row[] = [];
const mockCustomerChunks: string[][] = [];
const mockRpc = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    from: (table: string) => ({
      select: () => {
        if (table === 'orders') {
          return {
            not: () => ({ order: async () => ({ data: mockOrders, error: null }) }),
            in: async (_column: string, ids: string[]) => {
              mockCustomerChunks.push(ids);
              return { data: mockCustomers.filter((row) => ids.includes(row.id as string)), error: null };
            },
          };
        }
        if (table === 'order_items') {
          return Promise.resolve({ data: mockOrderItems, error: null });
        }
        return Promise.resolve({ data: [10, 11, 12].map((id) => ({ id, status: 'published' })), error: null });
      },
    }),
  })),
  createServiceRoleClient: jest.fn(async () => ({ rpc: (name: string, args?: unknown) => mockRpc(name, args) })),
}));

import { GET } from '@/app/api/admin/kpi/route';

type KpiMonth = {
  salesAmount: number;
  formattedSales: string;
  cvr: number;
  aov: number;
  ltv: number;
  repeatRate: number;
  setPurchaseRate: number;
  paidOrderCount: number;
  orderCount: number;
  customerCount: number;
  soldItemCount: number;
  cancelledOrderCount: number;
  returnRate: number;
};
type KpiResponse = {
  status: number;
  body: {
    error?: string;
    data: {
      monthlyKpiByYear: Array<{ year: number; metrics: KpiMonth[] }>;
      seasonalKpi: Array<KpiMonth & { period: string }>;
      backlog: { total: number; orderCount: number; asOf: string };
      intakeBreakdown: Record<string, unknown>;
      returnsThisMonth: { month: string; amount: number };
      returnRateNote: string;
    };
  };
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MARCH_10 = '2026-03-10T03:00:00.000Z'; // 日本時間 3月10日 12時

type Event = { order_id: string; event_date: string; kind: string; amount: number; key: string };
let mockEventPages: Array<{ events: Event[]; next_after_date: string | null; next_after_key: string | null }> = [];
let mockPeriods: Array<Record<string, unknown>> = [];

const BREAKDOWN = {
  subtotal_before_discount: 13000,
  discount: 1000,
  shipping: 0,
  payment: 12000,
  pre_shipment_cancel: 0,
  dispute_unshipped: 0,
  dispute_unshipped_restored: 0,
  intake: 12000,
  order_count: 1,
  breakdown_ok: true,
};

function period(startsOn: string): Record<string, unknown> {
  return {
    id: uuid(900),
    business_type: 'soleProprietor',
    name: '2026年',
    starts_on: startsOn,
    ends_on: '2026-12-31',
    corporate_tax_extension_months: 0,
    consumption_tax_extension_months: 0,
    consumption_tax_status: 'exempt',
    consumption_taxable_from: null,
    version: '1',
    legacy_fiscal_year: null,
  };
}

function defaultRpc(name: string, args: Record<string, unknown> | undefined): { data: unknown; error: null } {
  switch (name) {
    case 'list_accounting_periods':
      return { data: mockPeriods, error: null };
    case 'get_accounting_settings':
      return {
        data: {
          business_start_date: null,
          cutover_on: '2026-02-01',
          current_business_type: 'soleProprietor',
          sole_business_ended_on: null,
          version: '1',
          sole_end_changes: [],
        },
        error: null,
      };
    case 'list_order_intake_events': {
      const index = args?._after_key == null ? 0 : mockEventPages.findIndex((page) => page.events.some((e) => e.key === args._after_key)) + 1;
      return { data: mockEventPages[index] ?? { events: [], next_after_date: null, next_after_key: null }, error: null };
    }
    case 'get_order_backlog':
      return { data: { backlog_total: 54000, order_count: 3 }, error: null };
    case 'get_intake_breakdown':
      return { data: BREAKDOWN, error: null };
    case 'get_intake_reconciliation':
      return { data: { returns: 4000, intake: 12000 }, error: null };
    default:
      throw new Error(`unexpected rpc ${name}`);
  }
}

function paymentEvent(orderId: string, date: string, amount = 12000, key = `${orderId}:p:${date}`): Event {
  return { order_id: orderId, event_date: date, kind: 'payment', amount, key };
}

function oneOrder(id: string, createdAt: string, status = 'paid'): Row {
  return { id, status, created_at: createdAt };
}

function customer(id: string, userId: string | null, sessionId = `session-${id}`): Row {
  return { id, user_id: userId, session_id: sessionId };
}

function line(orderId: string, itemId: number, overrides: Row = {}): Row {
  return {
    order_id: orderId, item_id: itemId, item_name: `商品${itemId}`, quantity: 1, line_total: 12000,
    line_kind: 'order', created_at: MARCH_10, ...overrides,
  };
}

async function getKpi(): Promise<KpiResponse> {
  return (await GET(new Request('http://localhost/api/admin/kpi'))) as unknown as KpiResponse;
}

async function monthOf(year: number, monthIndex: number): Promise<KpiMonth> {
  const response = await getKpi();
  expect(response.status).toBe(200);
  const month = response.body.data.monthlyKpiByYear.find((entry) => entry.year === year)?.metrics[monthIndex];
  if (!month) throw new Error(`${year}年${monthIndex + 1}月の集計が返っていません`);
  return month;
}

function setEvents(events: Event[]): void {
  mockEventPages = [{ events, next_after_date: null, next_after_key: null }];
}

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-04-15T03:00:00.000Z'),
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'performance', 'hrtime'],
  });
  mockAuthorize.mockReset().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' });
  mockOrders = [];
  mockOrderItems = [];
  mockCustomers = [];
  mockCustomerChunks.length = 0;
  mockEventPages = [{ events: [], next_after_date: null, next_after_key: null }];
  mockPeriods = [period('2026-01-01')];
  mockRpc.mockReset().mockImplementation(async (name: string, args?: Record<string, unknown>) => defaultRpc(name, args));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('GET /api/admin/kpi の受注高（計画2 Task 13）', () => {
  it('FREQ-572-AC-02: 発送済みの注文も受注高に入り、出荷しても数字が小さくならない', async () => {
    // 出荷の後に返品された注文（orders.status が paid でない）も、支払いの仕訳があれば受注高に残る
    mockOrders = [oneOrder(uuid(1), MARCH_10, 'cancelled')];
    mockCustomers = [customer(uuid(1), 'user-1')];
    setEvents([paymentEvent(uuid(1), '2026-03-10')]);

    const march = await monthOf(2026, 2);

    expect(march.salesAmount).toBe(12000);
    expect(march.paidOrderCount).toBe(1);
    expect(march.aov).toBe(12000);
  });

  it('FREQ-572-AC-02: 出荷後の返品が届いても受注高は変わらず、返品の行に別に出る', async () => {
    mockOrders = [oneOrder(uuid(1), MARCH_10)];
    mockCustomers = [customer(uuid(1), 'user-1')];
    setEvents([paymentEvent(uuid(1), '2026-03-10')]);

    const response = await getKpi();

    expect(response.status).toBe(200);
    expect(response.body.data.monthlyKpiByYear[0].metrics[2].salesAmount).toBe(12000);
    expect(response.body.data.monthlyKpiByYear[0].metrics[3].salesAmount).toBe(0);
    expect(response.body.data.returnsThisMonth).toEqual({ month: '2026-04', amount: 4000 });
    expect(mockRpc).toHaveBeenCalledWith('get_intake_reconciliation', { _from: '2026-04-01', _to: '2026-04-15' });
  });

  it('FREQ-572-AC-03: 受注高と客単価とLTVとリピート率とセット購入率は支払いを受けた日の月で数える', async () => {
    // 3月10日に作った注文の支払いが4月2日。4月にだけ入る
    mockOrders = [oneOrder(uuid(1), MARCH_10), oneOrder(uuid(2), '2026-03-12T03:00:00.000Z')];
    mockCustomers = [customer(uuid(1), 'user-1'), customer(uuid(2), 'user-1')];
    mockOrderItems = [line(uuid(1), 10), line(uuid(1), 11), line(uuid(2), 10)];
    setEvents([paymentEvent(uuid(1), '2026-04-02', 20000), paymentEvent(uuid(2), '2026-04-03', 10000)]);

    const march = await monthOf(2026, 2);
    const april = await monthOf(2026, 3);

    expect(march.salesAmount).toBe(0);
    expect(march.paidOrderCount).toBe(0);
    expect(april.salesAmount).toBe(30000);
    expect(april.paidOrderCount).toBe(2);
    expect(april.aov).toBe(15000);
    expect(april.customerCount).toBe(1);
    expect(april.ltv).toBe(30000);
    expect(april.repeatRate).toBe(100);
    expect(april.setPurchaseRate).toBe(50);
  });

  it('FREQ-572-AC-03: 日をまたいで支払いが記録された注文は、支払いの仕訳の日の月に入る（created_atやpaid_atの月ではない）', async () => {
    // 日本時間 3月31日 23時30分に作った注文。支払いの仕訳の日は4月1日
    mockOrders = [oneOrder(uuid(1), '2026-03-31T14:30:00.000Z')];
    mockCustomers = [customer(uuid(1), null)];
    setEvents([paymentEvent(uuid(1), '2026-04-01')]);

    const march = await monthOf(2026, 2);
    const april = await monthOf(2026, 3);

    expect(march.salesAmount).toBe(0);
    expect(april.salesAmount).toBe(12000);
    expect(april.customerCount).toBe(1);
  });

  it('FREQ-572-AC-03: CVRは注文を作った月で数え、支払いの途中・失敗・放棄の注文を入れない', async () => {
    mockOrders = [
      oneOrder(uuid(1), MARCH_10),
      oneOrder(uuid(2), MARCH_10, 'pending'),
      oneOrder(uuid(3), MARCH_10, 'failed'),
    ];
    mockCustomers = [customer(uuid(1), 'user-1')];
    // 3月に作った注文の支払いは4月。分子は作った月（3月）に入る
    setEvents([paymentEvent(uuid(1), '2026-04-02')]);

    const march = await monthOf(2026, 2);
    const april = await monthOf(2026, 3);

    expect(march.orderCount).toBe(3);
    expect(march.cvr).toBeCloseTo(33.33, 1);
    expect(april.orderCount).toBe(0);
    expect(april.cvr).toBe(0);
  });

  it('FREQ-572-AC-03: 交換の品はセット購入率に入らない', async () => {
    mockOrders = [oneOrder(uuid(1), MARCH_10), oneOrder(uuid(2), MARCH_10)];
    mockCustomers = [customer(uuid(1), 'user-1'), customer(uuid(2), 'user-2')];
    mockOrderItems = [
      line(uuid(1), 10),
      line(uuid(1), 10, { line_total: 0, line_kind: 'exchange' }),
      line(uuid(2), 10),
      line(uuid(2), 11),
    ];
    setEvents([paymentEvent(uuid(1), '2026-03-10'), paymentEvent(uuid(2), '2026-03-10')]);

    const march = await monthOf(2026, 2);

    expect(march.paidOrderCount).toBe(2);
    expect(march.setPurchaseRate).toBe(50);
    expect(march.soldItemCount).toBe(2);
  });

  it('FREQ-572-AC-02: 出荷前の取り消しは取り消しの日の月の受注高から引き、前の月の数字を後から変えない', async () => {
    mockOrders = [oneOrder(uuid(1), MARCH_10, 'cancelled')];
    mockCustomers = [customer(uuid(1), 'user-1')];
    setEvents([
      paymentEvent(uuid(1), '2026-03-10'),
      { order_id: uuid(1), event_date: '2026-04-05', kind: 'pre_shipment_cancel', amount: -12000, key: 'c1' },
      { order_id: uuid(1), event_date: '2026-04-06', kind: 'dispute_unshipped', amount: -500, key: 'd1' },
      { order_id: uuid(1), event_date: '2026-04-07', kind: 'dispute_unshipped_restored', amount: 500, key: 'd2' },
    ]);

    const march = await monthOf(2026, 2);
    const april = await monthOf(2026, 3);

    expect(march.salesAmount).toBe(12000);
    expect(april.salesAmount).toBe(-12000);
    // 取り消しは注文の数に足さない（支払いを受けたのは3月）
    expect(april.paidOrderCount).toBe(0);
  });

  it('FREQ-572-AC-03: 同じ月に取り消された支払いは、その月の注文の数に入れない', async () => {
    mockOrders = [oneOrder(uuid(1), MARCH_10, 'cancelled')];
    mockCustomers = [customer(uuid(1), 'user-1')];
    setEvents([paymentEvent(uuid(1), '2026-03-10'), paymentEvent(uuid(1), '2026-03-11', -12000, 'rev')]);

    const march = await monthOf(2026, 2);

    expect(march.salesAmount).toBe(0);
    expect(march.paidOrderCount).toBe(0);
  });

  it('FREQ-572-AC-04: KPIのrouteはサポーターを403で断り、店長だけが読める', async () => {
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'supporter-1', role: 'supporter' });

    const response = await getKpi();

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
  });

  it('FREQ-572-AC-02: 応答に受注残・今月の内訳・今月の返品が付き、鍵 salesAmount と formattedSales は変わらない', async () => {
    mockOrders = [oneOrder(uuid(1), MARCH_10)];
    mockCustomers = [customer(uuid(1), 'user-1')];
    setEvents([paymentEvent(uuid(1), '2026-03-10')]);

    const response = await getKpi();

    expect(response.body.data.backlog).toEqual({ total: 54000, orderCount: 3, asOf: '2026-04-15' });
    expect(response.body.data.intakeBreakdown).toEqual({
      from: '2026-04-01',
      to: '2026-04-15',
      subtotalBeforeDiscount: 13000,
      discount: 1000,
      shipping: 0,
      payment: 12000,
      preShipmentCancel: 0,
      disputeUnshipped: 0,
      disputeUnshippedRestored: 0,
      intake: 12000,
      orderCount: 1,
      breakdownOk: true,
    });
    const march = response.body.data.monthlyKpiByYear[0].metrics[2];
    expect(march.salesAmount).toBe(12000);
    expect(march.formattedSales).toBe('￥12,000');
    expect(response.body.data.returnRateNote).toContain('キャンセル率');
    expect(mockRpc).toHaveBeenCalledWith('get_order_backlog', { _as_of: '2026-04-15' });
    expect(mockRpc).toHaveBeenCalledWith('get_intake_breakdown', { _from: '2026-04-01', _to: '2026-04-15' });
  });

  it('FREQ-572-AC-05: 内訳の合計が受注高に合わない時は、breakdownOk を偽のまま画面へ渡す', async () => {
    mockRpc.mockImplementation(async (name: string, args?: Record<string, unknown>) =>
      name === 'get_intake_breakdown' ? { data: { ...BREAKDOWN, intake: 12500, breakdown_ok: false }, error: null } : defaultRpc(name, args),
    );

    const response = await getKpi();

    expect(response.body.data.intakeBreakdown).toMatchObject({ intake: 12500, breakdownOk: false });
  });

  it('FREQ-572-AC-03: 受注高の出来事は会計の最初の期間の初日から続きの目印で最後まで読む', async () => {
    mockPeriods = [period('2026-03-01'), period('2026-01-01')];
    mockOrders = [oneOrder(uuid(1), MARCH_10), oneOrder(uuid(2), MARCH_10)];
    mockCustomers = [customer(uuid(1), 'user-1'), customer(uuid(2), 'user-2')];
    mockEventPages = [
      { events: [paymentEvent(uuid(1), '2026-03-10', 12000, 'k1')], next_after_date: '2026-03-10', next_after_key: 'k1' },
      { events: [paymentEvent(uuid(2), '2026-03-11', 8000, 'k2')], next_after_date: null, next_after_key: null },
    ];

    const march = await monthOf(2026, 2);

    expect(march.salesAmount).toBe(20000);
    const eventCalls = mockRpc.mock.calls.filter(([name]) => name === 'list_order_intake_events');
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0][1]).toEqual({ _from: '2026-01-01', _to: '2026-04-15', _limit: 5000, _after_date: null, _after_key: null });
    expect(eventCalls[1][1]).toEqual({ _from: '2026-01-01', _to: '2026-04-15', _limit: 5000, _after_date: '2026-03-10', _after_key: 'k1' });
  });

  it('FREQ-572-AC-03: 会計の期間が1つも無い時は切り替えの日から読む', async () => {
    mockPeriods = [];

    await getKpi();

    const first = mockRpc.mock.calls.find(([name]) => name === 'list_order_intake_events');
    expect(first?.[1]).toMatchObject({ _from: '2026-02-01' });
  });

  it('FREQ-572-AC-03: 顧客の鍵は注文の番号で200件ずつ引く', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => uuid(1000 + index));
    mockOrders = ids.map((id) => oneOrder(id, MARCH_10));
    mockCustomers = ids.map((id, index) => customer(id, index < 2 ? 'user-same' : `user-${index}`));
    setEvents(ids.map((id) => paymentEvent(id, '2026-03-10', 1000)));

    const march = await monthOf(2026, 2);

    expect(mockCustomerChunks.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
    expect(march.paidOrderCount).toBe(450);
    expect(march.customerCount).toBe(449);
  });

  it('FREQ-572-AC-02: 帳簿の読み込みに失敗した時は 500 を返し、DB の文を出さない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRpc.mockImplementation(async (name: string, args?: Record<string, unknown>) =>
      name === 'get_order_backlog' ? { data: null, error: { message: 'secret detail', code: 'XX000' } } : defaultRpc(name, args),
    );

    const response = await getKpi();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to fetch KPI data' });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
});
