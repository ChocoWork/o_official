import { render, screen, waitFor, within } from '@testing-library/react';
import KpiSection, { type AdminKpiData } from '@/components/KpiSection';

// 受注高の名前と数え方の画面（計画2 Task 13）。目標・月次記録の取得は空の答えで足りる。
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
}));
jest.mock('@/components/MetaKpiConnection', () => ({ MetaKpiConnection: () => null }));

function metric(period: string, overrides: Record<string, unknown> = {}) {
  return {
    period,
    salesAmount: 120000,
    formattedSales: '￥120,000',
    cvr: 10,
    formattedCvr: '10.0%',
    aov: 12000,
    formattedAov: '￥12,000',
    setPurchaseRate: 20,
    formattedSetPurchaseRate: '20.0%',
    inventoryConsumptionRate: 30,
    formattedInventoryConsumptionRate: '30.0%',
    ltv: 12000,
    formattedLtv: '￥12,000',
    repeatRate: 0,
    formattedRepeatRate: '0.0%',
    returnRate: 0,
    formattedReturnRate: '0.0%',
    orderCount: 10,
    paidOrderCount: 10,
    customerCount: 10,
    repeatCustomerCount: 0,
    setOrderCount: 2,
    cancelledOrderCount: 0,
    soldItemCount: 3,
    publishedItemCount: 10,
    ...overrides,
  };
}

const BREAKDOWN = {
  from: '2026-11-01',
  to: '2026-11-09',
  subtotalBeforeDiscount: 150000,
  discount: 10000,
  shipping: 0,
  payment: 140000,
  preShipmentCancel: -20000,
  disputeUnshipped: -3000,
  disputeUnshippedRestored: 1000,
  intake: 118000,
  orderCount: 12,
  breakdownOk: true,
};

function kpiData(overrides: Partial<AdminKpiData> = {}): AdminKpiData {
  const months = Array.from({ length: 12 }, (_, index) => metric(`${index + 1}月`));
  return {
    targetYear: 2026,
    monthlyYearOptions: [2026],
    monthlyKpiByYear: [{ year: 2026, metrics: months }],
    seasonalKpi: [metric('2026AW')],
    backlog: { total: 540000, orderCount: 7, asOf: '2026-11-09' },
    intakeBreakdown: BREAKDOWN,
    returnsThisMonth: { month: '2026-11', amount: 4000 },
    ...overrides,
  };
}

function renderKpi(data: AdminKpiData | null = kpiData()) {
  return render(<KpiSection data={data} isLoading={false} errorMessage={null} onRetry={() => undefined} />);
}

beforeEach(() => {
  // jsdom には structuredClone が無い（月次記録の読み込みが使う）
  globalThis.structuredClone ??= (value) => JSON.parse(JSON.stringify(value));
  // SingleSelect は文字の幅を測るために canvas の getContext を呼ぶ（jsdom は未実装で console.error を出す）
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mockClientFetch.mockReset().mockImplementation(async (url: string) => {
    if (String(url).includes('/targets')) {
      return { ok: true, status: 200, json: async () => ({ data: { currentSeason: '2026AW', seasons: ['2026AW'], definitions: [], values: {} } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { season: '2026AW', monthKeys: [], values: {} } }) };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('KpiSection の受注高', () => {
  it('FREQ-572-AC-01: 見出しと説明が「受注高」になり、売上の見出しは残らない', async () => {
    renderKpi();

    expect((await screen.findAllByText('受注高')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('期間内に支払いを受けた注文の額（出荷前の取り消しを引く）').length).toBeGreaterThan(0);
    expect(screen.queryByText('売上')).toBeNull();
    expect(screen.queryByText('期間内に売れた総額')).toBeNull();
  });

  it('FREQ-572-AC-05: 画面に「帳簿の売上高ではありません。申告には使いません」と、支払いの確認が帳簿に入るまで数えない旨が出る', async () => {
    renderKpi();

    const panel = await screen.findByRole('region', { name: '受注高の内訳' });
    expect(within(panel).getByText('受注高は帳簿の売上高ではありません。申告には使いません。')).toBeTruthy();
    expect(within(panel).getByText(/支払いの確認が帳簿に入るまで数えません/)).toBeTruthy();
    const link = within(panel).getByRole('link', { name: /帳簿との照らし合わせは会計の『照合』で見られます/ });
    expect(link.getAttribute('href')).toBe('/admin?tab=ACCOUNTING');
  });

  it('FREQ-572-AC-05: 受注残のカードに額と件数、返品の行に今の月の返品が出る', async () => {
    renderKpi();

    const panel = await screen.findByRole('region', { name: '受注高の内訳' });
    expect(within(panel).getByTestId('intake-backlog-total').textContent).toBe('¥540,000');
    expect(within(panel).getByTestId('intake-backlog-count').textContent).toContain('7件');
    expect(within(panel).getByTestId('intake-returns').textContent).toBe('¥4,000');
    expect(within(panel).getByText(/出荷後の返品は受注高から引かず/)).toBeTruthy();
  });

  it('FREQ-572-AC-05: 内訳に割引の前の商品の額・割引・出荷前の取り消し・受注高が出て、支払いの件数は取り消しを含むと書く', async () => {
    renderKpi();

    const panel = await screen.findByRole('region', { name: '受注高の内訳' });
    expect(within(panel).getByTestId('intake-subtotal').textContent).toBe('¥150,000');
    expect(within(panel).getByTestId('intake-discount').textContent).toBe('-¥10,000');
    expect(within(panel).getByTestId('intake-cancel').textContent).toBe('-¥20,000');
    expect(within(panel).getByTestId('intake-dispute').textContent).toBe('-¥2,000');
    expect(within(panel).getByTestId('intake-total').textContent).toBe('¥118,000');
    expect(within(panel).getByText('支払いの件数（取り消しを含む）')).toBeTruthy();
    expect(within(panel).getByTestId('intake-order-count').textContent).toBe('12件');
  });

  it('FREQ-572-AC-02: 内訳の合計が受注高に合わない時は画面が注意を出し、合う時は出さない', async () => {
    const { unmount } = renderKpi();
    await screen.findByRole('region', { name: '受注高の内訳' });
    expect(screen.queryByText(/内訳の合計が受注高と合いません/)).toBeNull();
    unmount();

    renderKpi(kpiData({ intakeBreakdown: { ...BREAKDOWN, breakdownOk: false } }));

    expect(await screen.findByText(/内訳の合計が受注高と合いません/)).toBeTruthy();
  });

  it('FREQ-572-AC-05: 受注高の読み取りが応答に無い時は内訳の枠を出さず、ほかの表示は変えない', async () => {
    renderKpi(kpiData({ backlog: undefined, intakeBreakdown: undefined, returnsThisMonth: undefined }));

    await waitFor(() => expect(screen.getAllByText('受注高').length).toBeGreaterThan(0));
    expect(screen.queryByRole('region', { name: '受注高の内訳' })).toBeNull();
  });

  it('FREQ-572-AC-01: 受注高の目標は今までと同じ鍵 sales の値を読む（鍵は変えない）', async () => {
    mockClientFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/targets')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { currentSeason: '2026AW', seasons: ['2026AW'], definitions: [], values: { sales: { '2026AW': '1000000' } } } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: { season: '2026AW', monthKeys: [], values: {} } }) };
    });

    renderKpi();

    expect((await screen.findAllByText('¥1,000,000')).length).toBeGreaterThan(0);
  });
});
