import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

const clientFetchMock = jest.fn();

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('tab=ORDER'),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    isLoggedIn: true,
    isAuthResolved: true,
    userRole: 'admin',
    isMfaVerified: true,
  }),
}));
jest.mock('@/lib/client-fetch', () => ({
  // 要対応・要確認はこの test の対象ではないので、未処理なしを返す。
  // 注文一覧の本文を返すと「読み込めませんでした」の alert が出て、返金のエラーの alert と重なる
  clientFetch: (...args: unknown[]) =>
    String(args[0]) === '/api/admin/order-attention'
      ? Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }),
        })
      : clientFetchMock(...args),
}));
jest.mock('@/components/AdminSideNav', () => () => null);
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);
jest.mock('@/components/OrderSection', () => ({
  __esModule: true,
  default: (props: {
    orders: Array<{ id: string; status: string }>;
    errorMessage?: string | null;
    noticeMessage?: string | null;
    onRefundOrder?: (id: string) => void;
  }) => (
    <section>
      <p data-testid="order-status">{props.orders[0]?.status ?? 'none'}</p>
      {props.errorMessage ? <p role="alert">{props.errorMessage}</p> : null}
      {props.noticeMessage ? <p role="status">{props.noticeMessage}</p> : null}
      <button type="button" onClick={() => props.onRefundOrder?.('order-1')}>返金</button>
    </section>
  ),
}));

const orderResponse = {
  data: [{
    id: 'order-1',
    customerName: 'Customer',
    customerEmail: 'buyer@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [],
    totalAmount: '¥10,000',
    status: '決済完了',
    canRefund: true,
  }],
  pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
};

describe('admin order refund flow', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the canonical paid state and refetches after an asynchronous refund is accepted', async () => {
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/refund') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            refundStatus: 'requires_action',
            orderStatus: 'paid',
          }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: async () => orderResponse });
    });

    render(<AdminPage />);
    await screen.findByText('決済完了');

    fireEvent.click(screen.getByRole('button', { name: '返金' }));

    expect(await screen.findByRole('status')).toHaveTextContent('返金処理を受け付けました');
    expect(screen.getByTestId('order-status')).toHaveTextContent('決済完了');
    await waitFor(() => {
      expect(clientFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/orders?'))).toHaveLength(2);
    });
  });

  it('shows a safe 409 response message from the server', async () => {
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/refund') && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: '注文の状態が変わったため返金できません。' }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: async () => orderResponse });
    });

    render(<AdminPage />);
    await screen.findByText('決済完了');
    fireEvent.click(screen.getByRole('button', { name: '返金' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('注文の状態が変わったため返金できません。');
  });
  it('shows the canonical cancelled state only after a succeeded full refund', async () => {
    let orderRequests = 0;
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/refund') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            refundStatus: 'succeeded',
            orderStatus: 'cancelled',
          }),
        });
      }

      if (String(url).startsWith('/api/admin/orders?')) {
        orderRequests += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ...orderResponse,
            data: [{
              ...orderResponse.data[0],
              status: orderRequests === 1 ? '決済完了' : 'キャンセル',
              canRefund: orderRequests === 1,
            }],
          }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: async () => orderResponse });
    });

    render(<AdminPage />);
    await screen.findByText('決済完了');
    fireEvent.click(screen.getByRole('button', { name: '返金' }));

    expect(await screen.findByRole('status')).toHaveTextContent('全額返金が完了し、注文をキャンセルしました。');
    expect(screen.getByTestId('order-status')).toHaveTextContent('キャンセル');
    expect(orderRequests).toBe(2);
  });

  it.each(['failed', 'canceled'] as const)(
    'treats a %s refund result as an error after refetching the canonical order',
    async (refundStatus) => {
      let orderRequests = 0;
      clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).endsWith('/refund') && init?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              refundStatus,
              orderStatus: 'paid',
            }),
          });
        }

        if (String(url).startsWith('/api/admin/orders?')) {
          orderRequests += 1;
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => orderResponse });
      });

      render(<AdminPage />);
      await screen.findByText('決済完了');
      fireEvent.click(screen.getByRole('button', { name: '返金' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('返金が完了しませんでした。');
      expect(screen.getByTestId('order-status')).toHaveTextContent('決済完了');
      expect(orderRequests).toBe(2);
    },
  );

});
