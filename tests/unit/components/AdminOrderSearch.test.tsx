import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminOrderItemListSection from '@/components/AdminOrderItemListSection';

/**
 * 旧い ORDER タブの検索（取引先・金額・注文/決済ID・期間）を、注文一覧表の絞り込み（G-4 Task 7）へ付け替えた単体。
 * 決済ID（pi_…）は注文IDの欄に入れ、窓口の orderNumber としてそのまま送る。金額の範囲と取引先の1欄は引き継がない
 * （設計 3-1 の絞り込みに無い。顧客名とメールアドレスの2欄に分けた）。
 */
const clientFetchMock = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, isAuthResolved: true, userRole: 'admin', isMfaVerified: true }),
}));
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) =>
    String(args[0]) === '/api/admin/order-attention'
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }) })
      : clientFetchMock(...args),
}));

const listUrls = () => clientFetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/order-items?'));

describe('admin order search (注文一覧表の絞り込み)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clientFetchMock.mockReset();
    clientFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { rows: [], totalRows: 0, totalOrders: 0, ordersCapped: false, ordersCap: 5000, page: 1, pageSize: 20, totalPages: 1 },
        returnAttention: { requested: 0, refundWaiting: 0 },
        cancelRequestAttention: 0,
      }),
    });
  });

  it('FREQ-536-AC-02: 顧客名・メールアドレス・注文ID（決済ID pi_…）・期間を、絞り込むを押した時に order-items の窓口へ送る', async () => {
    render(<AdminOrderItemListSection />);
    await waitFor(() => expect(listUrls()).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('顧客名'), { target: { value: 'yamada' } });
    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'buyer@example.com' } });
    fireEvent.change(screen.getByLabelText('注文ID'), { target: { value: 'pi_123' } });
    fireEvent.change(screen.getByLabelText('注文日（から）'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('注文日（まで）'), { target: { value: '2026-12-31' } });
    expect(listUrls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '絞り込む' }));

    await waitFor(() => expect(listUrls()).toHaveLength(2));
    const params = new URL(listUrls()[1], 'http://localhost').searchParams;
    expect(params.get('customer')).toBe('yamada');
    expect(params.get('email')).toBe('buyer@example.com');
    expect(params.get('orderNumber')).toBe('pi_123');
    expect(params.get('dateFrom')).toBe('2026-01-01');
    expect(params.get('dateTo')).toBe('2026-12-31');
    expect(listUrls()[1]).not.toMatch(/counterparty|reference|amountMin|amountMax|[?&]from=|[?&]to=/);
  });

  it('FREQ-536-AC-02: 旧い検索の取引先・金額（下限/上限）・注文・決済ID の欄は持たない', async () => {
    render(<AdminOrderItemListSection />);
    await waitFor(() => expect(listUrls()).toHaveLength(1));

    for (const label of ['取引先', '金額（下限）', '金額（上限）', '注文・決済ID']) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
  });
});
