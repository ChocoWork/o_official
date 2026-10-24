import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NewsSection from '@/components/NewsSection';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }),
}));

// clientFetch は本物を通し、網の境目の fetch だけを差し替える（CSRF の見出しと送り方まで確かめる）
const CSRF_TOKEN = 'csrf-test-token';
const mockFetch = jest.fn();
const realFetch = global.fetch;

type SentRequest = { url: string; method: string; headers: Headers; body: unknown; credentials: unknown };

function sent(index: number): SentRequest {
  const [url, init] = mockFetch.mock.calls[index] as [string, RequestInit];
  return { url, method: init.method as string, headers: init.headers as Headers, body: init.body, credentials: init.credentials };
}

type Article = {
  id: string;
  title: string;
  published_date: string;
  category: string;
  status: 'private' | 'published';
  image_url: string;
  content: string;
  detailed_content: string;
};

const PUBLISHED: Article = {
  id: 'a1',
  title: '春の新作',
  published_date: '2026-04-01',
  category: 'COLLECTION',
  status: 'published',
  image_url: 'https://example.test/signed/a1.jpg',
  content: '要約1',
  detailed_content: '詳細1',
};

const PRIVATE: Article = {
  id: 'a2',
  title: '下書きのイベント',
  published_date: '2026-03-15',
  category: 'EVENT',
  status: 'private',
  image_url: 'https://example.test/signed/a2.jpg',
  content: '要約2',
  detailed_content: '詳細2',
};

function okList(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data }) } as unknown as Response;
}

function okEmpty() {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as unknown as Response;
}

function failed(status = 500) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => ({ error: 'x' }),
  } as unknown as Response;
}

function rowOf(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  let node: HTMLElement | null = heading;
  while (node && !within(node).queryByRole('button', { name: '削除' })) {
    node = node.parentElement;
  }
  if (!node) throw new Error(`row for ${title} not found`);
  return node;
}

