import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StockistSection from '@/components/StockistSection';

// clientFetch は本物を通し、網の境目の fetch だけを差し替える（CSRF の見出しと送り方まで確かめる）
const CSRF_TOKEN = 'csrf-test-token';
const mockFetch = jest.fn();
const realFetch = global.fetch;

type SentRequest = { url: string; method: string; headers: Headers; body: unknown; credentials: unknown };

function sent(index: number): SentRequest {
  const [url, init] = mockFetch.mock.calls[index] as [string, RequestInit];
  return { url, method: init.method as string, headers: init.headers as Headers, body: init.body, credentials: init.credentials };
}

type Stockist = {
  id: number;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
  status: 'private' | 'published';
};

const PUBLISHED: Stockist = {
  id: 21,
  name: 'セレクトショップ青山',
  address: '東京都港区南青山1-2-3',
  phone: '03-1234-5678',
  time: '11:00-20:00',
  holiday: '水曜',
  status: 'published',
};

const PRIVATE: Stockist = {
  id: 22,
  name: '京都ギャラリー',
  address: '京都府京都市中京区4-5-6',
  phone: '075-111-2222',
  time: '12:00-19:00',
  holiday: '不定休',
  status: 'private',
};

function okList(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data }) } as unknown as Response;
}

function okEmpty() {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as unknown as Response;
}

function failed(status = 500) {
  return { ok: false, status, statusText: 'Error', json: async () => ({ error: 'x' }) } as unknown as Response;
}

function rowOf(name: string): HTMLElement {
  let node: HTMLElement | null = screen.getByRole('heading', { name });
  while (node && !within(node).queryByRole('button', { name: '削除' })) {
    node = node.parentElement;
  }
  if (!node) throw new Error(`row for ${name} not found`);
  return node;
}

