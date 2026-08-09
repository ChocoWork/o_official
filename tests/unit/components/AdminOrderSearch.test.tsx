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
  clientFetch: (...args: unknown[]) => clientFetchMock(...args),
}));
jest.mock('@/components/AdminSideNav', () => () => null);
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);
jest.mock('@/components/OrderSection', () => () => null);

describe('admin statutory order search', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    clientFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [],
        pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
      }),
    });
  });

  it('sends counterparty, amount and reference filters to the orders API', async () => {
    render(<AdminPage />);
    await waitFor(() => expect(clientFetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('取引先'), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.change(screen.getByLabelText('金額（下限）'), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText('金額（上限）'), {
      target: { value: '50000' },
    });
    fireEvent.change(screen.getByLabelText('注文・決済ID'), {
      target: { value: 'pi_123' },
    });

    await waitFor(() => {
      const requestedUrls = clientFetchMock.mock.calls.map(([url]) => String(url));
      expect(requestedUrls).toContainEqual(
        expect.stringMatching(
          /counterparty=buyer%40example\.com.*reference=pi_123.*amountMin=1000.*amountMax=50000|counterparty=buyer%40example\.com.*amountMin=1000.*amountMax=50000.*reference=pi_123/,
        ),
      );
    });
  });
});
