import { render, screen, within } from '@testing-library/react';
import { ItemStockSection } from '@/app/admin/item/ItemStockSection';
import { clientFetch } from '@/lib/client-fetch';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));

const mockedFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const EXPLANATION =
  'すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function screenTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

const VARIANT = {
  id: 11,
  colorName: 'BLACK',
  colorHex: '#000000',
  sizeLabel: 'M',
  sku: null,
  stockQuantity: 4,
  isActive: true,
  committedQuantity: 3,
  onHandQuantity: 7,
  backorderQuantity: 2,
};

// 注文で1点売れた行（記録した人は無い）
const PURCHASE = {
  id: 9,
  variantId: 11,
  delta: -1,
  reason: 'purchase',
  note: null,
  createdAt: '2026-09-22T01:30:00.000Z',
  actorEmail: null,
  orderId: 'a1b2c3d4-1111-4222-8333-444455556666',
  orderNumber: 'ORD-A1B2C3D4',
  balanceAfter: 4,
};

// 管理者が4点入荷した行（注文は無い）
const RESTOCK = {
  id: 5,
  variantId: 11,
  delta: 4,
  reason: 'restock',
  note: '初回入荷',
  createdAt: '2026-09-21T01:00:00.000Z',
  actorEmail: 'admin@example.com',
  orderId: null,
  orderNumber: null,
  balanceAfter: 5,
};

async function renderLoaded(options: { variants?: unknown[]; movements?: unknown[] } = {}) {
  mockedFetch.mockResolvedValue(
    json({
      variants: options.variants ?? [VARIANT],
      movements: options.movements ?? [PURCHASE, RESTOCK],
    }),
  );
  render(<ItemStockSection itemId="7" />);
  await screen.findByRole('heading', { name: '履歴' });
}

describe('ItemStockSection の4つの数と履歴（グループ E-1）', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('色・サイズごとに、すぐ出せる数・引き当て済み・手元の数・受注生産の4つを出す', async () => {
    await renderLoaded();

    expect(mockedFetch).toHaveBeenCalledWith('/api/admin/items/7/variants');
    const row = screen.getByTestId('variant-row-11');
    expect(within(row).getByText('すぐ出せる数')).toBeInTheDocument();
    expect(within(row).getByText('引き当て済み')).toBeInTheDocument();
    expect(within(row).getByText('手元の数')).toBeInTheDocument();
    expect(within(row).getByText('受注生産')).toBeInTheDocument();
    expect(within(row).getByTestId('variant-stock')).toHaveTextContent(/^4$/);
    expect(within(row).getByTestId('variant-committed')).toHaveTextContent(/^3$/);
    expect(within(row).getByTestId('variant-on-hand')).toHaveTextContent(/^7$/);
    expect(within(row).getByTestId('variant-backorder')).toHaveTextContent(/^2$/);
  });

  it('4つの言葉の説明を、色・サイズが複数あっても画面に1回だけ書く', async () => {
    await renderLoaded({ variants: [VARIANT, { ...VARIANT, id: 12, sizeLabel: 'L' }] });

    expect(screen.getAllByText(EXPLANATION)).toHaveLength(1);
    expect(screen.getByTestId('stock-terms-explanation')).toHaveTextContent(EXPLANATION);
  });

  it('履歴は日時・色とサイズ・理由・増減・変わった後の数・記録した人・注文番号・備考を出す', async () => {
    await renderLoaded();

    const rows = screen.getAllByTestId('stock-movement-row');
    expect(rows).toHaveLength(2);
    const [purchase, restock] = rows;

    expect(within(purchase).getByTestId('stock-movement-time')).toHaveTextContent(screenTime(PURCHASE.createdAt));
    expect(within(purchase).getByTestId('stock-movement-variant')).toHaveTextContent('BLACK / M');
    expect(within(purchase).getByTestId('stock-movement-reason')).toHaveTextContent('販売');
    expect(within(purchase).getByTestId('stock-movement-delta')).toHaveTextContent(/^-1$/);
    expect(within(purchase).getByTestId('stock-movement-balance')).toHaveTextContent('変わった後 4');
    expect(within(purchase).getByTestId('stock-movement-order')).toHaveTextContent('ORD-A1B2C3D4');

    expect(within(restock).getByTestId('stock-movement-time')).toHaveTextContent(screenTime(RESTOCK.createdAt));
    expect(within(restock).getByTestId('stock-movement-reason')).toHaveTextContent('入荷');
    expect(within(restock).getByTestId('stock-movement-delta')).toHaveTextContent(/^\+4$/);
    expect(within(restock).getByTestId('stock-movement-balance')).toHaveTextContent('変わった後 5');
    expect(within(restock).getByTestId('stock-movement-actor')).toHaveTextContent('admin@example.com');
    expect(within(restock).getByTestId('stock-movement-note')).toHaveTextContent('初回入荷');
  });

  it('記録した人が空の行は「自動」と出し、注文の無い行には注文番号を出さない', async () => {
    await renderLoaded();

    const [purchase, restock] = screen.getAllByTestId('stock-movement-row');
    expect(within(purchase).getByTestId('stock-movement-actor')).toHaveTextContent(/^自動$/);
    expect(within(restock).queryByTestId('stock-movement-order')).not.toBeInTheDocument();
  });

  it('履歴が空なら案内を出す', async () => {
    await renderLoaded({ movements: [] });

    expect(screen.getByText('まだ記録がありません。')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stock-movement-row')).toHaveLength(0);
  });
});
