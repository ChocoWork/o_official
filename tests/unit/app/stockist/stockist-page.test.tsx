import { render, screen } from '@testing-library/react';

jest.mock('@/features/stockist/services/public', () => ({
  getPublicStockists: jest.fn(),
}));

jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: jest.fn(
    (props: { variant: string; stockists: unknown[] }) => (
      <div
        data-testid="grid"
        data-variant={props.variant}
        data-count={props.stockists.length}
      />
    ),
  ),
}));

import StockistPage, { generateMetadata } from '@/app/stockist/page';
import { getPublicStockists } from '@/features/stockist/services/public';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';

const mockGetPublicStockists = getPublicStockists as jest.Mock;
const mockGrid = PublicStockistGrid as unknown as jest.Mock;

const TITLE = 'STOCKIST | Le Fil des Heures';
const DESCRIPTION =
  'Le Fil des Heures の取扱店舗一覧です。店舗名・住所・営業時間・定休日をご確認いただけます。';

const STOCKISTS = [
  { id: 1, name: 'A', address: '東京都港区', phone: '03-0000-0000', time: '11:00-19:00', holiday: '水' },
  { id: 2, name: 'B', address: '大阪府大阪市', phone: '06-0000-0000', time: '12:00-20:00', holiday: '木' },
];

describe('StockistPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublicStockists.mockResolvedValue([]);
  });

  it('DD-STOCKIST-001 メタ情報は固定の題・説明と OGP の題・説明・画像 /mainphoto.png を返す', async () => {
    const metadata = await generateMetadata();

    expect(metadata.title).toBe(TITLE);
    expect(metadata.description).toBe(DESCRIPTION);
    expect(metadata.openGraph).toEqual({
      title: TITLE,
      description: DESCRIPTION,
      images: ['/mainphoto.png'],
    });
  });

  it('DD-STOCKIST-001 searchParams の Promise を待ち、getPublicStockists を引数なしで1回呼ぶ', async () => {
    let awaited = false;
    const searchParams = new Promise<Record<string, string>>((resolve) => {
      resolve({ pref: '東京都' });
    }).then((value) => {
      awaited = true;
      return value;
    });

    await StockistPage({ searchParams });

    expect(awaited).toBe(true);
    expect(mockGetPublicStockists).toHaveBeenCalledTimes(1);
    expect(mockGetPublicStockists).toHaveBeenCalledWith();
  });

  it('DD-STOCKIST-001 取り出した2件を variant=catalog で部品に渡し、div.w-full に入れて描く', async () => {
    mockGetPublicStockists.mockResolvedValue(STOCKISTS);

    const element = await StockistPage({ searchParams: Promise.resolve({}) });
    const { container } = render(element);

    expect(mockGrid).toHaveBeenCalledTimes(1);
    expect(mockGrid.mock.calls[0][0]).toEqual({ variant: 'catalog', stockists: STOCKISTS });
    expect(screen.getByTestId('grid')).toHaveAttribute('data-variant', 'catalog');
    expect(screen.getByTestId('grid')).toHaveAttribute('data-count', '2');
    expect(container.firstElementChild).toHaveClass('w-full');
    expect(container.firstElementChild?.tagName).toBe('DIV');
  });

  it('DD-STOCKIST-001 searchParams が無くても例外にならず部品が描かれる', async () => {
    const element = await StockistPage({});
    render(element);

    expect(mockGetPublicStockists).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('grid')).toBeInTheDocument();
  });

  it('DD-STOCKIST-001 取り出しが空の配列なら部品に空の配列が渡る', async () => {
    mockGetPublicStockists.mockResolvedValue([]);

    const element = await StockistPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(mockGrid.mock.calls[0][0].stockists).toEqual([]);
    expect(screen.getByTestId('grid')).toHaveAttribute('data-count', '0');
  });

  it('DD-STOCKIST-001 取り出しが例外を投げたらページも受け止めず例外を出す', async () => {
    mockGetPublicStockists.mockRejectedValue(new Error('client unavailable'));

    await expect(StockistPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'client unavailable',
    );
  });
});
