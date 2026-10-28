import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { SearchHomePreview } from '@/features/search/components/SearchHomePreview';
import type { SearchResult, SearchResultsResponse } from '@/features/search/types/search.types';

let mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

const fetchMock = jest.fn();

function setQuery(query: string | null) {
  mockSearchParams = query === null ? new URLSearchParams() : new URLSearchParams({ q: query });
}

function result(type: SearchResult['type'], id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    type,
    title: `${type}-${id}-title`,
    description: `${type}-${id}-description`,
    href: `/${type}/${id}`,
    imageUrl: null,
    meta: `${type}-${id}-meta`,
    ...overrides,
  };
}

function payload(items: SearchResult[] = [], looks: SearchResult[] = [], news: SearchResult[] = []): SearchResultsResponse {
  return {
    query: 'q',
    tab: 'all',
    items,
    looks,
    news,
    counts: { all: items.length + looks.length + news.length, item: items.length, look: looks.length, news: news.length },
    popularItems: [],
    empty: items.length + looks.length + news.length === 0,
  };
}

function okResponse(body: SearchResultsResponse) {
  return { ok: true, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const EMPTY_MESSAGE = 'プレビュー対象の検索結果は見つかりませんでした。';
const FIXED_SENTENCE = '入力した語に関連する結果をホーム上で即時プレビューしています。';

describe('SearchHomePreview', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    setQuery(null);
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    fetchMock.mockResolvedValue(okResponse(payload()));
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-SEARCH-003 URL に q が無いと何も描かず、fetch を呼ばない', async () => {
    const { container } = render(<SearchHomePreview />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-003 空白だけの q も何も描かず、fetch を呼ばない', async () => {
    setQuery('   ');

    const { container } = render(<SearchHomePreview />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-003 前後の空白を除いた語を符号化して preview=true と no-store で窓口を呼ぶ', async () => {
    setQuery(' a b ');

    render(<SearchHomePreview />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/search?q=a%20b&preview=true', { cache: 'no-store' });
  });

  it('DD-SEARCH-003 商品・ルック・ニュースの順につないだ先頭3件だけをカードに出す', async () => {
    setQuery('coat');
    fetchMock.mockResolvedValue(
      okResponse(payload([result('item', '1'), result('item', '2')], [result('look', '1'), result('look', '2')], [result('news', '1')])),
    );

    render(<SearchHomePreview />);

    await screen.findByText('item-1-title');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'item-1-title',
      'item-2-title',
      'look-1-title',
    ]);
    expect(screen.queryByText('look-2-title')).not.toBeInTheDocument();
    expect(screen.queryByText('news-1-title')).not.toBeInTheDocument();
  });

  it('DD-SEARCH-003 カードにメタ・題・説明を出し、カード全体と VIEW ALL RESULTS を正しい href のリンクにする', async () => {
    setQuery('a b');
    fetchMock.mockResolvedValue(okResponse(payload([result('item', '7')])));

    render(<SearchHomePreview />);

    await screen.findByText('item-7-title');
    expect(screen.getByText('item-7-meta')).toBeInTheDocument();
    expect(screen.getByText('item-7-description')).toBeInTheDocument();
    expect(screen.getByText('item-7-title').closest('a')).toHaveAttribute('href', '/item/7');
    expect(screen.getByRole('link', { name: 'VIEW ALL RESULTS' })).toHaveAttribute('href', '/search?q=a%20b');
    expect(screen.getByText('PREVIEW')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Search Preview' })).toBeInTheDocument();
    expect(screen.getByText(FIXED_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MESSAGE)).not.toBeInTheDocument();
  });

  it('DD-SEARCH-003 説明の文は固定で、どの p にも検索語を含めず、語は「検索した語」の枠の dd だけに出す', async () => {
    setQuery('coat 本日休業のお知らせ');
    fetchMock.mockResolvedValue(okResponse(payload([result('item', '1')])));

    const { container } = render(<SearchHomePreview />);

    await screen.findByText('item-1-title');
    const fixed = screen.getAllByText(FIXED_SENTENCE);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].tagName).toBe('P');
    for (const paragraph of Array.from(container.querySelectorAll('p'))) {
      expect(paragraph.textContent).not.toContain('本日休業');
    }
    const box = screen.getByTestId('search-preview-term');
    expect(box.tagName).toBe('DL');
    expect(box.querySelector('dt')?.textContent).toBe('検索した語');
    expect(box.querySelector('dd')?.textContent).toBe('coat 本日休業のお知らせ');
  });

  it('DD-SEARCH-003 検索語の HTML は枠の中でも文字として出し、要素にしない', async () => {
    setQuery('<b>x</b>');
    fetchMock.mockResolvedValue(okResponse(payload([result('item', '1')])));

    const { container } = render(<SearchHomePreview />);

    await screen.findByText('item-1-title');
    expect(screen.getByTestId('search-preview-term').querySelector('dd')?.textContent).toBe('<b>x</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('DD-SEARCH-003 0件でも固定の文と「検索した語」の枠を出す', async () => {
    setQuery('none');

    render(<SearchHomePreview />);

    expect(await screen.findByText(EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(FIXED_SENTENCE)).toBeInTheDocument();
    expect(screen.getByTestId('search-preview-term').querySelector('dd')?.textContent).toBe('none');
  });

  it('DD-SEARCH-003 3種とも0件なら見つかりませんでしたの文を出し、カードは出さない', async () => {
    setQuery('none');

    render(<SearchHomePreview />);

    expect(await screen.findByText(EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'VIEW ALL RESULTS' })).toHaveAttribute('href', '/search?q=none');
  });

  it('DD-SEARCH-003 応答が ok でないと何も描かず console.error に書く', async () => {
    setQuery('coat');
    fetchMock.mockResolvedValue({ ok: false, json: async () => payload([result('item', '1')]) });

    const { container } = render(<SearchHomePreview />);

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledTimes(1));
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch home search preview');
    expect(consoleErrorSpy.mock.calls[0]).toHaveLength(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('DD-SEARCH-003 応答が 429（本文は使わない）でも、no-store の応答を開いたまま残さないよう本文を読み切る', async () => {
    setQuery('coat');
    const drain = jest.fn().mockResolvedValue(new ArrayBuffer(0));
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}), arrayBuffer: drain });

    const { container } = render(<SearchHomePreview />);

    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch home search preview'));
    expect(container).toBeEmptyDOMElement();
  });

  it('DD-SEARCH-003 fetch が reject しても何も描かず、Error を渡さず固定の文字だけ console.error に書く', async () => {
    setQuery('coat');
    fetchMock.mockRejectedValue(new Error('network down'));

    const { container } = render(<SearchHomePreview />);

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledTimes(1));
    expect(consoleErrorSpy.mock.calls[0]).toEqual(['Failed to fetch home search preview']);
    expect(container).toBeEmptyDOMElement();
  });

  it('DD-SEARCH-003 取り出しの最中に語が変わると、前の語の成功の応答を捨てる', async () => {
    const first = deferred<ReturnType<typeof okResponse>>();
    setQuery('first');
    fetchMock.mockReturnValueOnce(first.promise);
    fetchMock.mockResolvedValueOnce(okResponse(payload([result('item', 'second')])));

    const { rerender } = render(<SearchHomePreview />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    setQuery('second');
    rerender(<SearchHomePreview />);
    await screen.findByText('item-second-title');

    first.resolve(okResponse(payload([result('item', 'first')])));
    await first.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('item-second-title')).toBeInTheDocument();
    expect(screen.queryByText('item-first-title')).not.toBeInTheDocument();
  });

  it('DD-SEARCH-003 取り出しの最中に語が変わると、前の語の失敗で後の結果を消さない', async () => {
    const first = deferred<ReturnType<typeof okResponse>>();
    setQuery('first');
    fetchMock.mockReturnValueOnce(first.promise);
    fetchMock.mockResolvedValueOnce(okResponse(payload([result('item', 'second')])));

    const { rerender } = render(<SearchHomePreview />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    setQuery('second');
    rerender(<SearchHomePreview />);
    await screen.findByText('item-second-title');

    first.reject(new Error('late failure'));
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('item-second-title')).toBeInTheDocument();
  });

  it('DD-SEARCH-003 結果を出した後に q が外れると、何も描かなくなる', async () => {
    setQuery('coat');
    fetchMock.mockResolvedValue(okResponse(payload([result('item', '1')])));

    const { container, rerender } = render(<SearchHomePreview />);
    await screen.findByText('item-1-title');

    setQuery(null);
    rerender(<SearchHomePreview />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('DD-SEARCH-003 題・説明・メタの HTML は文字として出し、要素にしない', async () => {
    setQuery('coat');
    fetchMock.mockResolvedValue(
      okResponse(
        payload([result('item', '1', { title: '<b>x</b>', description: '<i>y</i>', meta: '<u>z</u>' })]),
      ),
    );

    const { container } = render(<SearchHomePreview />);

    expect(await screen.findByText('<b>x</b>')).toBeInTheDocument();
    expect(screen.getByText('<i>y</i>')).toBeInTheDocument();
    expect(screen.getByText('<u>z</u>')).toBeInTheDocument();
    expect(container.querySelector('b, i, u')).toBeNull();
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
