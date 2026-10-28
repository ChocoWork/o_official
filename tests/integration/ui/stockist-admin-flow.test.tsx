import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StockistSection from '@/components/StockistSection';
import AdminStockistCreatePage from '@/app/admin/stockist/create/page';
import AdminStockistEditPage from '@/app/admin/stockist/edit/[id]/page';

const mockPush = jest.fn();
let mockParams: { id?: string } | null = { id: '21' };

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => mockParams,
}));

// clientFetch は本物を通し、網の境目の fetch だけを差し替える（CSRF の見出しと送り方まで確かめる）
const CSRF_TOKEN = 'csrf-test-token';
const ACCESS_URL = '/api/admin/stockists/access';
const mockFetch = jest.fn();
const mockAccess = jest.fn();
const realFetch = global.fetch;

// 作成の頁を開いた時の権限の確かめ（SEC-STOCKIST-019）は mockAccess へ、それ以外は mockFetch へ振り分ける
beforeAll(() => {
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === ACCESS_URL ? mockAccess(input, init) : mockFetch(input, init)) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

const LIST_URL = '/admin?tab=STOCKIST';

const PUBLISHED = {
  id: 21,
  name: 'セレクトショップ青山',
  address: '東京都港区南青山1-2-3',
  phone: '03-1234-5678',
  time: '11:00-20:00',
  holiday: '水曜',
  status: 'published' as const,
};

const PRIVATE = {
  id: 22,
  name: '京都ギャラリー',
  address: '京都府京都市中京区4-5-6',
  phone: '075-111-2222',
  time: '12:00-19:00',
  holiday: '不定休',
  status: 'private' as const,
};

function json(ok: boolean, body: unknown): Response {
  return { ok, status: ok ? 200 : 400, statusText: '', json: async () => body } as unknown as Response;
}

function rowOf(name: string): HTMLElement {
  let node: HTMLElement | null = screen.getByRole('heading', { name });
  while (node && !within(node).queryByRole('button', { name: '削除' })) {
    node = node.parentElement;
  }
  if (!node) throw new Error(`row for ${name} not found`);
  return node;
}

// 権限の確かめが通って作成のフォームが出るまで待つ
async function renderCreate() {
  const view = render(<AdminStockistCreatePage />);
  await screen.findByLabelText(/^店舗名/);
  return view;
}

async function fillCreateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^店舗名/), PRIVATE.name);
  await user.type(screen.getByLabelText(/^住所/), PRIVATE.address);
  await user.type(screen.getByLabelText(/^電話番号/), PRIVATE.phone);
  await user.type(screen.getByLabelText(/^営業時間/), PRIVATE.time);
  await user.type(screen.getByLabelText(/^定休日/), PRIVATE.holiday);
}

