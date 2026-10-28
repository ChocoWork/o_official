import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminLookCreatePage from '@/app/admin/look/create/page';

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

const ITEMS = [
  { id: 101, name: 'リネンシャツ', price: 12000, image_url: 'https://example.test/signed/101.jpg', status: 'published' },
  { id: 102, name: 'ウールパンツ', price: 18500, image_url: 'https://example.test/signed/102.jpg', status: 'private' },
];

function makeFile(name: string, type: string, size = 1024) {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
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

// 商品の取り出しと保存の送信を URL で振り分ける（LookForm は開くと商品を取り、送る前に順番が入れ替わらないようにする）
let itemsResult: () => Promise<Response>;
let submitResult: () => Promise<Response>;

function submitCalls() {
  return mockFetch.mock.calls.filter(([url]) => url === '/api/admin/looks');
}

async function renderLoaded() {
  const utils = render(<AdminLookCreatePage />);
  await screen.findByText('リネンシャツ');
  return utils;
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
  await user.type(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), '  Effortless Elegance  ');
  await user.type(screen.getByLabelText(/^シーズンテーマ詳細/), '  静かな上品さ  ');
  await user.click(screen.getByText('リネンシャツ'));
  fireEvent.change(fileInput(container), { target: { files: [makeFile('look1.jpg', 'image/jpeg')] } });
  await screen.findByRole('img', { name: 'プレビュー 1' });
}

