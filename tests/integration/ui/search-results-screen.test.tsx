import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, within } from '@testing-library/react';
import { SearchPageClient } from '@/features/search/components/SearchPageClient';
import type {
  SearchResult,
  SearchResultType,
  SearchResultsResponse,
} from '@/features/search/types/search.types';

let currentQuery = '';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => {
    const params = new URLSearchParams(currentQuery);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

const fetchMock = jest.fn();

function makeResult(type: SearchResultType, id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    type,
    title: `${type} ${id}`,
    description: `${type} ${id} の説明`,
    href: `/${type}/${id}`,
    imageUrl: null,
    meta: `${type} meta ${id}`,
    ...overrides,
  };
}

function makeMany(type: SearchResultType, count: number): SearchResult[] {
  return Array.from({ length: count }, (_, index) => makeResult(type, String(index + 1)));
}

function payload(overrides: Partial<SearchResultsResponse> = {}): SearchResultsResponse {
  const items = overrides.items ?? [];
  const looks = overrides.looks ?? [];
  const news = overrides.news ?? [];
  return {
    query: '',
    tab: 'all',
    items,
    looks,
    news,
    counts: { all: items.length + looks.length + news.length, item: items.length, look: looks.length, news: news.length },
    popularItems: [],
    empty: false,
    ...overrides,
  };
}

function installFetch(body: SearchResultsResponse) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/api/suggest')) {
      return { ok: true, json: async () => ({ suggestions: [] }) };
    }
    return { ok: true, json: async () => body };
  });
}

const ui = () => <SearchPageClient />;

async function renderClient(query: string, body: SearchResultsResponse) {
  currentQuery = query;
  installFetch(body);
  const view = render(ui());
  await act(async () => {});
  return {
    ...view,
    changeUrl: async (nextQuery: string) => {
      currentQuery = nextQuery;
      view.rerender(ui());
      await act(async () => {});
    },
  };
}

function rows() {
  return screen.queryAllByTestId('search-result-row');
}

function rowTitles() {
  return rows().map((row) => row.querySelector('p.truncate')?.textContent ?? '');
}

