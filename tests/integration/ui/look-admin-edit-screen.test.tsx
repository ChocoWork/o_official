import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminLookEditPage from '@/app/admin/look/edit/[id]/page';

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

const ITEMS = [
  { id: 101, name: 'リネンシャツ', price: 12000, image_url: 'https://example.test/signed/101.jpg', status: 'published' },
  { id: 102, name: 'ウールパンツ', price: 18500, image_url: 'https://example.test/signed/102.jpg', status: 'published' },
];

const LOOK = {
  id: 42,
  season_year: 2027,
  season_type: 'SS' as const,
  theme: 'Quiet Layers',
  theme_description: '重ねの静けさ',
  image_urls: ['https://example.test/signed/42-a.jpg', 'https://example.test/signed/42-b.jpg'],
  status: 'published' as const,
  linkedItemIds: [102],
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

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function itemCard(name: string): HTMLElement {
  return screen.getByText(name).closest('div[class*="cursor-pointer"]') as HTMLElement;
}

// 1件の取り出し・商品の取り出し・更新の送信を URL と方法で振り分ける
let lookResult: () => Promise<Response>;
let itemsResult: () => Promise<Response>;
let submitResult: () => Promise<Response>;

function lookCalls() {
  return mockFetch.mock.calls.filter(([url, init]) => url === '/api/admin/looks/42' && (init as RequestInit).method === 'GET');
}

function submitCalls() {
  return mockFetch.mock.calls.filter(([url, init]) => url === '/api/admin/looks/42' && (init as RequestInit).method === 'PUT');
}

async function renderLoaded() {
  const utils = render(<AdminLookEditPage />);
  await screen.findByDisplayValue('Quiet Layers');
  await screen.findByText('リネンシャツ');
  return utils;
}

// 日付だけ固定する（タイマーと microtask は本物のまま）。年の選択肢が実行日で変わらないようにする
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

describe('LOOK の編集の画面', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    freezeDateOnly();
    mockParams = { id: '42' };
    mockPush.mockReset();
    mockFetch.mockReset();
    lookResult = async () => response(true, { data: LOOK });
    itemsResult = async () => response(true, { data: ITEMS });
    submitResult = async () => response(true, { data: LOOK });
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/admin/items') return itemsResult();
      return init?.method === 'PUT' ? submitResult() : lookResult();
    });
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    // jsdom は canvas の getContext を実装せず、SingleSelect の文字幅の計測で雑音が出るため null を返す
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    errorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('SCR-LOOK-008 読み込みの間は読み込み中を出し、URL の id の LOOK を管理の窓口から取る', async () => {
    render(<AdminLookEditPage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Quiet Layers')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(lookCalls()).toHaveLength(1);
    const init = lookCalls()[0][1] as RequestInit;
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect((init.headers as Headers).has('x-csrf-token')).toBe(false);
  });

  it('SCR-LOOK-008 取り出した LOOK の今の値をフォームに詰める', async () => {
    await renderLoaded();

    const [year, season] = screen.getAllByRole('combobox');
    expect(year).toHaveTextContent('2027');
    expect(season).toHaveTextContent('SS');
    expect(screen.getByLabelText(/^シーズンテーマ(?!詳細)/)).toHaveValue('Quiet Layers');
    expect(screen.getByLabelText(/^シーズンテーマ詳細/)).toHaveValue('重ねの静けさ');
    expect(statusRadio('published')).toBeChecked();
    expect(statusRadio('private')).not.toBeChecked();
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
  });

  it('SCR-LOOK-008 紐づけてある商品だけを選んだ状態にする', async () => {
    await renderLoaded();

    expect(itemCard('ウールパンツ').className).toContain('ring-1 ring-black');
    expect(itemCard('リネンシャツ').className).not.toContain('ring-1 ring-black');
  });

  it('SCR-LOOK-008 既にある画像を登録済みの画像として見本に出し、置き換えの注意を添える', async () => {
    await renderLoaded();

    expect(screen.getByRole('img', { name: '登録済み画像 1' })).toHaveAttribute('src', LOOK.image_urls[0]);
    expect(screen.getByRole('img', { name: '登録済み画像 2' })).toHaveAttribute('src', LOOK.image_urls[1]);
    expect(screen.getByText('新規画像を追加して保存すると、画像は新規選択分に置き換わります')).toBeInTheDocument();
  });

  it('SCR-LOOK-008 画像を選び直すと登録済みの見本を新しい見本に差し替える', async () => {
    const { container } = await renderLoaded();

    fireEvent.change(fileInput(container), { target: { files: [makeFile('new.png', 'image/png')] } });

    const preview = await screen.findByRole('img', { name: 'プレビュー 1' });
    expect(preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(screen.queryByRole('img', { name: /^登録済み画像/ })).not.toBeInTheDocument();
  });

  it('SCR-LOOK-008 テーマ詳細・商品・画像の欄が窓口に無い時は空として詰める', async () => {
    lookResult = async () =>
      response(true, { data: { ...LOOK, theme_description: null, linkedItemIds: undefined, image_urls: undefined } });
    const { container } = render(<AdminLookEditPage />);
    await screen.findByDisplayValue('Quiet Layers');
    await screen.findByText('リネンシャツ');

    expect(screen.getByLabelText(/^シーズンテーマ詳細/)).toHaveValue('');
    expect(itemCard('ウールパンツ').className).not.toContain('ring-1 ring-black');
    expect(screen.queryByRole('img', { name: /^登録済み画像/ })).not.toBeInTheDocument();
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('紐づける商品を1つ以上選択してください'));
  });

  it('SCR-LOOK-008 画像を選ばずに PUT で送れ、画像の欄は送らない', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.clear(screen.getByLabelText(/^シーズンテーマ(?!詳細)/));
    await user.type(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), '直したテーマ');
    await user.click(statusRadio('private'));
    await user.click(screen.getByText('リネンシャツ'));
    await user.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lookを更新しました'));
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(submitCalls()).toHaveLength(1);
    const [url, init] = submitCalls()[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/looks/42');
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Headers).get('x-csrf-token')).toBe(CSRF_TOKEN);
    const body = init.body as FormData;
    expect(body.get('seasonYear')).toBe('2027');
    expect(body.get('seasonType')).toBe('SS');
    expect(body.get('theme')).toBe('直したテーマ');
    expect(body.get('themeDescription')).toBe('重ねの静けさ');
    expect(body.get('status')).toBe('private');
    expect(JSON.parse(body.get('linkedItemIds') as string).sort()).toEqual([101, 102]);
    expect(body.has('images')).toBe(false);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin?tab=LOOK'));
  });

  it('SCR-LOOK-008 選び直した画像は送る', async () => {
    const { container } = await renderLoaded();
    fireEvent.change(fileInput(container), { target: { files: [makeFile('new.webp', 'image/webp')] } });
    await screen.findByRole('img', { name: 'プレビュー 1' });

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    const body = (submitCalls()[0][1] as RequestInit).body as FormData;
    expect(body.getAll('images').map((f) => (f as File).name)).toEqual(['new.webp']);
  });

  it('SCR-LOOK-008 登録済みの画像が無く新しい画像も無い時は止めて文を出し、送らない', async () => {
    lookResult = async () => response(true, { data: { ...LOOK, image_urls: [] } });
    const { container } = await renderLoaded();

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像を1枚以上追加してください'));
    expect(submitCalls()).toHaveLength(0);
  });

  it('SCR-LOOK-008 テーマを空にすると止めて文を出し、送らない', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();

    await user.clear(screen.getByLabelText(/^シーズンテーマ(?!詳細)/));
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('シーズンテーマを入力してください'));
    expect(submitCalls()).toHaveLength(0);
  });

  it('SCR-LOOK-008 送る間はボタンを更新中にして押せなくする', async () => {
    const { container } = await renderLoaded();
    let resolve!: (value: Response) => void;
    submitResult = () => new Promise<Response>((r) => { resolve = r; });

    fireEvent.submit(container.querySelector('form')!);

    expect(await screen.findByRole('button', { name: '更新中...' })).toBeDisabled();
    resolve(response(true, {}));
    expect(await screen.findByRole('button', { name: '更新' })).not.toBeDisabled();
  });

  it('SCR-LOOK-008 断られた時はサーバーの error の文を出し、一覧へ戻さない', async () => {
    const { container } = await renderLoaded();
    submitResult = async () => response(false, { error: 'Forbidden' });

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Forbidden'));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-008 断られた応答に文が無い時は Lookの更新に失敗しました を出す', async () => {
    const { container } = await renderLoaded();
    submitResult = async () => response(false, undefined);

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Lookの更新に失敗しました'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-008 更新の通信の例外では通信エラーが発生しました を出す', async () => {
    const { container } = await renderLoaded();
    submitResult = async () => { throw new Error('network'); };

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('通信エラーが発生しました。時間をおいて再度お試しください'),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-008 URL に id が無い時は文を出し、窓口を呼ばずフォームも出さない', async () => {
    mockParams = {};

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOK IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(document.querySelector('form')).toBeNull();
  });

  it('SCR-LOOK-008 URL の値が取れない時も id が無い時と同じ文を出す', async () => {
    mockParams = null;

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOK IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-008 取り出しが断られた時はサーバーの文を出し、フォームを出さない', async () => {
    lookResult = async () => response(false, { error: 'Not found' });

    render(<AdminLookEditPage />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('SCR-LOOK-008 断られた応答に文が無い時は LOOKの取得に失敗しました を出す', async () => {
    lookResult = async () => response(false, undefined);

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
  });

  it('SCR-LOOK-008 断られた応答の JSON に error が無い時も LOOKの取得に失敗しました を出す', async () => {
    lookResult = async () => response(false, {});

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
  });

  it('SCR-LOOK-008 成功でも data が無い時は LOOKの取得に失敗しました を出し、フォームを出さない', async () => {
    lookResult = async () => response(true, {});

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
  });

  it('SCR-LOOK-008 取り出しの通信の例外では LOOKの取得に失敗しました を出す', async () => {
    lookResult = async () => { throw new Error('network'); };

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
  });
});
