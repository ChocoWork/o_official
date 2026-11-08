import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditNewsPage from '@/app/admin/news/edit/[id]/page';

const mockPush = jest.fn();
let mockParams: { id?: string } | null = { id: '42' };

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => mockParams,
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

const ARTICLE = {
  id: '42',
  title: '秋のコレクション',
  category: 'SUSTAINABILITY',
  published_date: '2026-09-01',
  image_url: 'https://example.test/signed/42.jpg',
  content: '要約の文',
  detailed_content: '詳細の文',
  status: 'published' as const,
};

function response(ok: boolean, body: unknown): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    json: body === undefined ? async () => { throw new SyntaxError('no json'); } : async () => body,
  } as unknown as Response;
}

function makeFile(name: string, type: string, size = 1024) {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

// 共有の RadioButtonGroup は欄の見出しの label が選択肢の label を包むため、最初の選択肢の名前に見出しと全選択肢が混ざる。名前ではなく値で取る
function statusRadio(value: 'private' | 'published'): HTMLInputElement {
  return document.querySelector(`input[type="radio"][name="status"][value="${value}"]`) as HTMLInputElement;
}

// 成功の後の一覧への移動は 500ms のタイマー。偽のタイマーで進め、次のケースへタイマーを残さない。
function expectPushAfterSuccessTimer() {
  act(() => {
    jest.advanceTimersByTime(499);
  });
  expect(mockPush).not.toHaveBeenCalled();
  act(() => {
    jest.advanceTimersByTime(1);
  });
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/admin?tab=NEWS');
}

async function renderLoaded() {
  mockFetch.mockResolvedValueOnce(response(true, { data: ARTICLE }));
  const utils = render(<EditNewsPage />);
  await screen.findByDisplayValue('秋のコレクション');
  return utils;
}

describe('記事の編集の画面', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockParams = { id: '42' };
    mockPush.mockReset();
    mockFetch.mockReset();
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    // jsdom は canvas の getContext を実装せず、SingleSelect の文字幅の計測で雑音が出るため null を返す
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    getContextSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('SCR-NEWS-005 読み込みの間は読み込み中を出し、URL の id の記事を管理の窓口から取る', async () => {
    mockFetch.mockResolvedValueOnce(response(true, { data: ARTICLE }));

    render(<EditNewsPage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('秋のコレクション')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/news/42');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect((init.headers as Headers).has('x-csrf-token')).toBe(false);
  });

  it('SCR-NEWS-005 取り出した記事の今の値をフォームに詰める', async () => {
    await renderLoaded();

    expect(screen.getByLabelText(/^タイトル/)).toHaveValue('秋のコレクション');
    expect(screen.getByRole('combobox', { name: 'カテゴリー' })).toHaveTextContent('SUSTAINABILITY');
    expect(screen.getByLabelText(/^公開日/)).toHaveValue('2026-09-01');
    expect(screen.getByLabelText(/^本文（要約）/)).toHaveValue('要約の文');
    expect(screen.getByLabelText(/^本文（詳細）/)).toHaveValue('詳細の文');
    expect(statusRadio('published')).toBeChecked();
    expect(statusRadio('private')).not.toBeChecked();
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
  });

  it('SCR-NEWS-005 既にある画像を現在の画像として見本に出す', async () => {
    await renderLoaded();

    expect(screen.getByText('現在の画像')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '画像プレビュー' })).toHaveAttribute('src', ARTICLE.image_url);
  });

  it('SCR-NEWS-005 画像を選び直すと見本を差し替える', async () => {
    const { container } = await renderLoaded();

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('new.png', 'image/png')] },
    });

    expect(await screen.findByText('new.png (新規)')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '画像プレビュー' }).getAttribute('src')).toMatch(/^data:image\/png;base64,/),
    );
    expect(screen.queryByText('現在の画像')).not.toBeInTheDocument();
  });

  it('SCR-NEWS-005 画像を選ばずに PUT で送れ、画像の欄は送らない', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    mockFetch.mockResolvedValueOnce(response(true, { data: ARTICLE }));

    await user.clear(screen.getByLabelText(/^タイトル/));
    await user.type(screen.getByLabelText(/^タイトル/), '直した題');
    await user.click(statusRadio('private'));
    jest.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('更新しました'));
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe('/api/admin/news/42');
    expect(init?.method).toBe('PUT');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Headers).get('x-csrf-token')).toBe(CSRF_TOKEN);
    const body = init?.body as FormData;
    expect(body.get('title')).toBe('直した題');
    expect(body.get('category')).toBe('SUSTAINABILITY');
    expect(body.get('date')).toBe('2026-09-01');
    expect(body.get('content')).toBe('要約の文');
    expect(body.get('detailedContent')).toBe('詳細の文');
    expect(body.get('status')).toBe('private');
    expect(body.has('image')).toBe(false);
    expectPushAfterSuccessTimer();
  });

  it('SCR-NEWS-005 選び直した画像は送る', async () => {
    const { container } = await renderLoaded();
    mockFetch.mockResolvedValueOnce(response(true, {}));
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('new.webp', 'image/webp')] },
    });
    await screen.findByText('new.webp (新規)');
    jest.useFakeTimers();

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('更新しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(((mockFetch.mock.calls[1][1]?.body as FormData).get('image') as File).name).toBe('new.webp');
    expectPushAfterSuccessTimer();
  });

  it('SCR-NEWS-005 送る間はボタンを更新中にして押せなくする', async () => {
    const { container } = await renderLoaded();
    let resolve!: (value: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    jest.useFakeTimers();

    fireEvent.submit(container.querySelector('form')!);

    expect(await screen.findByRole('button', { name: '更新中...' })).toBeDisabled();
    resolve(response(true, {}));
    expect(await screen.findByRole('button', { name: '更新' })).not.toBeDisabled();
    expectPushAfterSuccessTimer();
  });

  it('SCR-NEWS-005 断られた時はサーバーの error の文を出し、一覧へ戻さない', async () => {
    const { container } = await renderLoaded();
    mockFetch.mockResolvedValueOnce(response(false, { error: 'Forbidden' }));

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Forbidden'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-005 断られた応答に文が無い時は更新に失敗しました を出す', async () => {
    const { container } = await renderLoaded();
    mockFetch.mockResolvedValueOnce(response(false, undefined));

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('更新に失敗しました'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-005 更新の通信の例外では通信エラーが発生しました を出す', async () => {
    const { container } = await renderLoaded();
    mockFetch.mockRejectedValueOnce(new Error('network'));

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('通信エラーが発生しました'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-005 URL に id が無い時は文を出し、窓口を呼ばずフォームも出さない', async () => {
    mockParams = {};

    render(<EditNewsPage />);

    expect(await screen.findByText('記事IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(document.querySelector('form')).toBeNull();
  });

  it('SCR-NEWS-005 URL の値が取れない時も id が無い時と同じ文を出す', async () => {
    mockParams = null;

    render(<EditNewsPage />);

    expect(await screen.findByText('記事IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-005 取り出しが断られた時はサーバーの文を出し、フォームを出さない', async () => {
    mockFetch.mockResolvedValueOnce(response(false, { error: 'Not found' }));

    render(<EditNewsPage />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
  });

  it('SCR-NEWS-005 断られた応答に文が無い時は記事の読み込みに失敗しました を出す', async () => {
    mockFetch.mockResolvedValueOnce(response(false, undefined));

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
  });

  it('SCR-NEWS-005 断られた応答の JSON に error が無い時も記事の読み込みに失敗しました を出す', async () => {
    mockFetch.mockResolvedValueOnce(response(false, {}));

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
  });

  it('SCR-NEWS-005 取り出しの通信の例外では記事の読み込みに失敗しました を出す', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
  });
});