describe('管理の NEWS タブの一覧', () => {
  let errorSpy: jest.SpyInstance;
  let alertSpy: jest.SpyInstance;
  let confirmSpy: jest.SpyInstance;

  beforeAll(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  beforeEach(() => {
    mockFetch.mockReset();
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    alertSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('SCR-NEWS-003 読み込みの間は読み込み中を出し、一覧を管理の窓口から取る', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    render(<NewsSection />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '春の新作' })).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sent(0)).toMatchObject({ url: '/api/admin/news', method: 'GET', credentials: 'same-origin' });
    expect(sent(0).headers.has('x-csrf-token')).toBe(false);
  });

  it('SCR-NEWS-003 行に画像・状態・分類・題・公開日・切り替え・編集・削除を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]));

    render(<NewsSection />);

    await screen.findByRole('heading', { name: '春の新作' });
    const published = rowOf('春の新作');
    expect(within(published).getByRole('img', { name: '春の新作' })).toHaveAttribute('src', PUBLISHED.image_url);
    expect(within(published).getByText('公開中')).toBeInTheDocument();
    expect(within(published).getByText('COLLECTION')).toBeInTheDocument();
    expect(within(published).getByText('2026-04-01')).toBeInTheDocument();
    expect(within(published).getByRole('button', { name: '非公開' })).toBeInTheDocument();
    expect(within(published).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/news/edit/a1');
    expect(within(published).getByRole('button', { name: '削除' })).toBeInTheDocument();

    const draft = rowOf('下書きのイベント');
    expect(within(draft).getByRole('img', { name: '下書きのイベント' })).toHaveAttribute('src', PRIVATE.image_url);
    expect(within(draft).getByText('非公開')).toBeInTheDocument();
    expect(within(draft).getByText('EVENT')).toBeInTheDocument();
    expect(within(draft).getByText('2026-03-15')).toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(draft).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/news/edit/a2');
  });

  it('SCR-NEWS-003 窓口の並びのまま行を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]));

    render(<NewsSection />);

    await screen.findByRole('heading', { name: '春の新作' });
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['春の新作', '下書きのイベント']);
  });

  it('SCR-NEWS-003 0件の時は記事が無い旨を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([]));

    render(<NewsSection />);

    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
  });

  it('SCR-NEWS-003 応答に data が無い時も0件として出す', async () => {
    mockFetch.mockResolvedValueOnce(okEmpty());

    render(<NewsSection />);

    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
  });

  it('SCR-NEWS-003 取り出しが断られた時は0件と同じ文になる', async () => {
    mockFetch.mockResolvedValueOnce(failed(403));

    render(<NewsSection />);

    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument();
  });

  it('SCR-NEWS-003 断られた応答の本文が JSON でなくても0件と同じ文になる', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Error',
      json: async () => {
        throw new SyntaxError('bad json');
      },
    } as unknown as Response);

    render(<NewsSection />);

    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
  });

  it('SCR-NEWS-003 通信の例外でも0件と同じ文になる', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));

    render(<NewsSection />);

    expect(await screen.findByText('ニュース記事がありません')).toBeInTheDocument();
  });

  it('SCR-NEWS-003 公開中の記事の切り替えは非公開を PATCH で送り、一覧を読み直す', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PUBLISHED]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([{ ...PUBLISHED, status: 'private' }]));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });
    await user.click(within(rowOf('春の新作')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(sent(1)).toMatchObject({
      url: '/api/admin/news/a1',
      method: 'PATCH',
      credentials: 'same-origin',
      body: JSON.stringify({ status: 'private' }),
    });
    expect(sent(1).headers.get('Content-Type')).toBe('application/json');
    expect(sent(1).headers.get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(sent(2)).toMatchObject({ url: '/api/admin/news', method: 'GET' });
    expect(await within(rowOf('春の新作')).findByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-003 非公開の記事の切り替えは公開を PATCH で送る', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PRIVATE]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([PRIVATE]));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '下書きのイベント' });
    await user.click(within(rowOf('下書きのイベント')).getByRole('button', { name: '公開' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(sent(1)).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ status: 'published' }),
    });
  });

  it('SCR-NEWS-003 切り替えが断られた時は alert を出し、一覧を読み直さない', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockResolvedValueOnce(failed(403));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });
    await user.click(within(rowOf('春の新作')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(within(rowOf('春の新作')).getByText('公開中')).toBeInTheDocument();
  });

  it('SCR-NEWS-003 切り替えの通信の例外でも alert を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockRejectedValueOnce(new Error('network'));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });
    await user.click(within(rowOf('春の新作')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
  });

  it('SCR-NEWS-003 削除は確かめを出し、同意しなければ送らない', async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });
    await user.click(within(rowOf('春の新作')).getByRole('button', { name: '削除' }));

    expect(confirmSpy).toHaveBeenCalledWith('この記事を削除してもよろしいですか？');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: '春の新作' })).toBeInTheDocument();
  });

  it('SCR-NEWS-003 削除に同意すると DELETE を送り、一覧を読み直す', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([PRIVATE]));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });
    await user.click(within(rowOf('春の新作')).getByRole('button', { name: '削除' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: '春の新作' })).not.toBeInTheDocument(),
    );
    expect(sent(1)).toMatchObject({ url: '/api/admin/news/a1', method: 'DELETE', credentials: 'same-origin' });
    expect(sent(1).headers.get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(sent(2)).toMatchObject({ url: '/api/admin/news', method: 'GET' });
    expect(screen.getByRole('heading', { name: '下書きのイベント' })).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-003 削除が断られた時は alert を出し、記事を残す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockResolvedValueOnce(failed(403));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });
    await user.click(within(rowOf('春の新作')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('記事の削除に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: '春の新作' })).toBeInTheDocument();
  });

  it('SCR-NEWS-003 削除の通信の例外でも alert を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockRejectedValueOnce(new Error('network'));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });
    await user.click(within(rowOf('春の新作')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('記事の削除に失敗しました'));
  });
});
