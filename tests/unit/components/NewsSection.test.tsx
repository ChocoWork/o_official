import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewsSection from '@/components/NewsSection';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

import { clientFetch } from '@/lib/client-fetch';

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const mockArticles = [
  {
    id: '1',
    title: 'テスト記事',
    published_date: '2025-01-01',
    category: 'SUSTAINABILITY',
    status: 'published' as const,
    image_url: '/test.jpg',
    content: 'テスト本文',
    detailed_content: '詳細テスト本文',
  },
  {
    id: '2',
    title: '別記事',
    published_date: '2025-01-02',
    category: 'COLLABORATION',
    status: 'private' as const,
    image_url: '/test2.jpg',
    content: '別本文',
    detailed_content: '別詳細',
  },
];

describe('NewsSection category label', () => {
  beforeEach(() => {
    mockClientFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockArticles }),
    } as Response);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // カテゴリは TagLabel の outline variant で描画する。枠線の見た目は
  // TagLabel.css の責務なので、ここでは variant の属性契約だけを検証する。
  it('DD-NEWS-060 カテゴリを TagLabel の outline variant で描画する', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('SUSTAINABILITY')).toBeInTheDocument();
    });

    const categoryEl = screen.getByText('SUSTAINABILITY').closest('[data-ui-tag-label]');
    expect(categoryEl).not.toBeNull();
    expect(categoryEl).toHaveAttribute('data-ui-tag-label-variant', 'outline');
  });

  it('DD-NEWS-060 すべてのカテゴリを TagLabel で描画する', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('COLLABORATION')).toBeInTheDocument();
    });

    const collab = screen.getByText('COLLABORATION').closest('[data-ui-tag-label]');
    expect(collab).not.toBeNull();
    expect(collab).toHaveAttribute('data-ui-tag-label-variant', 'outline');
  });

  it('DD-NEWS-060 素の span では描画しない', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('SUSTAINABILITY')).toBeInTheDocument();
    });

    // TagLabel を経由していれば必ず data-ui-tag-label が祖先に付く。
    expect(screen.getByText('SUSTAINABILITY').closest('[data-ui-tag-label]')).not.toBeNull();
  });
});

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function failResponse(json: () => Promise<unknown>): Response {
  return { ok: false, status: 500, statusText: 'Internal Server Error', json } as unknown as Response;
}