describe('管理の取扱店の一覧と作成・編集の行き来', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let alertSpy: jest.SpyInstance;
  let confirmSpy: jest.SpyInstance;

  beforeEach(() => {
    mockParams = { id: '21' };
    mockPush.mockReset();
    mockFetch.mockReset();
    mockAccess.mockReset();
    mockAccess.mockResolvedValue({ ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response);
    document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
    // jsdom は canvas の getContext を実装せず、SingleSelect の文字幅の計測で雑音が出るため null を返す
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    errorSpy.mockRestore();
    alertSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('FLOW-STOCKIST-002 一覧の編集は店ごとの編集の頁へつながり、編集の頁はそのリンクの id の店を取る', async () => {
    mockFetch.mockResolvedValueOnce(json(true, { data: [PUBLISHED, PRIVATE] }));
    const first = render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });

    const publishedHref = within(rowOf(PUBLISHED.name)).getByRole('link', { name: '編集' }).getAttribute('href');
    const privateHref = within(rowOf(PRIVATE.name)).getByRole('link', { name: '編集' }).getAttribute('href');
    expect(publishedHref).toBe('/admin/stockist/edit/21');
    expect(privateHref).toBe('/admin/stockist/edit/22');
    first.unmount();

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(json(true, { data: PRIVATE }));
    mockParams = { id: privateHref!.split('/').pop() };
    render(<AdminStockistEditPage />);

    expect(await screen.findByDisplayValue(PRIVATE.name)).toBeInTheDocument();
    expect((mockFetch.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/admin/stockists/22');
  });

  it('FLOW-STOCKIST-002 作成の保存に成功すると STOCKIST タブを開いた一覧へ戻り、そこに作った店が並ぶ', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(json(true, { data: { id: 22 } }));
    const create = await renderCreate();
    await fillCreateForm(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
    create.unmount();

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(json(true, { data: [PUBLISHED, PRIVATE] }));
    render(<StockistSection />);
    expect(await screen.findByRole('heading', { name: PRIVATE.name })).toBeInTheDocument();
  });

  it('FLOW-STOCKIST-002 編集の更新に成功すると STOCKIST タブを開いた一覧へ戻る', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(json(true, { data: PUBLISHED }))
      .mockResolvedValueOnce(json(true, { data: PUBLISHED }));
    render(<AdminStockistEditPage />);
    await screen.findByDisplayValue(PUBLISHED.name);

    await user.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
    expect(await screen.findByText('STOCKISTを更新しました')).toBeInTheDocument();
  });

  it('FLOW-STOCKIST-002 作成の保存に失敗すると同じ頁に文を出して留まる', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(json(false, { error: '保存できません' }));
    const { container } = await renderCreate();
    await fillCreateForm(user);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('保存できません')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('FLOW-STOCKIST-002 作成の入力が足りない時は送らずに同じ頁に留まる', async () => {
    const { container } = await renderCreate();

    fireEvent.submit(container.querySelector('form')!);

    expect(await screen.findByText('必須項目を入力してください')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-STOCKIST-002 編集の更新に失敗すると同じ頁に文を出して留まる', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(json(true, { data: PUBLISHED }))
      .mockRejectedValueOnce(new Error('network'));
    const { container } = render(<AdminStockistEditPage />);
    await screen.findByDisplayValue(PUBLISHED.name);

    await user.click(screen.getByRole('button', { name: '更新' }));

    expect(await screen.findByText('通信エラーが発生しました。時間をおいて再度お試しください')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(container.querySelector('form')).not.toBeNull();
    expect(screen.getByDisplayValue(PUBLISHED.name)).toBeInTheDocument();
  });

  it('FLOW-STOCKIST-002 編集の取得に失敗すると同じ頁に誤りの文を出して留まり、一覧へは移らない', async () => {
    mockFetch.mockResolvedValueOnce(json(false, {}));

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-STOCKIST-002 一覧の上で公開を切り替えると読み直した状態を出し、頁を移らない', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(json(true, { data: [PUBLISHED] }))
      .mockResolvedValueOnce(json(true, {}))
      .mockResolvedValueOnce(json(true, { data: [{ ...PUBLISHED, status: 'private' }] }));
    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });

    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '非公開' }));

    expect(await within(rowOf(PUBLISHED.name)).findByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(rowOf(PUBLISHED.name)).getByText('非公開')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-STOCKIST-002 一覧の上で削除を確かめて同意すると、読み直した一覧から店が消え、頁を移らない', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(json(true, { data: [PUBLISHED, PRIVATE] }))
      .mockResolvedValueOnce(json(true, {}))
      .mockResolvedValueOnce(json(true, { data: [PRIVATE] }));
    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });

    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: PUBLISHED.name })).not.toBeInTheDocument());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: PRIVATE.name })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-STOCKIST-002 削除の確かめで断ると送らずに一覧に留まる', async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(json(true, { data: [PUBLISHED] }));
    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });

    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: PUBLISHED.name })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-STOCKIST-002 一覧の上の操作に失敗すると知らせの窓を出し、前の一覧のまま留まる', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(json(true, { data: [PUBLISHED] }))
      .mockResolvedValueOnce(json(false, {}));
    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });

    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('STOCKISTの削除に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: PUBLISHED.name })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-STOCKIST-002 作成の頁にも編集の頁にもキャンセルや戻るの操作は無い', async () => {
    mockFetch.mockResolvedValueOnce(json(true, { data: PUBLISHED }));
    const create = await renderCreate();
    expect(screen.queryByRole('button', { name: /キャンセル|戻る/ })).not.toBeInTheDocument();
    create.unmount();

    render(<AdminStockistEditPage />);
    await screen.findByDisplayValue(PUBLISHED.name);

    expect(screen.queryByRole('button', { name: /キャンセル|戻る/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /キャンセル|戻る/ })).not.toBeInTheDocument();
  });
});
