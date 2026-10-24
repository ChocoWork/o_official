import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminStockistEditPage from '@/app/admin/stockist/edit/[id]/page';

const mockPush = jest.fn();
let mockParams: { id?: string } | null = { id: '42' };

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => mockParams,
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

const STOCKIST = {
  id: 42,
  name: 'セレクトショップ青山',
  address: '東京都港区南青山1-2-3',
  phone: '03-1234-5678',
  time: '11:00-20:00',
  holiday: '水曜',
  status: 'published' as const,
};

const FIELDS = ['店舗名', '住所', '電話番号', '営業時間', '定休日'] as const;

function field(label: (typeof FIELDS)[number]): HTMLInputElement {
  return screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;
}

function response(ok: boolean, body: unknown): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    json: body === undefined ? async () => { throw new SyntaxError('no json'); } : async () => body,
  } as unknown as Response;
}

// 1件の取り出しと更新の送信を方法で振り分ける
let stockistResult: () => Promise<Response>;
let submitResult: () => Promise<Response>;

function stockistCalls() {
  return mockFetch.mock.calls.filter(([url, init]) => url === '/api/admin/stockists/42' && (init as RequestInit).method === 'GET');
}

function submitCalls() {
  return mockFetch.mock.calls.filter(([url, init]) => url === '/api/admin/stockists/42' && (init as RequestInit).method === 'PUT');
}

async function renderLoaded() {
  const utils = render(<AdminStockistEditPage />);
  await screen.findByDisplayValue(STOCKIST.name);
  return utils;
}

