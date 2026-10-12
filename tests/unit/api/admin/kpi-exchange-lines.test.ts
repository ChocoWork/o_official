jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

type Row = Record<string, unknown>;

// 窓口が読む表の中身。試験ごとに入れ替える
let mockOrders: Row[] = [];
let mockOrderItems: Row[] = [];
const mockOrderItemsSelect = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    from: (table: string) => ({
      select: (columns: string) => {
        if (table === 'orders') {
          return { not: () => ({ order: async () => ({ data: mockOrders, error: null }) }) };
        }
        if (table === 'order_items') {
          mockOrderItemsSelect(columns);
          return Promise.resolve({ data: mockOrderItems, error: null });
        }
        // items（公開商品の数に使う）
        return Promise.resolve({
          data: [10, 11, 12].map((id) => ({ id, status: 'published' })),
          error: null,
        });
      },
    }),
  })),
}));

import { GET } from '@/app/api/admin/kpi/route';

type KpiMonth = {
  paidOrderCount: number;
  salesAmount: number;
  setOrderCount: number;
  setPurchaseRate: number;
  soldItemCount: number;
};
type KpiResponse = {
  status: number;
  body: { data: { monthlyKpiByYear: Array<{ year: number; metrics: KpiMonth[] }> } };
};

const MARCH_10 = '2026-03-10T03:00:00.000Z'; // 日本時間 3月10日 12時
const MARCH_11 = '2026-03-11T03:00:00.000Z';

function paidOrder(id: string, createdAt: string): Row {
  return {
    id, session_id: `session-${id}`, user_id: `user-${id}`, payment_intent_id: `pi_${id}`,
    status: 'paid', total_amount: 12000, refunded_amount: 0, currency: 'jpy', created_at: createdAt,
  };
}

function line(orderId: string, itemId: number, overrides: Row = {}): Row {
  return {
    order_id: orderId, item_id: itemId, item_name: `商品${itemId}`, quantity: 1, line_total: 12000,
    line_kind: 'order', created_at: MARCH_10, ...overrides,
  };
}

// 返品の交換でお店が足した行。値段は 0
function exchangeLine(orderId: string, itemId: number): Row {
  return line(orderId, itemId, { line_total: 0, line_kind: 'exchange' });
}

async function getKpi(): Promise<KpiResponse> {
  return (await GET(new Request('http://localhost/api/admin/kpi'))) as unknown as KpiResponse;
}

// 2026年3月（日本時間）の集計。metrics は1月から並ぶので、3月の添字は 2
async function getMarch2026(): Promise<KpiMonth> {
  const response = await getKpi();
  expect(response.status).toBe(200);
  const march = response.body.data.monthlyKpiByYear.find((entry) => entry.year === 2026)?.metrics[2];
  if (!march) {
    throw new Error('2026年3月の集計が返っていません');
  }
  return march;
}

describe('GET /api/admin/kpi の交換の品の行（グループ E-3）', () => {
  beforeEach(() => {
    mockOrders = [];
    mockOrderItems = [];
    mockOrderItemsSelect.mockClear();
  });

  it('1点の注文に交換の品の行が付いても、セット注文に数えない。2点の注文は今までどおりセット注文（T13-1）', async () => {
    mockOrders = [paidOrder('order-set', MARCH_10), paidOrder('order-exchanged', MARCH_11)];
    mockOrderItems = [
      line('order-set', 10),
      line('order-set', 11),
      line('order-exchanged', 10),
      exchangeLine('order-exchanged', 10),
    ];

    const march = await getMarch2026();

    expect(march.paidOrderCount).toBe(2);
    expect(march.setOrderCount).toBe(1);
    expect(march.setPurchaseRate).toBe(50);
  });

  it('交換の品の行の商品は、販売実績の商品の数に入れない（T13-1）', async () => {
    mockOrders = [paidOrder('order-1', MARCH_10)];
    // 段1の交換は同じ商品だけだが、交換の品の行は商品の数に入れない決まりを、別の商品の番号で確かめる
    mockOrderItems = [line('order-1', 10), exchangeLine('order-1', 12)];

    const march = await getMarch2026();

    expect(march.soldItemCount).toBe(1);
  });

  it('売上と有効注文数は、交換の品の行があっても変わらない（お金が動かない）', async () => {
    mockOrders = [paidOrder('order-1', MARCH_10)];
    mockOrderItems = [line('order-1', 10), exchangeLine('order-1', 10)];

    const march = await getMarch2026();

    expect(march.salesAmount).toBe(12000);
    expect(march.paidOrderCount).toBe(1);
  });

  it('注文の商品の読み取りに line_kind の列を入れる', async () => {
    await getKpi();

    expect(mockOrderItemsSelect).toHaveBeenCalledTimes(1);
    expect(mockOrderItemsSelect).toHaveBeenCalledWith(expect.stringContaining('line_kind'));
  });
});