// 日付だけ固定する（タイマーと microtask は本物のまま）。0時をまたぐ実行で「今のシーズン」が割れないようにする
const FROZEN_NOW = new Date('2026-10-24T12:00:00.000Z');
function freezeDateOnly(now: Date = FROZEN_NOW) {
  jest.useFakeTimers({
    now,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
}

describe('LOOK の作成の画面', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    freezeDateOnly();
    mockPush.mockReset();
    mockFetch.mockReset();
    itemsResult = async () => response(true, { data: ITEMS });
    submitResult = async () => response(true, { data: { id: 7 } });
    mockFetch.mockImplementation((url: string) => (url === '/api/admin/items' ? itemsResult() : submitResult()));
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

  it('SCR-LOOK-007 画像・シーズン・テーマ・詳細・紐づける商品・状態の欄と保存・キャンセルを出す', async () => {
    const { container } = await renderLoaded();

    expect(screen.getByText('画像')).toBeInTheDocument();
    expect(fileInput(container)).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,image/gif');
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(screen.getByLabelText(/^シーズンテーマ(?!詳細)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^シーズンテーマ詳細/)).toBeInTheDocument();
    expect(screen.getByText('紐づける商品を選択')).toBeInTheDocument();
    expect(statusRadio('private').closest('label')).toHaveTextContent('非公開');
    expect(statusRadio('published').closest('label')).toHaveTextContent('公開');
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
  });

  it('SCR-LOOK-007 商品の画像の署名が null の 1 件は、落ちずに /placeholder.png を出し、他の件は今のまま', async () => {
    itemsResult = async () => response(true, { data: [{ ...ITEMS[0], image_url: null }, ITEMS[1]] });
    await renderLoaded();

    expect(screen.getByAltText('リネンシャツ')).toHaveAttribute('src', '/placeholder.png');
    expect(screen.getByAltText('ウールパンツ')).toHaveAttribute('src', 'https://example.test/signed/102.jpg');
  });

  it('SCR-LOOK-007 作成の画面には画像の置き換えの注意を出さない', async () => {
    await renderLoaded();

    expect(screen.queryByText(/画像は新規選択分に置き換わります/)).not.toBeInTheDocument();
  });

  it('SCR-LOOK-007 初めの値は非公開・今の年とシーズンで、テーマなどは空', async () => {
    await renderLoaded();

    const [year, season] = screen.getAllByRole('combobox');
    expect(year).toHaveTextContent('2026');
    expect(season).toHaveTextContent('AW');
    expect(statusRadio('private')).toBeChecked();
    expect(statusRadio('published')).not.toBeChecked();
    expect(screen.getByLabelText(/^シーズンテーマ(?!詳細)/)).toHaveValue('');
    expect(screen.getByLabelText(/^シーズンテーマ詳細/)).toHaveValue('');
    expect(screen.getByText('画像をドラッグ&ドロップ')).toBeInTheDocument();
  });

  it('SCR-LOOK-007 7月より前の初めのシーズンは SS になる', async () => {
    jest.useRealTimers();
    freezeDateOnly(new Date('2026-03-15T12:00:00.000Z'));

    await renderLoaded();

    expect(screen.getAllByRole('combobox')[1]).toHaveTextContent('SS');
  });

  it('SCR-LOOK-007 年は去年から3年先までの4つ、シーズンは SS と AW から選べる', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const [year, season] = screen.getAllByRole('combobox');

    await user.click(year);
    const yearList = await screen.findByRole('listbox');
    expect(within(yearList).getAllByRole('option').map((o) => o.textContent)).toEqual(['2025', '2026', '2027', '2028']);
    await user.keyboard('{Escape}');

    await user.click(season);
    const seasonList = await screen.findByRole('listbox');
    expect(within(seasonList).getAllByRole('option').map((o) => o.textContent)).toEqual(['SS', 'AW']);
  });

  it('SCR-LOOK-007 開くと商品を管理の窓口から取り、取り出す間は読み込み中を出す', async () => {
    let resolve!: (value: Response) => void;
    itemsResult = () => new Promise<Response>((r) => { resolve = r; });

    render(<AdminLookCreatePage />);

    expect(screen.getByText('商品を読み込み中です...')).toBeInTheDocument();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/items');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect((init.headers as Headers).has('x-csrf-token')).toBe(false);
    resolve(response(true, { data: ITEMS }));
    expect(await screen.findByText('リネンシャツ')).toBeInTheDocument();
    expect(screen.queryByText('商品を読み込み中です...')).not.toBeInTheDocument();
  });

  it('SCR-LOOK-007 商品の名前・価格・画像を出し、非公開の商品には印を付ける', async () => {
    await renderLoaded();

    const published = screen.getByText('リネンシャツ').closest('div[class*="cursor-pointer"]') as HTMLElement;
    expect(within(published).getByRole('img', { name: 'リネンシャツ' })).toHaveAttribute('src', ITEMS[0].image_url);
    expect(published).toHaveTextContent(/12,000/);
    expect(within(published).queryByText('非公開商品')).not.toBeInTheDocument();

    const hidden = screen.getByText('ウールパンツ').closest('div[class*="cursor-pointer"]') as HTMLElement;
    expect(hidden).toHaveTextContent(/18,500/);
    expect(within(hidden).getByText('非公開商品')).toBeInTheDocument();
  });

  it('SCR-LOOK-007 商品が1つも無い時は先に ITEM を登録する旨を出す', async () => {
    itemsResult = async () => response(true, { data: [] });

    render(<AdminLookCreatePage />);

    expect(await screen.findByText('登録済み商品がありません。先にITEMを登録してください。')).toBeInTheDocument();
  });

  it('SCR-LOOK-007 応答の data が配列でない時も商品なしとして出す', async () => {
    itemsResult = async () => response(true, { data: 'oops' });

    render(<AdminLookCreatePage />);

    expect(await screen.findByText('登録済み商品がありません。先にITEMを登録してください。')).toBeInTheDocument();
  });

  it('SCR-LOOK-007 商品の取り出しが断られた時は商品一覧の取得に失敗しました を出す', async () => {
    itemsResult = async () => response(false, { error: 'x' });

    render(<AdminLookCreatePage />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('商品一覧の取得に失敗しました'));
    expect(screen.getByText('登録済み商品がありません。先にITEMを登録してください。')).toBeInTheDocument();
  });

  it('SCR-LOOK-007 商品の取り出しの通信の例外でも商品一覧の取得に失敗しました を出す', async () => {
    itemsResult = async () => { throw new Error('network'); };

    render(<AdminLookCreatePage />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('商品一覧の取得に失敗しました'));
  });

  it('SCR-LOOK-007 テーマが空だと止めて文を出し、窓口へ送らない', async () => {
    const { container } = await renderLoaded();

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('シーズンテーマを入力してください'));
    expect(submitCalls()).toHaveLength(0);
  });

  it('SCR-LOOK-007 テーマが空白だけでも空と同じに止める', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();

    await user.type(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), '   ');
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('シーズンテーマを入力してください'));
    expect(submitCalls()).toHaveLength(0);
  });

  it('SCR-LOOK-007 商品を選ばないと止めて文を出し、窓口へ送らない', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();

    await user.type(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), 'Theme');
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('紐づける商品を1つ以上選択してください'));
    expect(submitCalls()).toHaveLength(0);
  });

  it('SCR-LOOK-007 商品を押して選び、もう一度押すと外れる', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();
    const card = () => screen.getByText('リネンシャツ').closest('div[class*="cursor-pointer"]') as HTMLElement;

    await user.type(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), 'Theme');
    await user.click(screen.getByText('リネンシャツ'));
    expect(card().className).toContain('ring-1 ring-black');
    await user.click(screen.getByText('リネンシャツ'));
    expect(card().className).not.toContain('ring-1 ring-black');
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('紐づける商品を1つ以上選択してください'));
  });

  it('SCR-LOOK-007 画像なしで送ると止めて文を出し、窓口へ送らない', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();

    await user.type(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), 'Theme');
    await user.click(screen.getByText('リネンシャツ'));
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像を1枚以上追加してください'));
    expect(submitCalls()).toHaveLength(0);
  });

  it('SCR-LOOK-007 選んだ画像の見本を出し、複数枚を足せる', async () => {
    const { container } = await renderLoaded();

    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });
    const first = await screen.findByRole('img', { name: 'プレビュー 1' });
    expect(first.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    fireEvent.change(fileInput(container), { target: { files: [makeFile('b.webp', 'image/webp')] } });

    const second = await screen.findByRole('img', { name: 'プレビュー 2' });
    expect(second.getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
  });

  it('SCR-LOOK-007 見本の × で画像を外すと、その1枚だけ消える', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();
    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });
    await screen.findByRole('img', { name: 'プレビュー 1' });
    fireEvent.change(fileInput(container), { target: { files: [makeFile('b.gif', 'image/gif')] } });
    await screen.findByRole('img', { name: 'プレビュー 2' });

    await user.click(screen.getAllByRole('button', { name: '×' })[0]);

    expect(screen.getAllByRole('img', { name: /^プレビュー/ })).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'プレビュー 1' }).getAttribute('src')).toMatch(/^data:image\/gif;base64,/);
  });

  it('SCR-LOOK-007 JPEG・PNG・WebP・GIF の外の画像は断る', async () => {
    const { container } = await renderLoaded();

    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.pdf', 'application/pdf')] } });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像は JPEG / PNG / WebP / GIF を選択してください'));
    expect(screen.queryByRole('img', { name: /^プレビュー/ })).not.toBeInTheDocument();
  });

  it('SCR-LOOK-007 5MB を超える画像は断り、ちょうど 5MB は受ける', async () => {
    const { container } = await renderLoaded();

    fireEvent.change(fileInput(container), {
      target: { files: [makeFile('big.png', 'image/png', 5 * 1024 * 1024 + 1)] },
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像サイズは5MB以下にしてください'));

    fireEvent.change(fileInput(container), {
      target: { files: [makeFile('edge.webp', 'image/webp', 5 * 1024 * 1024)] },
    });
    expect(await screen.findByRole('img', { name: 'プレビュー 1' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('SCR-LOOK-007 画像をドラッグして落とすと選べる', async () => {
    await renderLoaded();
    const zone = dropZone();

    fireEvent.dragOver(zone);
    expect(zone.className).toContain('border-black bg-black/5');
    fireEvent.dragLeave(zone);
    expect(zone.className).toContain('bg-white');

    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [makeFile('drop.gif', 'image/gif')] } });

    expect(await screen.findByRole('img', { name: 'プレビュー 1' })).toBeInTheDocument();
    expect(zone.className).toContain('bg-white');
  });

  it('SCR-LOOK-007 何も持たずに落としても選ばない', async () => {
    await renderLoaded();

    fireEvent.drop(dropZone(), { dataTransfer: { files: [] } });

    expect(screen.queryByRole('img', { name: /^プレビュー/ })).not.toBeInTheDocument();
  });

  it('SCR-LOOK-007 画像の欄は押す・Enter・Space でファイルの選択を開き、ほかのキーでは開かない', async () => {
    const { container } = await renderLoaded();
    const clickSpy = jest.spyOn(fileInput(container), 'click').mockImplementation(() => {});
    const zone = dropZone();

    fireEvent.click(zone);
    fireEvent.keyDown(zone, { key: 'Enter' });
    fireEvent.keyDown(zone, { key: ' ' });
    expect(clickSpy).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(zone, { key: 'a' });
    expect(clickSpy).toHaveBeenCalledTimes(3);
  });

  it('SCR-LOOK-007 見本が読めない時は文を出す', async () => {
    const readSpy = jest
      .spyOn(FileReader.prototype, 'readAsDataURL')
      .mockImplementation(function (this: FileReader) {
        this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
      });
    const { container } = await renderLoaded();

    fireEvent.change(fileInput(container), { target: { files: [makeFile('a.png', 'image/png')] } });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画像プレビューの読み込みに失敗しました'));
    expect(screen.queryByRole('img', { name: /^プレビュー/ })).not.toBeInTheDocument();
    readSpy.mockRestore();
  });

  it('SCR-LOOK-007 入れた値と選んだ商品・画像を POST で送り、成功で保存しました を出す', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();

    await fillValidForm(user, container);
    await user.click(screen.getByText('ウールパンツ'));
    await user.click(statusRadio('published'));
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: '2027' }));
    await user.click(screen.getAllByRole('combobox')[1]);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'SS' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lookを保存しました'));
    expect(submitCalls()).toHaveLength(1);
    const [url, init] = submitCalls()[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/looks');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Headers).get('x-csrf-token')).toBe(CSRF_TOKEN);
    const body = init.body as FormData;
    expect(body.get('seasonYear')).toBe('2027');
    expect(body.get('seasonType')).toBe('SS');
    expect(body.get('theme')).toBe('Effortless Elegance');
    expect(body.get('themeDescription')).toBe('静かな上品さ');
    expect(body.get('status')).toBe('published');
    expect(JSON.parse(body.get('linkedItemIds') as string)).toEqual([101, 102]);
    expect(body.getAll('images').map((f) => (f as File).name)).toEqual(['look1.jpg']);
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin?tab=LOOK'));
  });

  it('SCR-LOOK-007 初めの値のまま送ると今の年・AW・非公開で送る', async () => {
    const user = userEvent.setup();
    const { container } = await renderLoaded();

    await fillValidForm(user, container);
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin?tab=LOOK'));
    const body = (submitCalls()[0][1] as RequestInit).body as FormData;
    expect(body.get('seasonYear')).toBe('2026');
    expect(body.get('seasonType')).toBe('AW');
    expect(body.get('status')).toBe('private');
    expect(JSON.parse(body.get('linkedItemIds') as string)).toEqual([101]);
  });

  it('SCR-LOOK-007 送る間はボタンを保存中にして押せなくする', async () => {
    const user = userEvent.setup();
    let resolve!: (value: Response) => void;
    submitResult = () => new Promise<Response>((r) => { resolve = r; });
    const { container } = await renderLoaded();
    await fillValidForm(user, container);

    fireEvent.submit(container.querySelector('form')!);

    const busy = await screen.findByRole('button', { name: '保存中...' });
    expect(busy).toBeDisabled();
    resolve(response(true, {}));
    expect(await screen.findByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('SCR-LOOK-007 断られた時はサーバーの error の文を出し、一覧へ戻さない', async () => {
    const user = userEvent.setup();
    submitResult = async () => response(false, { error: 'theme must be at most 100 characters' });
    const { container } = await renderLoaded();
    await fillValidForm(user, container);

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('theme must be at most 100 characters'));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-007 断られた応答に文が無い時は Lookの保存に失敗しました を出す', async () => {
    const user = userEvent.setup();
    submitResult = async () => response(false, undefined);
    const { container } = await renderLoaded();
    await fillValidForm(user, container);

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Lookの保存に失敗しました'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-007 通信の例外では通信エラーが発生しました を出し、ボタンを戻す', async () => {
    const user = userEvent.setup();
    submitResult = async () => { throw new Error('network'); };
    const { container } = await renderLoaded();
    await fillValidForm(user, container);

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('通信エラーが発生しました。時間をおいて再度お試しください'),
    );
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