describe('取扱店の編集の画面', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockParams = { id: '42' };
    mockPush.mockReset();
    mockFetch.mockReset();
    stockistResult = async () => response(true, { data: STOCKIST });
    submitResult = async () => response(true, { data: STOCKIST });
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? submitResult() : stockistResult(),
    );
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    // jsdom は canvas の getContext を実装せず、SingleSelect の文字幅の計測で雑音が出るため null を返す
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('SCR-STOCKIST-006 読み込みの間は読み込み中を出し、URL の id の店を管理の窓口から1回だけ取る', async () => {
    render(<AdminStockistEditPage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(await screen.findByDisplayValue(STOCKIST.name)).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/stockists/42');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Headers).has('x-csrf-token')).toBe(false);
  });

  it('SCR-STOCKIST-006 取った6つの値をフォームの初めの値にする', async () => {
    await renderLoaded();

    expect(field('店舗名')).toHaveValue(STOCKIST.name);
    expect(field('住所')).toHaveValue(STOCKIST.address);
    expect(field('電話番号')).toHaveValue(STOCKIST.phone);
    expect(field('営業時間')).toHaveValue(STOCKIST.time);
    expect(field('定休日')).toHaveValue(STOCKIST.holiday);
    expect(screen.getByRole('combobox', { name: '公開状態' })).toHaveTextContent('公開');
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();
  });

  it('SCR-STOCKIST-006 非公開の店は公開状態に非公開を入れて開く', async () => {
    stockistResult = async () => response(true, { data: { ...STOCKIST, status: 'private' } });

    await renderLoaded();

    expect(screen.getByRole('combobox', { name: '公開状態' })).toHaveTextContent('非公開');
  });

  it('SCR-STOCKIST-006 キャンセル・戻るのボタンは無く、頁を開いただけでは権限を確かめに行かない', async () => {
    await renderLoaded();

    expect(screen.queryByRole('button', { name: /キャンセル|戻る/ })).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.every(([url]) => url === '/api/admin/stockists/42')).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-006 更新は同じ道に PUT で、作成と同じ5つの欄と状態を前後の空白を除いて送る', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.clear(field('店舗名'));
    await user.type(field('店舗名'), '  青山店  ');
    await user.clear(field('定休日'));
    await user.type(field('定休日'), ' 年中無休 ');

    await user.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    const [url, init] = submitCalls()[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/stockists/42');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(JSON.parse(init.body as string)).toEqual({
      name: '青山店',
      address: STOCKIST.address,
      phone: STOCKIST.phone,
      time: STOCKIST.time,
      holiday: '年中無休',
      status: 'published',
    });
  });

  it('SCR-STOCKIST-006 公開状態を変えて更新すると、変えた status を送る', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('combobox', { name: '公開状態' }));
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: '非公開' }));

    await user.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    expect(JSON.parse((submitCalls()[0][1] as RequestInit).body as string)).toMatchObject({ status: 'private' });
  });

  it('SCR-STOCKIST-006 更新に成功すると更新しました を出して STOCKIST タブの一覧へ移る', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '更新' }));

    expect(await screen.findByText('STOCKISTを更新しました')).toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/admin?tab=STOCKIST');
  });

  it.each(FIELDS)('SCR-STOCKIST-006 %s を空にして更新すると必須の文を出して送らない', async (label) => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.clear(field(label));
    await user.type(field(label), '   ');

    fireEvent.submit(field(label).closest('form')!);

    expect(await screen.findByText('必須項目を入力してください')).toBeInTheDocument();
    expect(submitCalls()).toHaveLength(0);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-006 送っている間はボタンを保存中にして押せなくする', async () => {
    const user = userEvent.setup();
    let resolveSubmit: (value: Response) => void = () => {};
    submitResult = () => new Promise<Response>((resolve) => { resolveSubmit = resolve; });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '更新' }));

    expect(await screen.findByRole('button', { name: '保存中...' })).toBeDisabled();
    expect(submitCalls()).toHaveLength(1);
    resolveSubmit(response(true, { data: STOCKIST }));
    await waitFor(() => expect(screen.getByRole('button', { name: '更新' })).toBeEnabled());
  });

  it('SCR-STOCKIST-006 更新が断られた時は窓口の error の文を出して移らない', async () => {
    const user = userEvent.setup();
    submitResult = async () => response(false, { error: '店が見つかりません' });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '更新' }));

    expect(await screen.findByText('店が見つかりません')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByText('STOCKISTを更新しました')).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-006 error の文が無い更新の失敗は保存に失敗しました を出す', async () => {
    const user = userEvent.setup();
    submitResult = async () => response(false, undefined);
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '更新' }));

    expect(await screen.findByText('STOCKISTの保存に失敗しました')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-006 更新の通信の例外は通信エラーの文を出し、書き込みを送り直さない', async () => {
    const user = userEvent.setup();
    submitResult = async () => { throw new TypeError('Failed to fetch'); };
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '更新' }));

    expect(await screen.findByText('通信エラーが発生しました。時間をおいて再度お試しください')).toBeInTheDocument();
    expect(submitCalls()).toHaveLength(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();
  });

  it('SCR-STOCKIST-006 取り出しが断られた時は窓口の error の文を同じ頁に出し、フォームを出さない', async () => {
    stockistResult = async () => response(false, { error: '権限がありません' });

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('権限がありません')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '更新' })).not.toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-006 error の文が無い取り出しの失敗は取得に失敗しました を出す', async () => {
    stockistResult = async () => response(false, {});

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-006 取り出しの応答が JSON でなくても取得に失敗しました を出す', async () => {
    stockistResult = async () => response(false, undefined);

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-006 成功でも data が無い時は取得に失敗しました を出す', async () => {
    stockistResult = async () => response(true, {});

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '更新' })).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-006 取り出しの通信の例外でも取得に失敗しました を出す', async () => {
    stockistResult = async () => { throw new Error('network'); };

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    expect(stockistCalls()).toHaveLength(1);
  });

  it('SCR-STOCKIST-006 URL に id が無い時は何も取らず、id の取得に失敗しました を出す', async () => {
    mockParams = {};

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKIST IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '更新' })).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-006 URL の値が無い時も何も取らず、id の取得に失敗しました を出す', async () => {
    mockParams = null;

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKIST IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-006 URL の id を確かめずにそのまま窓口の道に入れる', async () => {
    mockParams = { id: 'abc' };

    render(<AdminStockistEditPage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect((mockFetch.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/admin/stockists/abc');
  });
});
