import { render, screen } from '@testing-library/react';
import PurchaseOrderListPage from '@/app/admin/purchase-orders/page';
import { clientFetch } from '@/lib/client-fetch';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

test('FREQ-526-AC-04: /admin/purchase-orders の頁は main に発注一覧表を置き、頁全体を横に広げない（min-w-0）', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ rows: [], total: 0, page: 1, limit: 20 }) } as Response);
  render(<PurchaseOrderListPage />);
  expect(await screen.findByText('発注書はまだありません。')).toBeInTheDocument();
  const main = screen.getByRole('main');
  expect(main.className).toMatch(/min-w-0/);
  expect(main).toContainElement(screen.getByRole('heading', { level: 1, name: '発注一覧表' }));
});