describe('管理の STOCKIST タブの一覧', () => {
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

  it('SCR-STOCKIST-004 読み込みの間は読み込み中を出し、一覧を管理の窓口から1回だけ取る', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    render(<StockistSection />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: PUBLISHED.name })).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sent(0)).toMatchObject({ url: '/api/admin/stockists', method: 'GET', credentials: 'same-origin' });
    expect(sent(0).headers.has('x-csrf-token')).toBe(false);
  });

  it('SCR-STOCKIST-004 カードに店舗名・札・住所・電話・営業時間・定休日と公開切り替え・編集・削除を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]));

    render(<StockistSection />);

    await screen.findByRole('heading', { name: PUBLISHED.name });
    const published = rowOf(PUBLISHED.name);
    expect(within(published).getByText('公開中')).toBeInTheDocument();
    expect(within(published).getByText(PUBLISHED.address)).toBeInTheDocument();
    expect(within(published).getByText(PUBLISHED.phone)).toBeInTheDocument();
    expect(within(published).getByText(PUBLISHED.time)).toBeInTheDocument();
    expect(within(published).getByText(PUBLISHED.holiday)).toBeInTheDocument();
    expect(within(published).getByRole('button', { name: '非公開' })).toBeInTheDocument();
    expect(within(published).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/stockist/edit/21');
    expect(within(published).getByRole('button', { name: '削除' })).toBeInTheDocument();

    const draft = rowOf(PRIVATE.name);
    expect(within(draft).getByText('非公開')).toBeInTheDocument();
    expect(within(draft).getByText(PRIVATE.address)).toBeInTheDocument();
    expect(within(draft).getByText(PRIVATE.holiday)).toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(draft).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/stockist/edit/22');
  });

  it('SCR-STOCKIST-004 公開の店だけ背景を薄い緑にし、非公開の店は別の背景にする', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]));

    render(<StockistSection />);

    await screen.findByRole('heading', { name: PUBLISHED.name });
    expect(rowOf(PUBLISHED.name).className).toContain('bg-[#f7fff1]');
    expect(rowOf(PRIVATE.name).className).not.toContain('bg-[#f7fff1]');
  });

  it('SCR-STOCKIST-004 電話が空でも電話の行を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([{ ...PRIVATE, phone: '' }]));

    render(<StockistSection />);

    await screen.findByRole('heading', { name: PRIVATE.name });
    const phoneRow = rowOf(PRIVATE.name).querySelector('.ri-phone-line')?.parentElement as HTMLElement;
    expect(phoneRow).toBeInTheDocument();
    expect(phoneRow.querySelector('p')).toBeEmptyDOMElement();
  });

  it('SCR-STOCKIST-004 行のアイコンに aria-hidden は付かない', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    render(<StockistSection />);

    await screen.findByRole('heading', { name: PUBLISHED.name });
    const icons = rowOf(PUBLISHED.name).querySelectorAll('i');
    expect(icons.length).toBeGreaterThanOrEqual(4);
    icons.forEach((icon) => expect(icon).not.toHaveAttribute('aria-hidden'));
  });

  it('SCR-STOCKIST-004 格子は1列、640px 以上で2列、1280px 以上で3列', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    const { container } = render(<StockistSection />);

    await screen.findByRole('heading', { name: PUBLISHED.name });
    const grid = container.querySelector('section > div') as HTMLElement;
    expect(grid).toHaveClass('grid', 'grid-cols-1', 'sm:grid-cols-2', 'xl:grid-cols-3');
  });

  it('SCR-STOCKIST-004 窓口の並びのまま行を出し、並べ替えない', async () => {
    mockFetch.mockResolvedValueOnce(okList([PRIVATE, PUBLISHED]));

    render(<StockistSection />);

    await screen.findByRole('heading', { name: PUBLISHED.name });
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([PRIVATE.name, PUBLISHED.name]);
  });

  it('SCR-STOCKIST-004 0件の時は STOCKIST が無い旨を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([]));

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-004 応答に data が無い時も0件として出す', async () => {
    mockFetch.mockResolvedValueOnce(okEmpty());

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-004 取り出しが断られた時は0件と同じ文になり、知らせの窓は出さない', async () => {
    mockFetch.mockResolvedValueOnce(failed(403));

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-004 通信の例外でも0件と同じ文になる', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-004 公開中の店の切り替えは非公開を PATCH で送り、一覧を読み直す', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PUBLISHED]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([{ ...PUBLISHED, status: 'private' }]));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(sent(1)).toMatchObject({
      url: '/api/admin/stockists/21',
      method: 'PATCH',
      credentials: 'same-origin',
      body: JSON.stringify({ status: 'private' }),
    });
    expect(sent(1).headers.get('Content-Type')).toBe('application/json');
    expect(sent(1).headers.get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(sent(2)).toMatchObject({ url: '/api/admin/stockists', method: 'GET' });
    expect(await within(rowOf(PUBLISHED.name)).findByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-004 非公開の店の切り替えは公開を PATCH で送る', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PRIVATE]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([{ ...PRIVATE, status: 'published' }]));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PRIVATE.name });
    await user.click(within(rowOf(PRIVATE.name)).getByRole('button', { name: '公開' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(sent(1)).toMatchObject({
      url: '/api/admin/stockists/22',
      method: 'PATCH',
      body: JSON.stringify({ status: 'published' }),
    });
    expect(await within(rowOf(PRIVATE.name)).findByText('公開中')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-004 切り替えが断られた時は知らせの窓を出し、一覧を読み直さない', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockResolvedValueOnce(failed(403));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(within(rowOf(PUBLISHED.name)).getByText('公開中')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-004 切り替えの通信の例外でも知らせの窓を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockRejectedValueOnce(new Error('network'));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
  });

  it('SCR-STOCKIST-004 削除は確かめの窓を出し、同意しなければ送らない', async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    expect(confirmSpy).toHaveBeenCalledWith('このSTOCKISTを削除してもよろしいですか？');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: PUBLISHED.name })).toBeInTheDocument();
  });

  it('SCR-STOCKIST-004 削除に同意すると DELETE を送り、一覧を読み直す', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([PRIVATE]));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: PUBLISHED.name })).not.toBeInTheDocument());
    expect(sent(1)).toMatchObject({ url: '/api/admin/stockists/21', method: 'DELETE', credentials: 'same-origin' });
    expect(sent(1).headers.get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(sent(2)).toMatchObject({ url: '/api/admin/stockists', method: 'GET' });
    expect(screen.getByRole('heading', { name: PRIVATE.name })).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-004 最後の1件を削除すると0件の文に変わる', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PUBLISHED]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([]));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-004 削除が断られた時は知らせの窓を出し、店を残す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockResolvedValueOnce(failed(403));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('STOCKISTの削除に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: PUBLISHED.name })).toBeInTheDocument();
  });

  it('SCR-STOCKIST-004 削除の通信の例外でも知らせの窓を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockRejectedValueOnce(new Error('network'));

    render(<StockistSection />);
    await screen.findByRole('heading', { name: PUBLISHED.name });
    await user.click(within(rowOf(PUBLISHED.name)).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('STOCKISTの削除に失敗しました'));
  });
});
