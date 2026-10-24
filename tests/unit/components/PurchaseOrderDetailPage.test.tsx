import { render, screen } from '@testing-library/react';
import PurchaseOrderDetailPage from '@/app/admin/purchase-orders/[id]/page';
import { clientFetch } from '@/lib/client-fetch';
import { PURCHASE_ORDER_CREATED_QUERY } from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, ORDER_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const NOTICE = '発注書 PO-20261025-0001 を作成しました。数量が確定するまで受け取りはできません。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function open(searchParams: Record<string, string | string[] | undefined>, id = ORDER_ID) {
  const element = await PurchaseOrderDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) });
  render(element);
  await screen.findByRole('heading', { level: 1, name: '発注書 PO-20261025-0001' });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({ purchaseOrder: confirmedDetail() }));
});

describe('/admin/purchase-orders/[id] の頁（作成の通知の引き継ぎ）', () => {
  test('FREQ-526-AC-01: 目印つきの URL（?created=1）で開くと、読み込んだ発注書の番号で通知を role=status で出す', async () => {
    const [key, value] = PURCHASE_ORDER_CREATED_QUERY.split('=');
    await open({ [key]: value });
    expect(screen.getByRole('status')).toHaveTextContent(NOTICE);
  });

  test('FREQ-526-AC-01: 目印が無い URL では通知を出さない', async () => {
    await open({});
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/を作成しました/)).not.toBeInTheDocument();
  });

  test.each([
    ['別の値', { created: '0' }], ['空', { created: '' }], ['複数', { created: ['1', '1'] }], ['別の名前', { other: '1' }],
  ])('FREQ-526-AC-01: 目印が正しくない（%s）時も通知を出さない', async (_name, searchParams) => {
    await open(searchParams);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-05: URL の id の発注書を読む（番号は URL に載せず、読んだ発注書の物を使う）', async () => {
    await open({ created: '1' });
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/purchase-orders/${ORDER_ID}`, { cache: 'no-store' });
  });

  test('FREQ-526-AC-05: 頁は main に部品を置き、頁全体を横に広げない（min-w-0）', async () => {
    await open({});
    const main = screen.getByRole('main');
    expect(main.className).toMatch(/min-w-0/);
    expect(main.className).toMatch(/max-w-/);
  });
});
