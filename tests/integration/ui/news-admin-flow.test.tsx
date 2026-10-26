import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import NewsSection from '@/components/NewsSection';
import CreateNewsPage from '@/app/admin/news/create/page';
import EditNewsPage from '@/app/admin/news/edit/[id]/page';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: '101' }),
}));

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }),
}));

// clientFetch は本物を通し、網の境目の fetch だけを差し替える（CSRF の見出しと送り方まで確かめる）
const CSRF_TOKEN = 'csrf-test-token';
const mockFetch = jest.fn();
const realFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

const LIST_URL = '/admin?tab=NEWS';

const ARTICLE = {
  id: '101',
  title: '春の新作',
  published_date: '2026-04-01',
  category: 'COLLECTION',
  status: 'published' as const,
  image_url: 'https://example.test/signed/101.jpg',
  content: '要約',
  detailed_content: '詳細',
};

const OTHER = { ...ARTICLE, id: '102', title: '店舗のお知らせ', category: 'STORE', status: 'private' as const };

function json(ok: boolean, body: unknown): Response {
  return { ok, status: ok ? 200 : 400, statusText: '', json: async () => body } as unknown as Response;
}

function makeFile(name: string, type: string) {
  return new File(['x'], name, { type });
}

function rowOf(title: string): HTMLElement {
  let node: HTMLElement | null = screen.getByRole('heading', { name: title });
  while (node && !within(node).queryByRole('button', { name: '削除' })) {
    node = node.parentElement;
  }
  if (!node) throw new Error(`row for ${title} not found`);
  return node;
}

describe('管理の一覧と作成・編集の行き来', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let alertSpy: jest.SpyInstance;
  let confirmSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPush.mockReset();
    mockFetch.mockReset();
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    // jsdom は canvas の getContext を実装せず、SingleSelect の文字幅の計測で雑音が出るため null を返す
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
    getContextSpy.mockRestore();
    errorSpy.mockRestore();
    alertSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('FLOW-NEWS-002 一覧の編集は記事ごとの編集の画面へつながる', async () => {
    mockFetch.mockResolvedValueOnce(json(true, { data: [ARTICLE, OTHER] }));

    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });

    expect(within(rowOf('春の新作')).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/news/edit/101');
    expect(within(rowOf('店舗のお知らせ')).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/news/edit/102');
  });

  it('FLOW-NEWS-002 作成の保存に成功すると保存しました を見せ、500ms 後に一覧へ戻る', async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValueOnce(json(true, { data: { id: 'n1' } }));
    const { container } = render(<CreateNewsPage />);
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('a.png', 'image/png')] },
    });

    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('保存しました'));

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(mockPush).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
  });

  it('FLOW-NEWS-002 編集の更新に成功すると更新しました を見せ、500ms 後に一覧へ戻る', async () => {
    jest.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(json(true, { data: ARTICLE }))
      .mockResolvedValueOnce(json(true, { data: ARTICLE }));
    const { container } = render(<EditNewsPage />);
    await screen.findByDisplayValue('春の新作');

    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('更新しました'));

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(mockPush).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
  });

  it('FLOW-NEWS-002 作成のキャンセルは送らずに一覧へ戻る', () => {
    render(<CreateNewsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('FLOW-NEWS-002 編集のキャンセルは送らずに一覧へ戻る', async () => {
    mockFetch.mockResolvedValueOnce(json(true, { data: ARTICLE }));
    render(<EditNewsPage />);
    await screen.findByDisplayValue('春の新作');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('FLOW-NEWS-002 作成の保存に失敗すると同じ画面に文を出し、時間が経っても移らない', async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValueOnce(json(false, { error: '保存できません' }));
    const { container } = render(<CreateNewsPage />);
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('a.png', 'image/png')] },
    });

    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('保存できません'));
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(mockPush).not.toHaveBeenCalled();
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('FLOW-NEWS-002 編集の更新に失敗すると同じ画面に文を出し、時間が経っても移らない', async () => {
    jest.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(json(true, { data: ARTICLE }))
      .mockRejectedValueOnce(new Error('network'));
    const { container } = render(<EditNewsPage />);
    await screen.findByDisplayValue('春の新作');

    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('通信エラーが発生しました'));
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-NEWS-002 一覧の上で公開を切り替えると読み直した状態を出し、画面を移らない', async () => {
    mockFetch
      .mockResolvedValueOnce(json(true, { data: [ARTICLE] }))
      .mockResolvedValueOnce(json(true, {}))
      .mockResolvedValueOnce(json(true, { data: [{ ...ARTICLE, status: 'private' }] }));
    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });

    fireEvent.click(within(rowOf('春の新作')).getByRole('button', { name: '非公開' }));

    expect(await within(rowOf('春の新作')).findByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(rowOf('春の新作')).getAllByText('非公開')).toHaveLength(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-NEWS-002 一覧の上で削除を確かめて同意すると、読み直した一覧から記事が消える', async () => {
    mockFetch
      .mockResolvedValueOnce(json(true, { data: [ARTICLE, OTHER] }))
      .mockResolvedValueOnce(json(true, {}))
      .mockResolvedValueOnce(json(true, { data: [OTHER] }));
    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });

    fireEvent.click(within(rowOf('春の新作')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: '春の新作' })).not.toBeInTheDocument());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: '店舗のお知らせ' })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-NEWS-002 削除の確かめで断ると送らずに一覧に留まる', async () => {
    confirmSpy.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(json(true, { data: [ARTICLE] }));
    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });

    fireEvent.click(within(rowOf('春の新作')).getByRole('button', { name: '削除' }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: '春の新作' })).toBeInTheDocument();
  });

  it('FLOW-NEWS-002 一覧の上の操作に失敗すると alert を出し、前の一覧のまま留まる', async () => {
    mockFetch
      .mockResolvedValueOnce(json(true, { data: [ARTICLE] }))
      .mockResolvedValueOnce(json(false, {}));
    render(<NewsSection />);
    await screen.findByRole('heading', { name: '春の新作' });

    fireEvent.click(within(rowOf('春の新作')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('記事の削除に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: '春の新作' })).toBeInTheDocument();
  });
});
