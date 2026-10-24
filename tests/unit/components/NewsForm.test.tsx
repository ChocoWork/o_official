import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewsForm } from '@/app/admin/news/NewsForm';

/**
 * FREQ-252: Admin の News 管理で画像アップロードを行う。
 * （FREQ-33「画像アップロードを行わない」を廃止して置き換え）
 */

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, unoptimized }: { src: string; alt: string; unoptimized?: boolean }) =>
    React.createElement('img', { src, alt, 'data-unoptimized': String(!!unoptimized) }),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

import { clientFetch } from '@/lib/client-fetch';

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const EDIT_VALUES = {
  title: 'テスト',
  category: 'COLLECTION' as const,
  date: '2026-01-01',
  content: '要約',
  detailedContent: '詳細',
  status: 'published' as const,
};

function makeFile(name: string, type: string, size = 1024) {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('NewsForm 画像アップロード (FREQ-252)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('DD-NEWS-061 作成モード: 画像アップロード欄が存在する', () => {
    // FREQ-252-AC-01
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    expect(screen.getByText('画像')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  test('DD-NEWS-061 編集モード: 画像アップロード欄が存在する', () => {
    // FREQ-252-AC-01
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    expect(screen.getByText('画像')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  test('DD-NEWS-061 受け付ける MIME を accept で制限する', () => {
    // FREQ-252-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    expect(container.querySelector('input[type="file"]')).toHaveAttribute(
      'accept',
      'image/jpeg,image/png,image/webp,image/gif',
    );
  });

  test('DD-NEWS-061 対象外の MIME は受け付けない', async () => {
    // FREQ-252-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const input = container.querySelector('input[type="file"]')!;

    fireEvent.change(input, { target: { files: [makeFile('a.pdf', 'application/pdf')] } });

    expect(
      await screen.findByText('画像は JPEG / PNG / WebP / GIF を選択してください'),
    ).toBeInTheDocument();
  });

  test('DD-NEWS-061 5MB を超える画像は受け付けない', async () => {
    // FREQ-252-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const input = container.querySelector('input[type="file"]')!;

    fireEvent.change(input, {
      target: { files: [makeFile('big.png', 'image/png', 6 * 1024 * 1024)] },
    });

    expect(await screen.findByText('画像サイズは5MB以下にしてください')).toBeInTheDocument();
  });

  test('DD-NEWS-061 作成モードは画像必須で、未添付なら送信しない', async () => {
    // FREQ-252-AC-02
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    fireEvent.submit(container.querySelector('form')!);

    expect(await screen.findByText('画像を添付してください')).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  test('DD-NEWS-061 編集モードは画像未選択でも送信できる', async () => {
    // FREQ-252-AC-02
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled());
    expect(screen.queryByText('画像を添付してください')).not.toBeInTheDocument();
  });
});

describe('NewsForm のカテゴリーの選択欄（FREQ-515）', () => {
  // jsdom は canvas の getContext を実装せず「Not implemented」を console.error に出す（SingleSelect が文字の幅を測るために呼ぶ）。
  // jsdom の答えも null なので、動きは変えずに null を返す差し替えにして雑音だけを消す
  let getContextSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  async function chooseCategory(label: string) {
    const user = userEvent.setup();
    const combobox = screen.getByRole('combobox', { name: 'カテゴリー' });
    await user.click(combobox);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: label }));
    expect(combobox).toHaveTextContent(label);
  }

  async function submittedCategory(container: HTMLElement) {
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled());
    const body = mockClientFetch.mock.calls[0][1]?.body as FormData;
    return body.get('category');
  }

  test('DD-NEWS-061 作成モード: 選んだカテゴリーを送る', async () => {
    // FREQ-515-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('a.png', 'image/png')] },
    });

    await chooseCategory('EVENT');

    expect(await submittedCategory(container)).toBe('EVENT');
  });

  test('DD-NEWS-061 編集モード: 選んだカテゴリーを送る', async () => {
    // FREQ-515-AC-03
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    await chooseCategory('STORE');

    expect(await submittedCategory(container)).toBe('STORE');
  });
});


type ReaderBehavior = 'load' | 'load-non-string' | 'error' | 'pending';