beforeEach(() => {
  fetchMock.mockReset();
  currentQuery = '';
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('SCR-SEARCH-002 検索のページの右のカラム', () => {
  describe('見出しの行', () => {
    it('SCR-SEARCH-002 見出しの行は「{件数} RESULTS」だけを出す', async () => {
      await renderClient('q=coat', payload({ items: makeMany('item', 3) }));

      expect(screen.getByText('3 RESULTS')).toBeInTheDocument();
      expect(screen.queryByText('RELEVANCE')).not.toBeInTheDocument();
      expect(screen.queryByText(/SORT BY/i)).not.toBeInTheDocument();
    });

    it('SCR-SEARCH-002 ALL の件数は3種別を合わせた一覧の長さ', async () => {
      await renderClient(
        'q=coat',
        payload({ items: makeMany('item', 2), looks: makeMany('look', 1), news: makeMany('news', 3) }),
      );

      expect(screen.getByText('6 RESULTS')).toBeInTheDocument();
      expect(rows()).toHaveLength(6);
    });

    it('SCR-SEARCH-002 種別のタブでは選んだ種別の一覧の長さを件数にする', async () => {
      await renderClient(
        'q=coat&tab=look',
        payload({ items: makeMany('item', 2), looks: makeMany('look', 4), news: makeMany('news', 3) }),
      );

      expect(screen.getByText('4 RESULTS')).toBeInTheDocument();
      expect(rows()).toHaveLength(4);
    });

    it('SCR-SEARCH-002 見出しの行の字は md 未満が 2xs、md 以上が xs', async () => {
      await renderClient('q=coat', payload({ items: makeMany('item', 1) }));

      expect(screen.getByText('1 RESULTS')).toHaveClass(
        'text-(length:--lk-size-2xs)',
        'md:text-(length:--lk-size-xs)',
        'tracking-widest',
      );
    });
  });

  describe('結果の行', () => {
    it('SCR-SEARCH-002 行全体が href へのリンクで、種別の名前・題・メタ・右矢印を持つ', async () => {
      await renderClient(
        'q=jacket',
        payload({
          items: [makeResult('item', '7', { title: 'Wool jacket', meta: '¥38,000', href: '/item/7' })],
        }),
      );

      const row = rows()[0];
      const link = within(row).getByRole('link');
      expect(link).toHaveAttribute('href', '/item/7');
      expect(link).toHaveTextContent('ITEM');
      expect(link).toHaveTextContent('Wool jacket');
      expect(link).toHaveTextContent('¥38,000');
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(link.querySelector('svg path')).toHaveAttribute('d', 'M4 12h16M14 6l6 6-6 6');
    });

    it('SCR-SEARCH-002 行の間は黒10%の線で区切る', async () => {
      await renderClient('q=a', payload({ items: makeMany('item', 2) }));

      for (const row of rows()) {
        expect(row).toHaveClass('border-b', 'border-black/10');
      }
    });

    it.each([
      ['item', 'ITEM'],
      ['look', 'LOOK'],
      ['news', 'NEWS'],
    ] as const)('SCR-SEARCH-002 %s の行の種別の名前は %s と出し、メタは窓口の値をそのまま出す', async (type, label) => {
      const metaByType = { item: '¥12,000', look: '2026 AW', news: '2026.10.01' } as const;
      const list = [makeResult(type, '1', { meta: metaByType[type] })];
      await renderClient(
        `q=x&tab=${type}`,
        payload({ items: type === 'item' ? list : [], looks: type === 'look' ? list : [], news: type === 'news' ? list : [] }),
      );

      const row = rows()[0];
      expect(within(row).getByText(label)).toBeInTheDocument();
      expect(within(row).getByText(metaByType[type])).toBeInTheDocument();
    });

    it('SCR-SEARCH-002 画像があればサムネイルを alt 空で出し、無ければ #f5f5f5 の枠だけを出す', async () => {
      await renderClient(
        'q=a',
        payload({
          items: [
            makeResult('item', '1', { imageUrl: '/img/one.jpg' }),
            makeResult('item', '2', { imageUrl: null }),
          ],
        }),
      );

      const [withImage, withoutImage] = rows();
      const image = withImage.querySelector('img');
      expect(image).toHaveAttribute('src', '/img/one.jpg');
      expect(image).toHaveAttribute('alt', '');
      expect(withImage.querySelector('.aspect-3\\/4')).toHaveClass('w-14', 'bg-[#f5f5f5]');

      expect(withoutImage.querySelector('img')).toBeNull();
      expect(withoutImage.querySelector('.aspect-3\\/4')).toHaveClass('w-14', 'bg-[#f5f5f5]');
    });

    it('SCR-SEARCH-002 説明の文は行に出さない', async () => {
      await renderClient('q=coat', payload({ items: [makeResult('item', '1', { description: '説明の文はここに出ない' })] }));

      expect(screen.queryByText(/説明の文はここに出ない/)).not.toBeInTheDocument();
    });

    it('SCR-SEARCH-002 md 未満は種別の名前・題・メタを1段小さく、md 以上で従来の大きさにする', async () => {
      await renderClient('q=a', payload({ items: [makeResult('item', '1')] }));
      const row = rows()[0];

      expect(within(row).getByText('ITEM')).toHaveClass(
        'text-(length:--lk-size-3xs)',
        'md:text-(length:--lk-size-2xs)',
      );
      expect(within(row).getByText('item 1')).toHaveClass(
        'text-(length:--lk-size-sm)',
        'md:text-(length:--lk-size-md)',
        'truncate',
      );
      expect(within(row).getByText('item meta 1')).toHaveClass(
        'text-(length:--lk-size-2xs)',
        'md:text-(length:--lk-size-xs)',
      );
      expect(within(row).getByRole('link')).toHaveClass('py-3', 'md:py-4');
    });
  });

  describe('題の強調', () => {
    it('SCR-SEARCH-002 題の中で語に大文字小文字を区別せず合う所を mark で包む', async () => {
      await renderClient('q=coat', payload({ items: [makeResult('item', '1', { title: 'Wool COAT long Coat' })] }));

      const marks = within(rows()[0]).getAllByText(/coat/i, { selector: 'mark' });
      expect(marks.map((mark) => mark.textContent)).toEqual(['COAT', 'Coat']);
      expect(rowTitles()[0]).toBe('Wool COAT long Coat');
    });

    it('SCR-SEARCH-002 語の前後の空白を除いてから合わせる', async () => {
      await renderClient('q=%20coat%20', payload({ items: [makeResult('item', '1', { title: 'Wool coat' })] }));

      const mark = rows()[0].querySelector('mark');
      expect(mark).toHaveTextContent(/^coat$/);
    });

    it('SCR-SEARCH-002 空白で分けた1語ごとには強調しない（語全体に合う所だけ）', async () => {
      await renderClient(
        'q=wool%20coat',
        payload({
          items: [
            makeResult('item', '1', { title: 'Wool coat' }),
            makeResult('item', '2', { title: 'Wool scarf' }),
          ],
        }),
      );

      const [first, second] = rows();
      expect(first.querySelectorAll('mark')).toHaveLength(1);
      expect(first.querySelector('mark')).toHaveTextContent('Wool coat');
      expect(second.querySelectorAll('mark')).toHaveLength(0);
    });

    it('SCR-SEARCH-002 正規表現の記号は逃がしてから使うので、記号は文字として合う', async () => {
      await renderClient(
        `q=${encodeURIComponent('a.b')}`,
        payload({
          items: [
            makeResult('item', '1', { title: 'axb' }),
            makeResult('item', '2', { title: 'a.b' }),
          ],
        }),
      );

      const [first, second] = rows();
      expect(first.querySelectorAll('mark')).toHaveLength(0);
      expect(second.querySelector('mark')).toHaveTextContent('a.b');
    });

    it('SCR-SEARCH-002 閉じていない括弧の語でも画面が壊れず、合う所を強調する', async () => {
      await renderClient(
        `q=${encodeURIComponent('(x')}`,
        payload({ items: [makeResult('item', '1', { title: 'Look (x) one' })] }),
      );

      expect(rows()[0].querySelector('mark')).toHaveTextContent('(x');
      expect(rowTitles()[0]).toBe('Look (x) one');
    });

    it('SCR-SEARCH-002 強調するのは題だけで、メタは強調しない', async () => {
      await renderClient(
        'q=2026',
        payload({ looks: [makeResult('look', '1', { title: 'Look 2026', meta: '2026 AW' })] }),
      );

      const row = rows()[0];
      expect(row.querySelectorAll('mark')).toHaveLength(1);
      expect(within(row).getByText('2026 AW').querySelector('mark')).toBeNull();
    });
  });

  describe('ALL と種別のタブ', () => {
    const body = payload({
      items: [makeResult('item', 'i1'), makeResult('item', 'i2')],
      looks: [makeResult('look', 'l1')],
      news: [makeResult('news', 'n1'), makeResult('news', 'n2'), makeResult('news', 'n3')],
    });

    it('SCR-SEARCH-002 ALL は商品・ルック・ニュースの順に1件ずつ取り出して交互に並べる', async () => {
      await renderClient('q=a', body);

      expect(rowTitles()).toEqual(['item i1', 'look l1', 'news n1', 'item i2', 'news n2', 'news n3']);
    });

    it.each([
      ['item', ['item i1', 'item i2']],
      ['look', ['look l1']],
      ['news', ['news n1', 'news n2', 'news n3']],
    ] as const)('SCR-SEARCH-002 %s のタブはその種別の一覧だけを窓口の順に出す', async (tab, expected) => {
      await renderClient(`q=a&tab=${tab}`, body);

      expect(rowTitles()).toEqual(expected);
    });

    it('SCR-SEARCH-002 URL の tab が変わると同じ結果から一覧を組み直す', async () => {
      const view = await renderClient('q=a&tab=item', body);
      expect(rowTitles()).toEqual(['item i1', 'item i2']);

      await view.changeUrl('q=a&tab=news');
      expect(rowTitles()).toEqual(['news n1', 'news n2', 'news n3']);
    });
  });

  describe('LOAD MORE', () => {
    it('SCR-SEARCH-002 初めは8行を出し、一覧が8行より長い時だけ LOAD MORE を出す', async () => {
      await renderClient('q=a', payload({ items: makeMany('item', 12) }));

      expect(rows()).toHaveLength(8);
      expect(screen.getByText('12 RESULTS')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'LOAD MORE' })).toBeInTheDocument();
    });

    it('SCR-SEARCH-002 ちょうど8行なら LOAD MORE を出さない', async () => {
      await renderClient('q=a', payload({ items: makeMany('item', 8) }));

      expect(rows()).toHaveLength(8);
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
    });

    it('SCR-SEARCH-002 8行に満たなければ LOAD MORE を出さない', async () => {
      await renderClient('q=a', payload({ items: makeMany('item', 3) }));

      expect(rows()).toHaveLength(3);
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
    });

    it('SCR-SEARCH-002 押すごとに8行足し、全部出したら LOAD MORE を消す', async () => {
      await renderClient('q=a', payload({ items: makeMany('item', 20) }));

      await userEvent.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      expect(rows()).toHaveLength(16);
      expect(screen.getByRole('button', { name: 'LOAD MORE' })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      expect(rows()).toHaveLength(20);
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
    });

    it('SCR-SEARCH-002 語が変わったら8行に戻す', async () => {
      const view = await renderClient('q=a', payload({ items: makeMany('item', 20) }));
      await userEvent.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      expect(rows()).toHaveLength(16);

      await view.changeUrl('q=b');
      expect(rows()).toHaveLength(8);
    });

    it('SCR-SEARCH-002 タブが変わったら8行に戻す', async () => {
      const view = await renderClient(
        'q=a&tab=item',
        payload({ items: makeMany('item', 20), looks: makeMany('look', 20) }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      expect(rows()).toHaveLength(16);

      await view.changeUrl('q=a&tab=look');
      expect(rows()).toHaveLength(8);
    });

    it('SCR-SEARCH-002 LOAD MORE の字は md 未満が 2xs、md 以上が xs', async () => {
      await renderClient('q=a', payload({ items: makeMany('item', 9) }));

      expect(screen.getByRole('button', { name: 'LOAD MORE' })).toHaveClass(
        'text-(length:--lk-size-2xs)',
        'md:text-(length:--lk-size-xs)',
      );
    });
  });

  describe('人気商品と0件', () => {
    const popular = [
      makeResult('item', 'p1', { title: 'Popular coat', meta: '¥9,000', imageUrl: '/img/p1.jpg' }),
      makeResult('item', 'p2', { title: 'Popular scarf', meta: '¥4,000' }),
    ];

    it('SCR-SEARCH-002 語が無い時は POPULAR ITEMS の見出しと、結果の行と同じ形の人気商品を出す', async () => {
      await renderClient('', payload({ popularItems: popular }));

      expect(screen.getByText('POPULAR ITEMS')).toBeInTheDocument();
      expect(rows()).toHaveLength(2);
      expect(within(rows()[0]).getByRole('link')).toHaveAttribute('href', '/item/p1');
      expect(within(rows()[0]).getByText('ITEM')).toBeInTheDocument();
      expect(within(rows()[0]).getByText('¥9,000')).toBeInTheDocument();
      expect(rows()[0].querySelector('img')).toHaveAttribute('alt', '');
      expect(screen.queryByText(/RESULTS$/)).not.toBeInTheDocument();
    });

    it('SCR-SEARCH-002 人気商品の行は語を強調しない', async () => {
      await renderClient('', payload({ popularItems: popular }));

      expect(document.querySelectorAll('mark')).toHaveLength(0);
    });

    it('SCR-SEARCH-002 0件の時は題の下に「「語」の検索結果はありません」と案内文、POPULAR ITEMS の行を出す', async () => {
      await renderClient('q=zzz', payload({ empty: true, popularItems: popular }));

      expect(screen.getByRole('heading', { level: 2, name: '「zzz」の検索結果はありません' })).toBeInTheDocument();
      expect(
        screen.getByText('別のキーワードをお試しください。人気商品もあわせてご覧いただけます。'),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'POPULAR ITEMS' })).toBeInTheDocument();
      expect(rowTitles()).toEqual(['Popular coat', 'Popular scarf']);
      expect(screen.queryByText(/RESULTS$/)).not.toBeInTheDocument();
      expect(document.querySelectorAll('mark')).toHaveLength(0);
    });

    it('SCR-SEARCH-002 0件の人気商品が空なら行を出さず、題と案内文だけを出す', async () => {
      await renderClient('q=zzz', payload({ empty: true, popularItems: [] }));

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('「zzz」の検索結果はありません');
      expect(rows()).toHaveLength(0);
    });
  });

  describe('文字としての出力', () => {
    it('SCR-SEARCH-002 題・メタに入った HTML は要素にせず文字のまま出す', async () => {
      await renderClient(
        'q=a',
        payload({
          items: [
            makeResult('item', '1', {
              title: '<b>bold</b><img src=x onerror=alert(1)>',
              meta: '<script>alert(1)</script>',
            }),
          ],
        }),
      );

      const row = rows()[0];
      expect(row.querySelector('b')).toBeNull();
      expect(row.querySelector('script')).toBeNull();
      expect(row.querySelector('img')).toBeNull();
      expect(row).toHaveTextContent('<b>bold</b><img src=x onerror=alert(1)>');
      expect(row).toHaveTextContent('<script>alert(1)</script>');
    });

    it('SCR-SEARCH-002 URL の q に入った HTML は0件の題に文字として出す', async () => {
      const hostile = '<img src=x onerror=alert(1)>';
      await renderClient(`q=${encodeURIComponent(hostile)}`, payload({ empty: true }));

      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent(`「${hostile}」の検索結果はありません`);
      expect(heading.querySelector('img')).toBeNull();
    });

    it('SCR-SEARCH-002 題に入った HTML の中の語は mark で包んでも要素にはならない', async () => {
      await renderClient(
        'q=script',
        payload({ items: [makeResult('item', '1', { title: '<script>x</script>' })] }),
      );

      const row = rows()[0];
      expect(row.querySelector('script')).toBeNull();
      expect(row.querySelector('mark')).toHaveTextContent('script');
      expect(rowTitles()[0]).toBe('<script>x</script>');
    });
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
