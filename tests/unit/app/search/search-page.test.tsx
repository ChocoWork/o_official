import { render, screen } from '@testing-library/react';

const mockSearchPageClient = jest.fn();

jest.mock('@/features/search/components/SearchPageClient', () => ({
  SearchPageClient: () => mockSearchPageClient(),
}));

import SearchPage, { generateMetadata } from '@/app/search/page';

describe('SearchPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchPageClient.mockReturnValue(<div data-testid="search-client" />);
  });

  it('DD-SEARCH-001 メタが検索語に左右されない固定の title・description・og を返す', async () => {
    const metadata = await generateMetadata();

    const title = 'Search | Le Fil des Heures';
    const description =
      'Le Fil des Heures の商品・ルック・ニュースを横断検索できるページです。';
    expect(metadata).toEqual({
      title,
      description,
      openGraph: { title, description, images: ['/mainphoto.png'] },
    });
  });

  it('DD-SEARCH-001 canonical と robots を返さない', async () => {
    const metadata = await generateMetadata();

    expect(metadata.alternates).toBeUndefined();
    expect(metadata.robots).toBeUndefined();
  });

  it('DD-SEARCH-001 頁の関数が SearchPageClient を殻の中に描く', () => {
    render(<SearchPage />);

    expect(screen.getByTestId('search-client')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-SEARCH-001 SearchPageClient が待たせる間は「読み込み中...」の p を出す', () => {
    mockSearchPageClient.mockImplementation(() => {
      throw new Promise<void>(() => undefined);
    });

    render(<SearchPage />);

    const fallback = screen.getByText('読み込み中...');
    expect(fallback.tagName).toBe('P');
    expect(screen.queryByTestId('search-client')).not.toBeInTheDocument();
  });
});
