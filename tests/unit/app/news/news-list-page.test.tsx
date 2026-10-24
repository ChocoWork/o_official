import { render, screen } from '@testing-library/react';

jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn(),
}));

jest.mock('@/features/news/components/PublicNewsGrid', () => ({
  PublicNewsGrid: jest.fn(
    (props: { variant: string; articles: unknown[]; initialCategory: string }) => (
      <div
        data-testid="grid"
        data-variant={props.variant}
        data-count={props.articles.length}
        data-category={props.initialCategory}
      />
    ),
  ),
}));

import NewsPage, { generateMetadata } from '@/app/news/page';
import { getPublishedNews } from '@/features/news/services/public';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';

const mockGetPublishedNews = getPublishedNews as jest.Mock;
const mockGrid = PublicNewsGrid as unknown as jest.Mock;

const ARTICLES = [
  { id: '1', title: 'A', category: 'EVENT' },
  { id: '2', title: 'B', category: 'EVENT' },
];

async function renderPage(searchParams?: Promise<{ category?: string }>) {
  const element = await NewsPage(searchParams === undefined ? {} : { searchParams });
  return render(element);
}

describe('NewsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublishedNews.mockResolvedValue([]);
  });

  it('DD-NEWS-002 searchParams が無ければ ALL で取り出し、部品に ALL を渡す', async () => {
    await renderPage();

    expect(mockGetPublishedNews).toHaveBeenCalledTimes(1);
    expect(mockGetPublishedNews).toHaveBeenCalledWith({ category: 'ALL' });
    expect(screen.getByTestId('grid')).toHaveAttribute('data-category', 'ALL');
  });

  it('DD-NEWS-002 category が無ければ ALL で取り出す', async () => {
    await renderPage(Promise.resolve({}));

    expect(mockGetPublishedNews).toHaveBeenCalledWith({ category: 'ALL' });
    expect(screen.getByTestId('grid')).toHaveAttribute('data-category', 'ALL');
  });

  it('DD-NEWS-002 小文字の正しい分類は大文字に直して取り出す', async () => {
    await renderPage(Promise.resolve({ category: 'event' }));

    expect(mockGetPublishedNews).toHaveBeenCalledWith({ category: 'EVENT' });
    expect(screen.getByTestId('grid')).toHaveAttribute('data-category', 'EVENT');
  });

  it.each(['FOO', 'EVENT,STORE', ' EVENT'])(
    'DD-NEWS-002 分類の一覧に無い値 "%s" は ALL で取り出す',
    async (category) => {
      await renderPage(Promise.resolve({ category }));

      expect(mockGetPublishedNews).toHaveBeenCalledWith({ category: 'ALL' });
      expect(screen.getByTestId('grid')).toHaveAttribute('data-category', 'ALL');
    },
  );

  it('DD-NEWS-002 BLOG は一覧にあるので BLOG で取り出す', async () => {
    await renderPage(Promise.resolve({ category: 'BLOG' }));

    expect(mockGetPublishedNews).toHaveBeenCalledWith({ category: 'BLOG' });
  });

  it('DD-NEWS-002 取り出した記事と直した分類を catalog の部品へ渡し、h1 を置かない', async () => {
    mockGetPublishedNews.mockResolvedValue(ARTICLES);

    const { container } = await renderPage(Promise.resolve({ category: 'event' }));

    expect(mockGrid).toHaveBeenCalledTimes(1);
    expect(mockGrid.mock.calls[0][0]).toEqual({
      variant: 'catalog',
      articles: ARTICLES,
      initialCategory: 'EVENT',
    });
    expect(container.firstElementChild).toHaveClass('w-full');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('DD-NEWS-002 取り出しが例外ならページの関数が reject する', async () => {
    const error = new Error('service role key missing');
    mockGetPublishedNews.mockRejectedValue(error);

    await expect(NewsPage({ searchParams: Promise.resolve({}) })).rejects.toBe(error);
  });

  it('DD-NEWS-002 メタは固定の title と description を返す', async () => {
    await expect(generateMetadata()).resolves.toEqual({
      title: 'NEWS | Le Fil des Heures',
      description:
        'Le Fil des Heuresの最新ニュース一覧。コレクション、イベント、コラボレーション、サステナビリティ、ストア情報を掲載。',
    });
  });
});
