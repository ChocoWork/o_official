import React, { Profiler } from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import type { PublicNewsArticle } from '@/features/news/types';

const pushMock = jest.fn();
let mockQueryString = '';

type CapturedMultiSelectProps = {
  values: string[];
  onChange: (values: string[]) => void;
};
const mockMultiSelect: { last: CapturedMultiSelectProps | null } = { last: null };

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  usePathname: () => '/news',
  useRouter: () => ({
    push: (...args: unknown[]) => pushMock(...args),
  }),
  useSearchParams: () => {
    const params = new URLSearchParams(mockQueryString);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

// 本物の MultiSelect を描きつつ、最後に受けた props を控えて onChange を直接呼べるようにする
jest.mock('@/components/ui/MultiSelect/MultiSelect', () => {
  const ReactActual = jest.requireActual('react');
  const actual = jest.requireActual('@/components/ui/MultiSelect/MultiSelect');
  return {
    MultiSelect: (props: CapturedMultiSelectProps) => {
      mockMultiSelect.last = props;
      return ReactActual.createElement(actual.MultiSelect, props);
    },
  };
});

const CATEGORIES = ['ALL', 'COLLECTION', 'EVENT', 'COLLABORATION', 'SUSTAINABILITY', 'STORE', 'BLOG'];

function setQuery(params: Record<string, string>): void {
  mockQueryString = new URLSearchParams(params).toString();
}

function makeArticle(id: string, overrides: Partial<PublicNewsArticle> = {}): PublicNewsArticle {
  return {
    id,
    title: `記事${id}`,
    published_date: '2025-01-01',
    category: 'EVENT',
    image_url: `/news-${id}.jpg`,
    content: `本文${id}`,
    ...overrides,
  };
}

const mixedArticles: PublicNewsArticle[] = [
  makeArticle('1', { category: 'EVENT' }),
  makeArticle('2', { category: 'STORE' }),
  makeArticle('3', { category: 'COLLECTION' }),
];

function shownTitles(): string[] {
  return Array.from(document.querySelectorAll('article')).map(
    (article) => article.querySelector('h2, h3')?.textContent ?? '',
  );
}

function checkedCategories(): string[] {
  return CATEGORIES.filter(
    (category) => (screen.getByRole('checkbox', { name: category }) as HTMLInputElement).checked,
  );
}

function callMultiSelect(values: string[]): void {
  const props = mockMultiSelect.last;
  if (!props) {
    throw new Error('MultiSelect not rendered');
  }
  act(() => {
    props.onChange(values);
  });
}

function viewAllWrapper(): HTMLElement {
  const button = screen.getByTestId('home-section-view-all');
  const wrapper = button.parentElement;
  if (!wrapper) {
    throw new Error('VIEW ALL wrapper not found');
  }
  return wrapper;
}

function mockFetchResolved(response: { ok: boolean; json?: () => Promise<unknown> }): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue(response);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryString = '';
  mockMultiSelect.last = null;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('PublicNewsGrid catalog filter drawer', () => {
  test('DD-NEWS-001 renders a filter button and opens a left drawer with the panel multi-select', async () => {
    const user = userEvent.setup();

    render(
      <PublicNewsGrid
        variant="catalog"
        initialCategory="ALL"
        articles={[
          {
            id: '1',
            title: 'First article',
            published_date: '2025-01-01',
            category: 'SUSTAINABILITY',
            image_url: '/news-1.jpg',
            content: 'First content',
          },
          {
            id: '2',
            title: 'Second article',
            published_date: '2025-01-02',
            category: 'COLLABORATION',
            image_url: '/news-2.jpg',
            content: 'Second content',
          },
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: 'FILTER' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'FILTER' }));

    // ドロワー内の FILTER 見出しは廃止され、閉じるボタンだけが残っている。
    // 属性契約でドロワー本体を特定する。
    await waitFor(() => {
      expect(document.querySelector('[data-ui-drawer]')).toBeInTheDocument();
    });

    const drawer = document.querySelector<HTMLElement>('[data-ui-drawer]');

    if (!drawer) {
      throw new Error('Filter drawer not found');
    }

    expect(drawer).toHaveAttribute('data-ui-drawer-side', 'left');
    expect(within(drawer).getByRole('button', { name: 'Close filter drawer' })).toBeInTheDocument();

    expect(within(drawer).getByRole('checkbox', { name: 'ALL' })).toBeInTheDocument();
    expect(within(drawer).getByRole('checkbox', { name: 'COLLABORATION' })).toBeInTheDocument();
  });

  test('DD-NEWS-001 FILTER で開いた引き出しは閉じるボタンと背景の押下で閉じる', async () => {
    const user = userEvent.setup();
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    const filterButton = screen.getByRole('button', { name: 'FILTER' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    expect(filterButton).toHaveAttribute('aria-haspopup', 'dialog');

    await user.click(filterButton);
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Close filter drawer' }));
    expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(filterButton);
    const overlay = document.querySelector<HTMLElement>('[data-ui-drawer]');
    if (!overlay) {
      throw new Error('Filter drawer not found');
    }
    fireEvent.click(overlay);
    expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();
  });

  test('DD-NEWS-001 場所取りの FILTER のバーは隠され、押しても引き出しを開かない', () => {
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    const placeholderBar = document.querySelector<HTMLElement>('[data-filter-bar="placeholder"]');
    const placeholderButton = document.querySelector<HTMLElement>('[data-filter-button="placeholder"]');
    expect(placeholderBar).toHaveAttribute('aria-hidden', 'true');
    expect(placeholderBar).toHaveClass('pointer-events-none', 'invisible');
    expect(placeholderButton).toHaveAttribute('tabindex', '-1');
    expect(placeholderButton).not.toHaveAttribute('aria-haspopup');
    expect(placeholderButton).not.toHaveAttribute('aria-expanded');

    const floatingBar = document.querySelector<HTMLElement>('[data-filter-bar="floating"]');
    expect(floatingBar).not.toHaveAttribute('aria-hidden');
    expect(floatingBar).not.toHaveClass('invisible');

    if (!placeholderButton) {
      throw new Error('placeholder button not found');
    }
    fireEvent.click(placeholderButton);
    expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();
  });
});

describe('PublicNewsGrid 初めの選択と URL の読み取り', () => {
  test('DD-NEWS-001 URL も初めの値も無ければ ALL が選ばれ全部の記事が出る', () => {
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    expect(checkedCategories()).toEqual(['ALL']);
    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3']);
  });

  test('DD-NEWS-001 URL が無く初めの値が EVENT なら EVENT の記事だけが出る', () => {
    render(<PublicNewsGrid variant="catalog" initialCategory="EVENT" articles={mixedArticles} />);

    expect(checkedCategories()).toEqual(['EVENT']);
    expect(shownTitles()).toEqual(['記事1']);
  });

  test('DD-NEWS-001 URL の category が空白だけなら初めの値が選ばれる', () => {
    setQuery({ category: '   ' });
    render(<PublicNewsGrid variant="catalog" initialCategory="STORE" articles={mixedArticles} />);

    expect(checkedCategories()).toEqual(['STORE']);
    expect(shownTitles()).toEqual(['記事2']);
  });

  test('DD-NEWS-001 URL の小文字と前後の空白を読み替えて EVENT と STORE を選ぶ', () => {
    setQuery({ category: ' event , store ' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    expect(checkedCategories()).toEqual(['EVENT', 'STORE']);
    expect(shownTitles()).toEqual(['記事1', '記事2']);
  });

  test('DD-NEWS-001 URL に正しくない値しか無ければ初めの値ではなく ALL になる', () => {
    setQuery({ category: 'FOO' });
    render(<PublicNewsGrid variant="catalog" initialCategory="EVENT" articles={mixedArticles} />);

    expect(checkedCategories()).toEqual(['ALL']);
    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3']);
  });

  test('DD-NEWS-001 URL に ALL を含めば ALL だけになる', () => {
    setQuery({ category: 'EVENT,ALL' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    expect(checkedCategories()).toEqual(['ALL']);
    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3']);
  });

  test('DD-NEWS-001 URL の重複した分類は1つにまとめる', () => {
    setQuery({ category: 'EVENT,EVENT' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    expect(mockMultiSelect.last?.values).toEqual(['EVENT']);
    expect(shownTitles()).toEqual(['記事1']);
  });

  test('DD-NEWS-001 home は URL の category を読まず全部の記事を出す', () => {
    setQuery({ category: 'EVENT' });
    render(<PublicNewsGrid variant="home" articles={mixedArticles} />);

    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3']);
    expect(document.querySelector('[data-ui-multiselect]')).not.toBeInTheDocument();
  });
});

describe('PublicNewsGrid URL が変わった時の選択の合わせ', () => {
  function renderWithProfiler(onRender: jest.Mock) {
    const ui = () => (
      <Profiler id="grid" onRender={onRender}>
        <PublicNewsGrid variant="catalog" articles={mixedArticles} />
      </Profiler>
    );
    const result = render(ui());
    return { rerender: () => result.rerender(ui()) };
  }

  test('DD-NEWS-001 描いた後に URL の category が STORE に変わると STORE が選ばれる', () => {
    setQuery({ category: 'EVENT' });
    const onRender = jest.fn();
    const { rerender } = renderWithProfiler(onRender);
    expect(checkedCategories()).toEqual(['EVENT']);

    const commitsBefore = onRender.mock.calls.length;
    setQuery({ category: 'STORE' });
    rerender();

    expect(checkedCategories()).toEqual(['STORE']);
    expect(shownTitles()).toEqual(['記事2']);
    // 描き直し1回と、effect が選択を差し替えた分の1回
    expect(onRender.mock.calls.length - commitsBefore).toBe(2);
  });

  test('DD-NEWS-001 URL が同じ選択のままなら選択の配列を差し替えず描き直しも増えない', () => {
    setQuery({ category: 'EVENT' });
    const onRender = jest.fn();
    const { rerender } = renderWithProfiler(onRender);
    const valuesBefore = mockMultiSelect.last?.values;

    const commitsBefore = onRender.mock.calls.length;
    rerender();

    expect(onRender.mock.calls.length - commitsBefore).toBe(1);
    expect(mockMultiSelect.last?.values).toBe(valuesBefore);
    expect(checkedCategories()).toEqual(['EVENT']);
  });

  test('DD-NEWS-001 URL の分類の数が変わった時も中身だけが変わった時も選択が変わる', () => {
    setQuery({ category: 'EVENT' });
    const onRender = jest.fn();
    const { rerender } = renderWithProfiler(onRender);

    setQuery({ category: 'EVENT,STORE' });
    rerender();
    expect(checkedCategories()).toEqual(['EVENT', 'STORE']);

    setQuery({ category: 'EVENT,COLLECTION' });
    rerender();
    expect(checkedCategories()).toEqual(['COLLECTION', 'EVENT']);
    expect(mockMultiSelect.last?.values).toEqual(['EVENT', 'COLLECTION']);
  });
});

describe('PublicNewsGrid 選択の操作と URL への書き戻し', () => {
  test('DD-NEWS-001 全部を外すと ALL に戻り category の無い URL へ移る', async () => {
    const user = userEvent.setup();
    setQuery({ category: 'EVENT' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    await user.click(screen.getByRole('checkbox', { name: 'EVENT' }));

    expect(checkedCategories()).toEqual(['ALL']);
    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3']);
    expect(pushMock).toHaveBeenCalledWith('/news', { scroll: false });
  });

  test('DD-NEWS-001 ALL の外から ALL を足すと ALL だけになり category を消す', async () => {
    const user = userEvent.setup();
    setQuery({ category: 'EVENT' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    await user.click(screen.getByRole('checkbox', { name: 'ALL' }));

    expect(checkedCategories()).toEqual(['ALL']);
    expect(pushMock).toHaveBeenCalledWith('/news', { scroll: false });
  });

  test('DD-NEWS-001 ALL の時にほかを足すと ALL を外してそれだけを選ぶ', async () => {
    const user = userEvent.setup();
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    await user.click(screen.getByRole('checkbox', { name: 'EVENT' }));

    expect(checkedCategories()).toEqual(['EVENT']);
    expect(shownTitles()).toEqual(['記事1']);
    expect(pushMock).toHaveBeenCalledWith('/news?category=EVENT', { scroll: false });
  });

  test('DD-NEWS-001 個別の選択に足すと受けた値のままカンマで結んで URL に書く', async () => {
    const user = userEvent.setup();
    setQuery({ category: 'EVENT' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    await user.click(screen.getByRole('checkbox', { name: 'STORE' }));

    expect(checkedCategories()).toEqual(['EVENT', 'STORE']);
    expect(shownTitles()).toEqual(['記事1', '記事2']);
    expect(pushMock).toHaveBeenCalledWith('/news?category=EVENT%2CSTORE', { scroll: false });
  });

  test('DD-NEWS-001 ALL の時に1つだけ受けるとその値を選ぶ', () => {
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    callMultiSelect(['EVENT']);

    expect(checkedCategories()).toEqual(['EVENT']);
    expect(pushMock).toHaveBeenCalledWith('/news?category=EVENT', { scroll: false });
  });

  test('DD-NEWS-001 ほかのクエリを残して category を足す', async () => {
    const user = userEvent.setup();
    setQuery({ foo: '1' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    await user.click(screen.getByRole('checkbox', { name: 'EVENT' }));

    expect(pushMock).toHaveBeenCalledWith('/news?foo=1&category=EVENT', { scroll: false });
  });

  test('DD-NEWS-001 ほかのクエリがあれば ALL に戻しても pathname だけにはしない', () => {
    setQuery({ foo: '1', category: 'EVENT' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    callMultiSelect([]);

    expect(pushMock).toHaveBeenCalledWith('/news?foo=1', { scroll: false });
  });
});

describe('PublicNewsGrid カードのリンクと中身', () => {
  test('DD-NEWS-001 buildHref を渡せばその値をリンクにする', () => {
    setQuery({ category: 'EVENT' });
    const buildHref = jest.fn((article: PublicNewsArticle) => `/custom/${article.id}`);
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} buildHref={buildHref} />);

    expect(screen.getByRole('link', { name: /記事1/ })).toHaveAttribute('href', '/custom/1');
    expect(buildHref).toHaveBeenCalledWith(mixedArticles[0]);
  });

  test('DD-NEWS-001 個別の分類を選んでいれば詳細のリンクに category を付ける', () => {
    setQuery({ category: 'EVENT,STORE' });
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    expect(screen.getByRole('link', { name: /記事1/ })).toHaveAttribute(
      'href',
      '/news/1?category=EVENT%2CSTORE',
    );
  });

  test('DD-NEWS-001 ALL を選んでいれば詳細のリンクに category を付けない', () => {
    render(<PublicNewsGrid variant="catalog" articles={mixedArticles} />);

    expect(screen.getByRole('link', { name: /記事1/ })).toHaveAttribute('href', '/news/1');
  });

  test('DD-NEWS-001 home のカードは詳細へそのままリンクする', () => {
    render(<PublicNewsGrid variant="home" articles={mixedArticles} />);

    expect(screen.getByRole('link', { name: /記事1/ })).toHaveAttribute('href', '/news/1');
  });

  test('DD-NEWS-001 カードに公開日・分類・Markdown の印を外した概要を出し画像を出さない', () => {
    render(
      <PublicNewsGrid
        variant="catalog"
        articles={[
          makeArticle('1', {
            published_date: '2025-01-02',
            category: 'COLLECTION',
            content: '**新作** の [案内](https://example.com)',
          }),
        ]}
      />,
    );

    const card = document.querySelector('article');
    if (!card) {
      throw new Error('card not found');
    }
    const time = within(card).getByText('2025.01.02');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', '2025-01-02');
    expect(within(card).getByText('COLLECTION').closest('[data-ui-tag-label]')).not.toBeNull();
    expect(within(card).getByText('新作 の 案内')).toBeInTheDocument();
    expect(card.querySelector('img')).toBeNull();
  });

  test('DD-NEWS-001 概要から画像・リンク・コード・見出し・引用・箇条書き・太字・斜体の印と続く空白を外す', () => {
    const content = [
      '# 見出し',
      '> 引用',
      '- 箇条',
      '![図](a.png)画像の後 [リンク](https://example.com) `code` ```block```',
      '**太字** __太字2__ *斜体* _斜体2_   空白',
    ].join('\n');
    render(<PublicNewsGrid variant="catalog" articles={[makeArticle('1', { content })]} />);

    const preview = document.querySelector('article p');
    expect(preview?.textContent).toBe(
      '見出し\n引用\n箇条\n画像の後 リンク code block\n太字 太字2 斜体 斜体2 空白',
    );
  });

  test('DD-NEWS-001 記事の題は catalog で h2、home で h3 にする', () => {
    const { unmount } = render(<PublicNewsGrid variant="catalog" articles={[makeArticle('1')]} />);
    expect(screen.getByRole('heading', { level: 2, name: '記事1' })).toBeInTheDocument();
    unmount();

    render(<PublicNewsGrid variant="home" articles={[makeArticle('1')]} />);
    expect(screen.getByRole('heading', { level: 3, name: '記事1' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: '記事1' })).not.toBeInTheDocument();
  });

  test('DD-NEWS-001 題の HTML の印は文字として出し要素にしない', () => {
    render(
      <PublicNewsGrid
        variant="catalog"
        articles={[makeArticle('1', { title: '<script>x</script>', content: '<b>太</b>' })]}
      />,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('<script>x</script>');
    expect(document.querySelector('article script')).toBeNull();
    expect(document.querySelector('article b')).toBeNull();
  });
});

describe('PublicNewsGrid 記事の取り出し', () => {
  test('DD-NEWS-001 catalog で articles が無ければ /api/news を no-store で取り出して出す', async () => {
    const fetchMock = mockFetchResolved({
      ok: true,
      json: async () => [makeArticle('1'), makeArticle('2', { category: 'STORE' })],
    });
    render(<PublicNewsGrid variant="catalog" />);

    expect(await screen.findByRole('heading', { level: 2, name: '記事1' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/news', { cache: 'no-store' });
    expect(shownTitles()).toEqual(['記事1', '記事2']);
  });

  test('DD-NEWS-001 home で fetchLimit が無ければ7件を求めて6件まで出す', async () => {
    const articles = Array.from({ length: 8 }, (_, i) => makeArticle(String(i + 1)));
    const fetchMock = mockFetchResolved({ ok: true, json: async () => articles });
    render(<PublicNewsGrid variant="home" />);

    expect(await screen.findByRole('heading', { level: 3, name: '記事1' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/news?limit=7', { cache: 'no-store' });
    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3', '記事4', '記事5', '記事6']);
  });

  test('DD-NEWS-001 home で fetchLimit が3なら4件を求めて3件まで出す', async () => {
    const articles = Array.from({ length: 8 }, (_, i) => makeArticle(String(i + 1)));
    const fetchMock = mockFetchResolved({ ok: true, json: async () => articles });
    render(<PublicNewsGrid variant="home" fetchLimit={3} />);

    expect(await screen.findByRole('heading', { level: 3, name: '記事1' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/news?limit=4', { cache: 'no-store' });
    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3']);
  });

  test.each(['catalog', 'home'] as const)(
    'DD-NEWS-001 取り出しの応答が ok でなければ失敗の文を出す（%s）',
    async (variant) => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockFetchResolved({ ok: false });
      render(<PublicNewsGrid variant={variant} />);

      const message = await screen.findByText('ニュースデータの取得に失敗しました');
      expect(message).toHaveClass('text-red-500');
      expect(document.querySelector('article')).toBeNull();
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch public news:', expect.any(Error));
    },
  );

  test.each(['catalog', 'home'] as const)(
    'DD-NEWS-001 取り出しが例外を投げたら失敗の文を出す（%s）',
    async (variant) => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const networkError = new TypeError('network down');
      global.fetch = jest.fn().mockRejectedValue(networkError) as unknown as typeof fetch;
      render(<PublicNewsGrid variant={variant} />);

      expect(await screen.findByText('ニュースデータの取得に失敗しました')).toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch public news:', networkError);
    },
  );

  test.each(['catalog', 'home'] as const)(
    'DD-NEWS-001 取り出しの最中は骨組みを5行出す（%s）',
    async (variant) => {
      global.fetch = jest.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
      render(<PublicNewsGrid variant={variant} />);

      await waitFor(() => {
        expect(document.querySelectorAll('.animate-pulse')).toHaveLength(5);
      });
      expect(screen.queryByText('現在、公開されている記事はありません')).not.toBeInTheDocument();
    },
  );

  test('DD-NEWS-001 articles を渡せば取り出さない', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<PublicNewsGrid variant="home" articles={mixedArticles} />);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PublicNewsGrid 空の表示と home の件数', () => {
  test.each(['catalog', 'home'] as const)(
    'DD-NEWS-001 記事が0件なら公開の記事が無いと出す（%s）',
    (variant) => {
      render(<PublicNewsGrid variant={variant} articles={[]} />);

      expect(screen.getByText('現在、公開されている記事はありません')).toBeInTheDocument();
      expect(screen.queryByText('該当カテゴリの記事はありません')).not.toBeInTheDocument();
    },
  );

  test('DD-NEWS-001 catalog で絞った結果が0件なら該当カテゴリの記事が無いと出す', () => {
    setQuery({ category: 'STORE' });
    render(<PublicNewsGrid variant="catalog" articles={[makeArticle('1', { category: 'EVENT' })]} />);

    expect(screen.getByText('該当カテゴリの記事はありません')).toBeInTheDocument();
    expect(document.querySelector('article')).toBeNull();
  });

  test('DD-NEWS-001 home は fetchLimit の件数で切る', () => {
    const articles = Array.from({ length: 8 }, (_, i) => makeArticle(String(i + 1)));
    render(<PublicNewsGrid variant="home" articles={articles} fetchLimit={3} />);

    expect(shownTitles()).toEqual(['記事1', '記事2', '記事3']);
  });

  test('DD-NEWS-001 catalog は渡した記事を件数で切らない', () => {
    const articles = Array.from({ length: 8 }, (_, i) => makeArticle(String(i + 1)));
    render(<PublicNewsGrid variant="catalog" articles={articles} />);

    expect(shownTitles()).toHaveLength(8);
  });

  test('DD-NEWS-001 home は NEWS の見出しの区画を出し className を記事の列に付ける', () => {
    render(<PublicNewsGrid variant="home" articles={mixedArticles} className="grid-extra" />);

    expect(document.querySelector('section#news')).toBeInTheDocument();
    expect(document.querySelector('article')?.closest('.grid-extra')).not.toBeNull();
  });

  test('DD-NEWS-001 home の総数が表示数より多ければ VIEW ALL を flex で出す', () => {
    render(<PublicNewsGrid variant="home" articles={mixedArticles} totalCount={7} />);

    expect(viewAllWrapper()).toHaveClass('flex');
    expect(viewAllWrapper()).not.toHaveClass('hidden');
    expect(screen.getByTestId('home-section-view-all')).toHaveAttribute('href', '/news');
  });

  test('DD-NEWS-001 home の総数が表示数以下なら VIEW ALL を hidden にする', () => {
    render(<PublicNewsGrid variant="home" articles={mixedArticles} totalCount={6} />);

    expect(viewAllWrapper()).toHaveClass('hidden');
    expect(viewAllWrapper()).not.toHaveClass('flex');
  });

  test('DD-NEWS-001 home の総数が fetchLimit と比べられる', () => {
    render(<PublicNewsGrid variant="home" articles={mixedArticles} fetchLimit={3} totalCount={4} />);

    expect(viewAllWrapper()).not.toHaveClass('hidden');
  });

  test('DD-NEWS-001 home の総数が無ければ VIEW ALL を隠さない', () => {
    render(<PublicNewsGrid variant="home" articles={mixedArticles} />);

    expect(viewAllWrapper()).not.toHaveClass('hidden');
    expect(screen.getByRole('link', { name: 'VIEW ALL NEWS' })).toBeInTheDocument();
  });
});