class MockFileReader {
  static behavior: ReaderBehavior = 'load';
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(file: File) {
    switch (MockFileReader.behavior) {
      case 'load':
        this.result = `data:${file.type};base64,${file.name}`;
        this.onload?.();
        break;
      case 'load-non-string':
        this.result = new ArrayBuffer(1);
        this.onload?.();
        break;
      case 'error':
        this.onerror?.();
        break;
      case 'pending':
        break;
    }
  }
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

describe('NewsForm 欄・画像・送信の分岐', () => {
  const originalFileReader = window.FileReader;
  let getContextSpy: jest.SpyInstance;
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledTimers: Array<{ callback: () => void; delay: number | undefined }> = [];

  beforeEach(() => {
    freezeDateOnly();
    jest.clearAllMocks();
    MockFileReader.behavior = 'load';
    window.FileReader = MockFileReader as unknown as typeof FileReader;
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    // jest.spyOn だと Testing Library が偽のタイマーと見なして待ち方を変えるので、素の関数で包む
    scheduledTimers = [];
    globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
      scheduledTimers.push({ callback, delay });
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
  });

  afterEach(() => {
    window.FileReader = originalFileReader;
    getContextSpy.mockRestore();
    globalThis.setTimeout = originalSetTimeout;
    jest.useRealTimers();
  });

  // 前のテストの成功で積まれた 500ms の移動が後から mockPush を呼ぶことがあるので、
  // このテストで積まれたタイマーの callback を取り出して直接走らせる
  function navigationTimers(): Array<() => void> {
    return scheduledTimers.filter(({ delay }) => delay === 500).map(({ callback }) => callback);
  }

  function expectNavigationAfter500ms() {
    const timers = navigationTimers();
    expect(timers).toHaveLength(1);
    mockPush.mockClear();
    act(() => timers[0]());
    expect(mockPush).toHaveBeenCalledWith('/admin?tab=NEWS');
  }

  function fileInput(container: HTMLElement) {
    return container.querySelector('input[type="file"]') as HTMLInputElement;
  }

  function dropZone(container: HTMLElement) {
    return container.querySelector('div[role="button"]') as HTMLDivElement;
  }

  function selectFile(container: HTMLElement, file: File) {
    fireEvent.change(fileInput(container), { target: { files: [file] } });
  }

  function submit(container: HTMLElement) {
    fireEvent.submit(container.querySelector('form')!);
  }

  function sentBody(): FormData {
    return mockClientFetch.mock.calls[0][1]?.body as FormData;
  }

  function localToday(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  test('DD-NEWS-061 initialValues が無い時は分類 COLLECTION・状態「非公開」・公開日が端末の今日になる', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    expect(screen.getByRole('combobox', { name: 'カテゴリー' })).toHaveTextContent('COLLECTION');
    expect(container.querySelector('input[type="radio"][value="private"]')).toBeChecked();
    expect(container.querySelector('input[type="radio"][value="published"]')).not.toBeChecked();
    expect(container.querySelector('input[name="date"]')).toHaveValue(localToday());
    expect(container.querySelector('input[name="title"]')).toHaveValue('');
    expect(container.querySelector('textarea[name="content"]')).toHaveValue('');
    expect(container.querySelector('textarea[name="detailedContent"]')).toHaveValue('');
  });

  test('DD-NEWS-061 initialValues を渡すと欄に入り、後から別の initialValues を渡すと上書きされる', () => {
    const { container, rerender } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    expect(container.querySelector('input[name="title"]')).toHaveValue('テスト');
    expect(container.querySelector('input[name="date"]')).toHaveValue('2026-01-01');
    expect(container.querySelector('textarea[name="content"]')).toHaveValue('要約');
    expect(container.querySelector('textarea[name="detailedContent"]')).toHaveValue('詳細');
    expect(container.querySelector('input[type="radio"][value="published"]')).toBeChecked();

    rerender(
      <NewsForm
        submitUrl="/api/admin/news/1"
        submitMethod="PUT"
        initialValues={{ ...EDIT_VALUES, title: '読み直した題', category: 'EVENT', status: 'private' }}
      />,
    );

    expect(container.querySelector('input[name="title"]')).toHaveValue('読み直した題');
    expect(screen.getByRole('combobox', { name: 'カテゴリー' })).toHaveTextContent('EVENT');
    expect(container.querySelector('input[type="radio"][value="private"]')).toBeChecked();
  });

  test('DD-NEWS-061 initialValues が後から無くなっても入力中の値は消えない', () => {
    const { container, rerender } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    rerender(<NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" />);

    expect(container.querySelector('input[name="title"]')).toHaveValue('テスト');
  });

  test('DD-NEWS-061 画像の欄を押す・Enter・Space で file の入力が開き、ほかのキーでは開かない', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    // 本物の click は file の入力から枠へ click が浮き上がり、枠がもう一度開こうとするので数が狂う
    const clickSpy = jest.spyOn(fileInput(container), 'click').mockImplementation(() => undefined);
    const zone = dropZone(container);

    fireEvent.keyDown(zone, { key: 'a' });
    expect(clickSpy).not.toHaveBeenCalled();

    fireEvent.click(zone);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(zone, { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalledTimes(2);

    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    fireEvent(zone, spaceEvent);
    expect(clickSpy).toHaveBeenCalledTimes(3);
    expect(spaceEvent.defaultPrevented).toBe(true);
  });

  test('DD-NEWS-061 ドラッグの間は枠の見た目が変わり、離れると戻る', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const zone = dropZone(container);

    expect(zone).toHaveClass('bg-white');

    fireEvent.dragOver(zone);
    expect(zone).toHaveClass('border-black', 'bg-black/5');
    expect(zone).not.toHaveClass('bg-white');

    fireEvent.dragLeave(zone);
    expect(zone).toHaveClass('bg-white');
    expect(zone).not.toHaveClass('bg-black/5');
  });

  test('DD-NEWS-061 落とした画像を受けて見本と「<名前> (新規)」が出て、枠の見た目が戻る', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const zone = dropZone(container);

    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [makeFile('dropped.webp', 'image/webp')] } });

    expect(zone).toHaveClass('bg-white');
    expect(screen.getByText('dropped.webp (新規)')).toBeInTheDocument();
    const preview = screen.getByAltText('画像プレビュー');
    expect(preview).toHaveAttribute('src', 'data:image/webp;base64,dropped.webp');
    expect(preview).toHaveAttribute('data-unoptimized', 'true');
  });

  test('DD-NEWS-061 落とした物にファイルが無い時は画像を外す', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const zone = dropZone(container);
    selectFile(container, makeFile('a.png', 'image/png'));
    expect(screen.getByText('a.png (新規)')).toBeInTheDocument();

    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(screen.queryByText('a.png (新規)')).not.toBeInTheDocument();
    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();

    selectFile(container, makeFile('b.png', 'image/png'));
    expect(screen.getByText('b.png (新規)')).toBeInTheDocument();

    fireEvent.drop(zone, { dataTransfer: {} });
    expect(screen.queryByText('b.png (新規)')).not.toBeInTheDocument();
    expect(screen.queryByAltText('画像プレビュー')).not.toBeInTheDocument();
  });

  test('DD-NEWS-061 選択を空にした時は画像を外す', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    selectFile(container, makeFile('a.png', 'image/png'));
    expect(screen.getByText('a.png (新規)')).toBeInTheDocument();

    fireEvent.change(fileInput(container), { target: { files: [] } });
    expect(screen.queryByText('a.png (新規)')).not.toBeInTheDocument();

    selectFile(container, makeFile('b.png', 'image/png'));
    expect(screen.getByText('b.png (新規)')).toBeInTheDocument();

    fireEvent.change(fileInput(container), { target: { files: null } });
    expect(screen.queryByText('b.png (新規)')).not.toBeInTheDocument();
    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
  });

  test('DD-NEWS-061 4つの外の種類・5MB 超の画像は文を出し、持っている画像は変えない', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    selectFile(container, makeFile('keep.gif', 'image/gif'));

    selectFile(container, makeFile('a.svg', 'image/svg+xml'));
    expect(screen.getByText('画像は JPEG / PNG / WebP / GIF を選択してください')).toBeInTheDocument();
    expect(screen.getByText('keep.gif (新規)')).toBeInTheDocument();

    selectFile(container, makeFile('big.jpg', 'image/jpeg', 5 * 1024 * 1024 + 1));
    expect(screen.getByText('画像サイズは5MB以下にしてください')).toBeInTheDocument();
    expect(screen.getByText('keep.gif (新規)')).toBeInTheDocument();
  });

  test('DD-NEWS-061 ちょうど 5MB の画像は受けて前の文を消す', () => {
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    selectFile(container, makeFile('a.pdf', 'application/pdf'));
    expect(screen.getByText('画像は JPEG / PNG / WebP / GIF を選択してください')).toBeInTheDocument();

    selectFile(container, makeFile('edge.jpg', 'image/jpeg', 5 * 1024 * 1024));

    expect(screen.getByText('edge.jpg (新規)')).toBeInTheDocument();
    expect(
      screen.queryByText('画像は JPEG / PNG / WebP / GIF を選択してください'),
    ).not.toBeInTheDocument();
  });

  test('DD-NEWS-061 FileReader の失敗で「画像プレビューの読み込みに失敗しました」が出て見本が出ない', () => {
    MockFileReader.behavior = 'error';
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    selectFile(container, makeFile('a.png', 'image/png'));

    expect(screen.getByText('画像プレビューの読み込みに失敗しました')).toBeInTheDocument();
    expect(screen.queryByAltText('画像プレビュー')).not.toBeInTheDocument();
  });

  test('DD-NEWS-061 読み込みの結果が文字でない時は見本も文も出ない', () => {
    MockFileReader.behavior = 'load-non-string';
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    selectFile(container, makeFile('a.png', 'image/png'));

    expect(screen.queryByAltText('画像プレビュー')).not.toBeInTheDocument();
    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  test('DD-NEWS-061 画像を選ばず existingImageUrl がある時は「現在の画像」を最適化の中継を通して出す', () => {
    render(
      <NewsForm
        submitUrl="/api/admin/news/1"
        submitMethod="PUT"
        initialValues={EDIT_VALUES}
        existingImageUrl="https://example.supabase.co/storage/v1/object/sign/news/a.jpg"
      />,
    );

    expect(screen.getByText('現在の画像')).toBeInTheDocument();
    const image = screen.getByAltText('画像プレビュー');
    expect(image).toHaveAttribute(
      'src',
      'https://example.supabase.co/storage/v1/object/sign/news/a.jpg',
    );
    expect(image).toHaveAttribute('data-unoptimized', 'false');
    expect(screen.getByText('クリックまたはドラッグ&ドロップで画像を変更')).toBeInTheDocument();
  });

  test('DD-NEWS-061 画像も existingImageUrl も無い時は「画像をドラッグ&ドロップ」が出る', () => {
    render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
    expect(screen.queryByAltText('画像プレビュー')).not.toBeInTheDocument();
  });

  test('DD-NEWS-061 選んだ画像の見本を読み終える前は既にある画像のまま「<名前> (新規)」と書く', () => {
    MockFileReader.behavior = 'pending';
    const { container } = render(
      <NewsForm
        submitUrl="/api/admin/news/1"
        submitMethod="PUT"
        initialValues={EDIT_VALUES}
        existingImageUrl="/current.jpg"
      />,
    );

    selectFile(container, makeFile('next.png', 'image/png'));

    expect(screen.getByText('next.png (新規)')).toBeInTheDocument();
    expect(screen.getByAltText('画像プレビュー')).toHaveAttribute('src', '/current.jpg');
  });

  test('DD-NEWS-061 作成で画像を付けると POST の multipart に6つの欄と image が入る', async () => {
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const image = makeFile('a.png', 'image/png');

    fireEvent.change(container.querySelector('input[name="title"]')!, { target: { value: '新しい題' } });
    fireEvent.change(container.querySelector('input[name="date"]')!, { target: { value: '2026-05-05' } });
    fireEvent.change(container.querySelector('textarea[name="content"]')!, { target: { value: '要約文' } });
    fireEvent.change(container.querySelector('textarea[name="detailedContent"]')!, {
      target: { value: '詳細文' },
    });
    selectFile(container, image);
    submit(container);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));
    expect(mockClientFetch.mock.calls[0][0]).toBe('/api/admin/news');
    expect(mockClientFetch.mock.calls[0][1]?.method).toBe('POST');
    const body = sentBody();
    expect(body.get('title')).toBe('新しい題');
    expect(body.get('category')).toBe('COLLECTION');
    expect(body.get('date')).toBe('2026-05-05');
    expect(body.get('content')).toBe('要約文');
    expect(body.get('detailedContent')).toBe('詳細文');
    expect(body.get('status')).toBe('private');
    expect((body.get('image') as File).name).toBe('a.png');
  });

  test('DD-NEWS-061 編集で画像が無いと image を入れずに PUT する', async () => {
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/7" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    submit(container);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));
    expect(mockClientFetch.mock.calls[0][0]).toBe('/api/admin/news/7');
    expect(mockClientFetch.mock.calls[0][1]?.method).toBe('PUT');
    const body = sentBody();
    expect(body.has('image')).toBe(false);
    expect(body.get('title')).toBe('テスト');
    expect(body.get('status')).toBe('published');
  });

  test('DD-NEWS-061 状態のラジオで選んだ値が送られる', async () => {
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    selectFile(container, makeFile('a.png', 'image/png'));

    fireEvent.click(container.querySelector('input[type="radio"][value="published"]')!);
    expect(container.querySelector('input[type="radio"][value="published"]')).toBeChecked();
    submit(container);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));
    expect(sentBody().get('status')).toBe('published');
  });

  test('DD-NEWS-061 作成で送る間は「保存中...」でボタンが止まる', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    mockClientFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    selectFile(container, makeFile('a.png', 'image/png'));

    submit(container);

    expect(await screen.findByRole('button', { name: '保存中...' })).toBeDisabled();
    resolveFetch({ ok: true, json: async () => ({}) } as Response);
    expect(await screen.findByRole('button', { name: '保存' })).toBeEnabled();
  });

  test('DD-NEWS-061 編集で送る間は「更新中...」でボタンが止まる', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    mockClientFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();

    submit(container);

    expect(await screen.findByRole('button', { name: '更新中...' })).toBeDisabled();
    resolveFetch({ ok: true, json: async () => ({}) } as Response);
    expect(await screen.findByRole('button', { name: '更新' })).toBeEnabled();
  });

  test('DD-NEWS-061 作成の成功で「保存しました」が出て、500ms 後に /admin?tab=NEWS へ移る', async () => {
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    selectFile(container, makeFile('a.png', 'image/png'));

    submit(container);

    expect(await screen.findByText('保存しました')).toBeInTheDocument();
    expectNavigationAfter500ms();
  });

  test('DD-NEWS-061 編集の成功で「更新しました」が出て、500ms 後に /admin?tab=NEWS へ移る', async () => {
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    submit(container);

    expect(await screen.findByText('更新しました')).toBeInTheDocument();
    expectNavigationAfter500ms();
  });

  test('DD-NEWS-061 応答が OK でなく error がある時はその文が出る', async () => {
    mockClientFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Invalid request' }),
    } as Response);
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    submit(container);

    expect(await screen.findByText('Invalid request')).toBeInTheDocument();
    expect(screen.queryByText('更新しました')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();
  });

  test('DD-NEWS-061 作成で応答が OK でなく error が無い時は「保存に失敗しました」が出る', async () => {
    mockClientFetch.mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    selectFile(container, makeFile('a.png', 'image/png'));

    submit(container);

    expect(await screen.findByText('保存に失敗しました')).toBeInTheDocument();
  });

  test('DD-NEWS-061 作成で応答が OK でなく JSON で読めない時は「保存に失敗しました」が出る', async () => {
    mockClientFetch.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    selectFile(container, makeFile('a.png', 'image/png'));

    submit(container);

    expect(await screen.findByText('保存に失敗しました')).toBeInTheDocument();
  });

  test('DD-NEWS-061 編集で応答が OK でなく error が無い時は「更新に失敗しました」が出る', async () => {
    mockClientFetch.mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    submit(container);

    expect(await screen.findByText('更新に失敗しました')).toBeInTheDocument();
  });

  test('DD-NEWS-061 編集で応答が OK でなく JSON で読めない時は「更新に失敗しました」が出る', async () => {
    mockClientFetch.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    submit(container);

    expect(await screen.findByText('更新に失敗しました')).toBeInTheDocument();
  });

  test('DD-NEWS-061 送る途中の例外で「通信エラーが発生しました」が出る', async () => {
    mockClientFetch.mockRejectedValue(new Error('network'));
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    submit(container);

    expect(await screen.findByText('通信エラーが発生しました')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();
    expect(navigationTimers()).toHaveLength(0);
  });

  test('DD-NEWS-061 キャンセルで /admin?tab=NEWS へ移る', () => {
    render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    mockPush.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(mockPush).toHaveBeenCalledWith('/admin?tab=NEWS');
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});
