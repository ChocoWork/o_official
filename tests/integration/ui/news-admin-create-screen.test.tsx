import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateNewsPage from '@/app/admin/news/create/page';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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

function makeFile(name: string, type: string, size = 1024) {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

// 共有の RadioButtonGroup は欄の見出しの label が選択肢の label を包むため、最初の選択肢の名前に見出しと全選択肢が混ざる。名前ではなく値で取る
function statusRadio(value: 'private' | 'published'): HTMLInputElement {
  return document.querySelector(`input[type="radio"][name="status"][value="${value}"]`) as HTMLInputElement;
}

function dropZone(): HTMLElement {
  return screen.getByText('画像をドラッグ&ドロップ').closest('[role="button"]') as HTMLElement;
}

function response(ok: boolean, body: unknown): Response {
  return {
    ok,
    status: ok ? 201 : 400,
    json: body === undefined ? async () => { throw new SyntaxError('no json'); } : async () => body,
  } as unknown as Response;
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^タイトル/), '新しい記事');
  await user.type(screen.getByLabelText(/^本文（要約）/), '要約の文');
  await user.type(screen.getByLabelText(/^本文（詳細）/), '詳細の文');
}

// 日付だけ固定する（タイマーと microtask は本物のまま）。0時をまたぐ実行で「今日」が割れないようにする
const FROZEN_NOW = new Date('2026-10-24T12:00:00.000Z');
function freezeDateOnly() {
  jest.useFakeTimers({
    now: FROZEN_NOW,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
}

describe('記事の作成の画面', () => {
  let getContextSpy: jest.SpyInstance;

  beforeEach(() => {
    freezeDateOnly();
    mockPush.mockReset();
    mockFetch.mockReset();
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    // jsdom は canvas の getContext を実装せず、SingleSelect の文字幅の計測で雑音が出るため null を返す
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    jest.useRealTimers();
  });

  it('SCR-NEWS-004 題・分類・公開日・画像・概要・本文・状態の欄と保存・キャンセルを出す', () => {
    const { container } = render(<CreateNewsPage />);

    expect(screen.getByLabelText(/^タイトル/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'カテゴリー' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^公開日/)).toHaveAttribute('type', 'date');
    expect(screen.getByText('画像')).toBeInTheDocument();
    expect(fileInput(container)).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,image/gif');
    expect(screen.getByLabelText(/^本文（要約）/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^本文（詳細）/)).toBeInTheDocument();
    expect(statusRadio('private').closest('label')).toHaveTextContent('非公開');
    expect(statusRadio('published').closest('label')).toHaveTextContent('公開');
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
  });

  it('SCR-NEWS-004 初めの値は非公開・COLLECTION・端末の今日で、題などは空', () => {
    render(<CreateNewsPage />);

    expect(statusRadio('private')).toBeChecked();
    expect(statusRadio('published')).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'カテゴリー' })).toHaveTextContent('COLLECTION');
    expect(screen.getByLabelText(/^公開日/)).toHaveValue(localToday());
    expect(screen.getByLabelText(/^タイトル/)).toHaveValue('');
    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
  });

  it('SCR-NEWS-004 分類は5つから選べる', async () => {
    const user = userEvent.setup();
    render(<CreateNewsPage />);

    await user.click(screen.getByRole('combobox', { name: 'カテゴリー' }));
    const listbox = await screen.findByRole('listbox');

    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'COLLECTION',
      'EVENT',
      'COLLABORATION',
      'SUSTAINABILITY',
      'STORE',
    ]);
  });

  it('SCR-NEWS-004 画像なしで送ると止めて文を出し、窓口へ送らない', async () => {
    const { container } = render(<CreateNewsPage />);

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像を添付してください'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-004 選んだ画像の見本と名前を出す', async () => {
    const { container } = render(<CreateNewsPage />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('spring.png', 'image/png')] } });

    expect(await screen.findByText('spring.png (新規)')).toBeInTheDocument();
    const preview = await screen.findByRole('img', { name: '画像プレビュー' });
    expect(preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByText('クリックまたはドラッグ&ドロップで画像を変更')).toBeInTheDocument();
  });

  it('SCR-NEWS-004 選択を取り消すと見本を消す', async () => {
    const { container } = render(<CreateNewsPage />);
    fireEvent.change(fileInput(container), { target: { files: [makeFile('spring.png', 'image/png')] } });
    await screen.findByRole('img', { name: '画像プレビュー' });

    fireEvent.change(fileInput(container), { target: { files: [] } });

    await waitFor(() => expect(screen.queryByRole('img', { name: '画像プレビュー' })).not.toBeInTheDocument());
    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
  });

  it('SCR-NEWS-004 JPEG・PNG・WebP・GIF の外の画像は断る', async () => {
    const { container } = render(<CreateNewsPage />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.pdf', 'application/pdf')] } });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像は JPEG / PNG / WebP / GIF を選択してください'));
    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
  });

  it('SCR-NEWS-004 5MB を超える画像は断り、ちょうど 5MB は受ける', async () => {
    const { container } = render(<CreateNewsPage />);

    fireEvent.change(fileInput(container), {
      target: { files: [makeFile('big.png', 'image/png', 5 * 1024 * 1024 + 1)] },
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像サイズは5MB以下にしてください'));

    fireEvent.change(fileInput(container), {
      target: { files: [makeFile('edge.webp', 'image/webp', 5 * 1024 * 1024)] },
    });
    expect(await screen.findByText('edge.webp (新規)')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('SCR-NEWS-004 画像をドラッグして落とすと選べる', async () => {
    render(<CreateNewsPage />);
    const zone = dropZone();

    fireEvent.dragOver(zone);
    expect(zone.className).toContain('border-black bg-black/5');
    fireEvent.dragLeave(zone);
    expect(zone.className).toContain('bg-white');

    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [makeFile('drop.gif', 'image/gif')] } });

    expect(await screen.findByText('drop.gif (新規)')).toBeInTheDocument();
    expect(zone.className).toContain('bg-white');
  });

  it('SCR-NEWS-004 何も持たずに落としても選ばない', () => {
    render(<CreateNewsPage />);
    const zone = dropZone();

    fireEvent.drop(zone, { dataTransfer: { files: [] } });

    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
  });

  it('SCR-NEWS-004 画像の欄は押す・Enter・Space でファイルの選択を開き、ほかのキーでは開かない', () => {
    const { container } = render(<CreateNewsPage />);
    const clickSpy = jest.spyOn(fileInput(container), 'click').mockImplementation(() => {});
    const zone = dropZone();

    fireEvent.click(zone);
    fireEvent.keyDown(zone, { key: 'Enter' });
    fireEvent.keyDown(zone, { key: ' ' });
    expect(clickSpy).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(zone, { key: 'a' });
    expect(clickSpy).toHaveBeenCalledTimes(3);
  });

  it('SCR-NEWS-004 見本が読めない時は文を出す', async () => {
    const readSpy = jest
      .spyOn(FileReader.prototype, 'readAsDataURL')
      .mockImplementation(function (this: FileReader) {
        this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
      });
    const { container } = render(<CreateNewsPage />);

    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像プレビューの読み込みに失敗しました'));
    expect(screen.queryByRole('img', { name: '画像プレビュー' })).not.toBeInTheDocument();
    readSpy.mockRestore();
  });

  it('SCR-NEWS-004 入れた値と画像を POST で送り、成功で保存しました を出して一覧へ戻す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(true, { data: { id: 'n1' } }));
    const { container } = render(<CreateNewsPage />);
    const image = makeFile('spring.jpg', 'image/jpeg');

    await fillRequiredFields(user);
    fireEvent.change(screen.getByLabelText(/^公開日/), { target: { value: '2026-05-01' } });
    await user.click(screen.getByRole('combobox', { name: 'カテゴリー' }));
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'STORE' }));
    await user.click(statusRadio('published'));
    fireEvent.change(fileInput(container), { target: { files: [image] } });
    await screen.findByText('spring.jpg (新規)');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('保存しました'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/admin/news');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Headers).get('x-csrf-token')).toBe(CSRF_TOKEN);
    const body = init?.body as FormData;
    expect(body.get('title')).toBe('新しい記事');
    expect(body.get('category')).toBe('STORE');
    expect(body.get('date')).toBe('2026-05-01');
    expect(body.get('content')).toBe('要約の文');
    expect(body.get('detailedContent')).toBe('詳細の文');
    expect(body.get('status')).toBe('published');
    expect((body.get('image') as File).name).toBe('spring.jpg');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin?tab=NEWS'));
  });

  it('SCR-NEWS-004 送る間はボタンを保存中にして押せなくする', async () => {
    let resolve!: (value: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    const { container } = render(<CreateNewsPage />);
    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });

    fireEvent.submit(container.querySelector('form')!);

    const busy = await screen.findByRole('button', { name: '保存中...' });
    expect(busy).toBeDisabled();
    resolve(response(true, {}));
    expect(await screen.findByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('SCR-NEWS-004 断られた時はサーバーの error の文を出し、一覧へ戻さない', async () => {
    mockFetch.mockResolvedValueOnce(response(false, { error: 'title must be at most 200 characters' }));
    const { container } = render(<CreateNewsPage />);
    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('title must be at most 200 characters'));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-004 断られた応答に文が無い時は保存に失敗しました を出す', async () => {
    mockFetch.mockResolvedValueOnce(response(false, undefined));
    const { container } = render(<CreateNewsPage />);
    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('保存に失敗しました'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-NEWS-004 通信の例外では通信エラーが発生しました を出す', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const { container } = render(<CreateNewsPage />);
    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('通信エラーが発生しました'));
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