describe('NewsSection 一覧・公開の切り替え・削除', () => {
  let alertSpy: jest.SpyInstance;
  let confirmSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
    confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
    confirmSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  async function renderList() {
    mockClientFetch.mockResolvedValueOnce(okResponse({ data: mockArticles }));
    render(<NewsSection />);
    await screen.findByText('テスト記事');
  }

  it('DD-NEWS-060 取り出しの間は「読み込み中...」が出る', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<NewsSection />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/news');

    resolveFetch(okResponse({ data: [] }));
    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-NEWS-060 公開中の行と非公開の行でバッジの文字・tone とボタンの文字が変わる', async () => {
    await renderList();

    const publishedBadge = screen.getByText('公開中').closest('[data-ui-badge]');
    expect(publishedBadge).toHaveAttribute('data-ui-badge-tone', 'positive');

    const privateBadge = screen
      .getAllByText('非公開')
      .map((el) => el.closest('[data-ui-badge]'))
      .find((el) => el !== null);
    expect(privateBadge).toHaveAttribute('data-ui-badge-tone', 'neutral');

    expect(screen.getByRole('button', { name: '非公開' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(screen.getByAltText('テスト記事')).toHaveAttribute('src', '/test.jpg');
    expect(screen.getByText('2025-01-02')).toBeInTheDocument();
  });

  it('DD-NEWS-060 応答が OK でなく本文が JSON の時は role=alert の「ニュース記事の取得に失敗しました」が出て、「ニュース記事がありません」は出ない', async () => {
    mockClientFetch.mockResolvedValueOnce(failResponse(async () => ({ error: 'boom' })));

    render(<NewsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('ニュース記事の取得に失敗しました');
    expect(screen.queryByText('ニュース記事がありません')).not.toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to fetch news: 500 Internal Server Error',
      { error: 'boom' },
    );
  });

  it('DD-NEWS-060 応答が OK でなく本文が JSON で読めない時も取得の失敗の文が出る', async () => {
    mockClientFetch.mockResolvedValueOnce(
      failResponse(async () => {
        throw new SyntaxError('Unexpected token');
      }),
    );

    render(<NewsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('ニュース記事の取得に失敗しました');
    expect(screen.queryByText('ニュース記事がありません')).not.toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to fetch news: 500 Internal Server Error',
      {},
    );
  });

  it('DD-NEWS-060 clientFetch が例外を投げた時も取得の失敗の文が出て、「ニュース記事がありません」は出ない', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network'));

    render(<NewsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('ニュース記事の取得に失敗しました');
    expect(screen.queryByText('ニュース記事がありません')).not.toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load news:', expect.any(Error));
  });

  it('DD-NEWS-060 応答に data が無い時は「ニュース記事がありません」が出て、失敗の文は出ない', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse({}));

    render(<NewsSection />);

    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('DD-NEWS-060 成功して 0 件の時は「ニュース記事がありません」が出る', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse({ data: [] }));

    render(<NewsSection />);

    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('DD-NEWS-060 失敗の後に「再読み込み」を押すと取り直し、成功すれば一覧が出て失敗の文が消える', async () => {
    mockClientFetch
      .mockResolvedValueOnce(failResponse(async () => ({})))
      .mockResolvedValueOnce(okResponse({ data: mockArticles }));

    render(<NewsSection />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));

    expect(await screen.findByText('テスト記事')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('DD-NEWS-060 公開中の行の切り替えで status private を PATCH し、成功で一覧を読み直す', async () => {
    await renderList();
    mockClientFetch
      .mockResolvedValueOnce(okResponse({}))
      .mockResolvedValueOnce(
        okResponse({ data: [{ ...mockArticles[0], status: 'private' as const }] }),
      );

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/news/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'private' }),
    });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, '/api/admin/news');
    expect(await screen.findByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(screen.queryByText('別記事')).not.toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-NEWS-060 非公開の行の切り替えで status published を PATCH する', async () => {
    await renderList();
    mockClientFetch
      .mockResolvedValueOnce(okResponse({}))
      .mockResolvedValueOnce(okResponse({ data: mockArticles }));

    fireEvent.click(screen.getByRole('button', { name: '公開' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/news/2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
  });

  it('DD-NEWS-060 PATCH が OK でない時に「ステータスの更新に失敗しました」の alert が出て読み直さない', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce({ ok: false } as Response);

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('DD-NEWS-060 PATCH が例外の時に「ステータスの更新に失敗しました」の alert が出る', async () => {
    await renderList();
    mockClientFetch.mockRejectedValueOnce(new Error('network'));

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('DD-NEWS-060 削除の確かめを取り消すと DELETE を送らない', async () => {
    await renderList();
    confirmSpy.mockReturnValue(false);

    fireEvent.click(screen.getAllByRole('button', { name: '削除' })[0]);

    expect(confirmSpy).toHaveBeenCalledWith('この記事を削除してもよろしいですか？');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('DD-NEWS-060 削除に同意すると DELETE を送り、成功で一覧を読み直す', async () => {
    await renderList();
    mockClientFetch
      .mockResolvedValueOnce(okResponse({}))
      .mockResolvedValueOnce(okResponse({ data: [mockArticles[1]] }));

    fireEvent.click(screen.getAllByRole('button', { name: '削除' })[0]);

    await waitFor(() => expect(screen.queryByText('テスト記事')).not.toBeInTheDocument());
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/news/1', { method: 'DELETE' });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, '/api/admin/news');
    expect(screen.getByText('別記事')).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-NEWS-060 DELETE が OK でない時に「記事の削除に失敗しました」の alert が出て読み直さない', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce({ ok: false } as Response);

    fireEvent.click(screen.getAllByRole('button', { name: '削除' })[0]);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('記事の削除に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('DD-NEWS-060 DELETE が例外の時に「記事の削除に失敗しました」の alert が出る', async () => {
    await renderList();
    mockClientFetch.mockRejectedValueOnce(new Error('network'));

    fireEvent.click(screen.getAllByRole('button', { name: '削除' })[0]);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('記事の削除に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('DD-NEWS-060 切り替えの後の読み直しに失敗すると前の一覧のまま残る', async () => {
    await renderList();
    mockClientFetch
      .mockResolvedValueOnce(okResponse({}))
      .mockRejectedValueOnce(new Error('network'));

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load news:', expect.any(Error)),
    );
    expect(screen.getByText('テスト記事')).toBeInTheDocument();
    expect(screen.getByText('公開中')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('ニュース記事の取得に失敗しました');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-NEWS-060 編集のボタンの行き先が /admin/news/edit/<id>', async () => {
    await renderList();

    const links = screen.getAllByRole('link', { name: '編集' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/admin/news/edit/1',
      '/admin/news/edit/2',
    ]);
  });

  it('DD-NEWS-060 画像の署名が null の記事は、空の src にせず /placeholder.png を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      okResponse({ data: [{ ...mockArticles[0], image_url: null }, mockArticles[1]] }),
    );
    render(<NewsSection />);

    expect(await screen.findByAltText('テスト記事')).toHaveAttribute('src', '/placeholder.png');
    expect(screen.getByAltText('別記事')).toHaveAttribute('src', '/test2.jpg');
  });
});
