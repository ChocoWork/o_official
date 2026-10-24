import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import type { PublicNewsArticle } from '@/features/news/types';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams('category=EVENT'),
}));

function makeArticles(count: number): PublicNewsArticle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    title: `Article ${index + 1}`,
    published_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    category: index % 2 === 0 ? 'EVENT' : 'STORE',
    image_url: `news/${index + 1}.jpg`,
    content: `**Bold** summary [link](https://example.com) ${index + 1}`,
  }));
}

function viewAllWrapper(): HTMLElement {
  const button = screen.getByRole('link', { name: 'VIEW ALL NEWS' });
  const wrapper = button.parentElement;
  if (!wrapper) {
    throw new Error('VIEW ALL wrapper not found');
  }
  return wrapper;
}

describe('home NEWS section', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('SCR-NEWS-006 下線付きの見出し NEWS の下に、記事の題を h3 にしたカードを最大6件出す', () => {
    render(<PublicNewsGrid variant="home" articles={makeArticles(8)} totalCount={8} />);

    const section = document.querySelector('section#news');
    expect(section).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'NEWS' })).toBeInTheDocument();

    const titles = screen.getAllByRole('heading', { level: 3 });
    expect(titles.map((title) => title.textContent)).toEqual([
      'Article 1',
      'Article 2',
      'Article 3',
      'Article 4',
      'Article 5',
      'Article 6',
    ]);
  });

  it('SCR-NEWS-006 カードは公開日・分類・Markdown の印を外した概要を出し、分類を付けずに詳細へつなぐ', () => {
    render(<PublicNewsGrid variant="home" articles={makeArticles(1)} totalCount={1} />);

    const card = screen.getByRole('link', { name: /Article 1/ });
    expect(card).toHaveAttribute('href', '/news/1');
    expect(within(card).getByText('2026.09.01')).toHaveAttribute('datetime', '2026-09-01');
    expect(within(card).getByText('EVENT')).toBeInTheDocument();
    expect(within(card).getByText('Bold summary link 1')).toBeInTheDocument();
  });

  it('SCR-NEWS-006 総数が6件より多い時は VIEW ALL を出し、行き先を /news にする', () => {
    render(<PublicNewsGrid variant="home" articles={makeArticles(6)} totalCount={7} />);

    expect(screen.getByRole('link', { name: 'VIEW ALL NEWS' })).toHaveAttribute('href', '/news');
    expect(viewAllWrapper()).not.toHaveClass('hidden');
  });

  it('SCR-NEWS-006 総数がちょうど6件の時は VIEW ALL を隠す', () => {
    render(<PublicNewsGrid variant="home" articles={makeArticles(6)} totalCount={6} />);

    expect(viewAllWrapper()).toHaveClass('hidden');
  });

  it('SCR-NEWS-006 総数の取り出しに失敗して 0 になった時は VIEW ALL を隠す', () => {
    render(<PublicNewsGrid variant="home" articles={makeArticles(6)} totalCount={0} />);

    expect(viewAllWrapper()).toHaveClass('hidden');
  });

  it('SCR-NEWS-006 総数を渡さない時は VIEW ALL を隠さない', () => {
    render(<PublicNewsGrid variant="home" articles={makeArticles(2)} />);

    expect(screen.getByRole('link', { name: 'VIEW ALL NEWS' })).toHaveAttribute('href', '/news');
    expect(viewAllWrapper()).not.toHaveClass('hidden');
  });

  it('SCR-NEWS-006 記事が0件の時は「現在、公開されている記事はありません」を出す', () => {
    render(<PublicNewsGrid variant="home" articles={[]} totalCount={0} />);

    expect(screen.getByText('現在、公開されている記事はありません')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it('SCR-NEWS-006 記事を渡さない時は件数より1件多く取り出し、出すのは件数まで', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => makeArticles(7),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<PublicNewsGrid variant="home" />);

    await waitFor(() => {
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(6);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/news?limit=7', { cache: 'no-store' });
  });

  it('SCR-NEWS-006 自分で取り出して失敗した時は赤い文を出す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => [],
    }) as unknown as typeof fetch;

    render(<PublicNewsGrid variant="home" fetchLimit={3} />);

    const message = await screen.findByText('ニュースデータの取得に失敗しました');
    expect(message).toHaveClass('text-red-500');
    expect(global.fetch).toHaveBeenCalledWith('/api/news?limit=4', { cache: 'no-store' });
  });
});
