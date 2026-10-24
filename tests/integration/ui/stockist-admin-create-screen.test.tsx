import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminStockistCreatePage from '@/app/admin/stockist/create/page';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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

const FIELDS = ['店舗名', '住所', '電話番号', '営業時間', '定休日'] as const;

function field(label: (typeof FIELDS)[number]): HTMLInputElement {
  return screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;
}

function response(ok: boolean, body: unknown): Response {
  return {
    ok,
    status: ok ? 201 : 400,
    json: body === undefined ? async () => { throw new SyntaxError('no json'); } : async () => body,
  } as unknown as Response;
}

async function fillAll(user: ReturnType<typeof userEvent.setup>) {
  await user.type(field('店舗名'), 'セレクトショップ青山');
  await user.type(field('住所'), '東京都港区南青山1-2-3');
  await user.type(field('電話番号'), '03-1234-5678');
  await user.type(field('営業時間'), '11:00-20:00');
  await user.type(field('定休日'), '水曜');
}

describe('取扱店の作成の画面', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPush.mockReset();
    mockFetch.mockReset();
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    // jsdom は canvas の getContext を実装せず、SingleSelect の文字幅の計測で雑音が出るため null を返す
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('SCR-STOCKIST-005 公開状態と5つの必須欄と保存のボタンを出す', () => {
    render(<AdminStockistCreatePage />);

    expect(screen.getByRole('combobox', { name: '公開状態' })).toBeInTheDocument();
    for (const label of FIELDS) {
      expect(field(label)).toBeRequired();
    }
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('SCR-STOCKIST-005 初めの値は非公開で、5つの欄は空', () => {
    render(<AdminStockistCreatePage />);

    expect(screen.getByRole('combobox', { name: '公開状態' })).toHaveTextContent('非公開');
    for (const label of FIELDS) {
      expect(field(label)).toHaveValue('');
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-005 公開状態は非公開と公開の2つから選べる', async () => {
    const user = userEvent.setup();
    render(<AdminStockistCreatePage />);

    await user.click(screen.getByRole('combobox', { name: '公開状態' }));

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['非公開', '公開']);
  });

  it('SCR-STOCKIST-005 種別の欄は無く、キャンセル・戻るのボタンも無い', () => {
    render(<AdminStockistCreatePage />);

    expect(screen.queryByLabelText(/種別/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /キャンセル|戻る/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /キャンセル|戻る/ })).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-005 頁を開いただけでは何も送らず、権限も確かめに行かない', () => {
    render(<AdminStockistCreatePage />);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-005 5つの欄を入れて保存すると、作成の窓口へ前後の空白を除いて非公開のまま POST する', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(true, { data: { id: 1 } }));
    render(<AdminStockistCreatePage />);
    await user.type(field('店舗名'), '  セレクトショップ青山  ');
    await user.type(field('住所'), ' 東京都港区南青山1-2-3');
    await user.type(field('電話番号'), '03-1234-5678 ');
    await user.type(field('営業時間'), '  11:00-20:00  ');
    await user.type(field('定休日'), '水曜');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/stockists');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'セレクトショップ青山',
      address: '東京都港区南青山1-2-3',
      phone: '03-1234-5678',
      time: '11:00-20:00',
      holiday: '水曜',
      status: 'private',
    });
  });

  it('SCR-STOCKIST-005 公開を選んで保存すると status に published を送る', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(true, { data: { id: 1 } }));
    render(<AdminStockistCreatePage />);
    await fillAll(user);
    await user.click(screen.getByRole('combobox', { name: '公開状態' }));
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: '公開' }));
    expect(screen.getByRole('combobox', { name: '公開状態' })).toHaveTextContent('公開');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ status: 'published' });
  });

  it.each(FIELDS)('SCR-STOCKIST-005 %s が空白だけなら必須の文を出して送らない', async (empty) => {
    const user = userEvent.setup();
    render(<AdminStockistCreatePage />);
    await fillAll(user);
    await user.clear(field(empty));
    await user.type(field(empty), '   ');

    fireEvent.submit(field(empty).closest('form')!);

    expect(await screen.findByText('必須項目を入力してください')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('SCR-STOCKIST-005 送っている間はボタンを保存中にして押せなくする', async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: Response) => void = () => {};
    mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    render(<AdminStockistCreatePage />);
    await fillAll(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    const busy = await screen.findByRole('button', { name: '保存中...' });
    expect(busy).toBeDisabled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    resolveFetch(response(true, { data: { id: 1 } }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled());
  });

  it('SCR-STOCKIST-005 保存に成功すると保存しました を出して STOCKIST タブの一覧へ移る', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(true, { data: { id: 1 } }));
    render(<AdminStockistCreatePage />);
    await fillAll(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('STOCKISTを保存しました')).toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/admin?tab=STOCKIST');
    expect(screen.queryByText('必須項目を入力してください')).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-005 保存に成功したが応答が JSON でなくても一覧へ移る', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(true, undefined));
    render(<AdminStockistCreatePage />);
    await fillAll(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin?tab=STOCKIST'));
  });

  it('SCR-STOCKIST-005 窓口が error の文を返した時はその文を出して移らない', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(false, { error: '住所が長すぎます' }));
    render(<AdminStockistCreatePage />);
    await fillAll(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('住所が長すぎます')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByText('STOCKISTを保存しました')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('SCR-STOCKIST-005 error の文が無い失敗は保存に失敗しました を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(false, {}));
    render(<AdminStockistCreatePage />);
    await fillAll(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('STOCKISTの保存に失敗しました')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-005 失敗の応答が JSON でなくても保存に失敗しました を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(response(false, undefined));
    render(<AdminStockistCreatePage />);
    await fillAll(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('STOCKISTの保存に失敗しました')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-005 通信の例外は通信エラーの文を出し、移らず、書き込みを送り直さない', async () => {
    const user = userEvent.setup();
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<AdminStockistCreatePage />);
    await fillAll(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('通信エラーが発生しました。時間をおいて再度お試しください')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('SCR-STOCKIST-005 失敗の後に直して送り直すと、前の誤りの文を消して成功へ進む', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(response(false, { error: '住所が長すぎます' }))
      .mockResolvedValueOnce(response(true, { data: { id: 1 } }));
    render(<AdminStockistCreatePage />);
    await fillAll(user);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('住所が長すぎます');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin?tab=STOCKIST'));
    expect(screen.queryByText('住所が長すぎます')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
