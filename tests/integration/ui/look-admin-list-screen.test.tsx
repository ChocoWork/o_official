import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LookSection from '@/components/LookSection';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }),
}));

// clientFetch は本物を通し、網の境目の fetch だけを差し替える（CSRF の見出しと送り方まで確かめる）
const CSRF_TOKEN = 'csrf-test-token';
const mockFetch = jest.fn();
const realFetch = global.fetch;

type SentRequest = { url: string; method: string; headers: Headers; body: unknown; credentials: unknown };

function sent(index: number): SentRequest {
  const [url, init] = mockFetch.mock.calls[index] as [string, RequestInit];
  return { url, method: init.method as string, headers: init.headers as Headers, body: init.body, credentials: init.credentials };
}

type Look = {
  id: number;
  season_year: number;
  season_type: 'SS' | 'AW';
  theme: string;
  image_urls: string[];
  status: 'private' | 'published';
};

const PUBLISHED: Look = {
  id: 11,
  season_year: 2026,
  season_type: 'SS',
  theme: 'Effortless Elegance',
  image_urls: ['https://example.test/signed/11-a.jpg', 'https://example.test/signed/11-b.jpg'],
  status: 'published',
};

const PRIVATE: Look = {
  id: 12,
  season_year: 2025,
  season_type: 'AW',
  theme: 'Quiet Layers',
  image_urls: ['https://example.test/signed/12-a.jpg'],
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

function rowOf(theme: string): HTMLElement {
  let node: HTMLElement | null = screen.getByText(theme);
  while (node && !(within(node).queryByRole('button', { name: '削除' }) && within(node).queryByRole('img'))) {
    node = node.parentElement;
  }
  if (!node) throw new Error(`row for ${theme} not found`);
  return node;
}

describe('管理の LOOK タブの一覧', () => {
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

  it('SCR-LOOK-006 読み込みの間は読み込み中を出し、一覧を管理の窓口から取る', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    render(<LookSection />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(await screen.findByText('Effortless Elegance')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sent(0)).toMatchObject({ url: '/api/admin/looks', method: 'GET', credentials: 'same-origin' });
    expect(sent(0).headers.has('x-csrf-token')).toBe(false);
  });

  it('SCR-LOOK-006 行に1枚目の画像・状態・シーズン・テーマ・切り替え・編集・削除を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]));

    render(<LookSection />);

    await screen.findByText('Effortless Elegance');
    const published = rowOf('Effortless Elegance');
    expect(within(published).getByRole('img', { name: 'Effortless Elegance' })).toHaveAttribute('src', PUBLISHED.image_urls[0]);
    expect(within(published).getByText('公開中')).toBeInTheDocument();
    expect(within(published).getByText('2026 SS')).toBeInTheDocument();
    expect(within(published).getByRole('button', { name: '非公開' })).toBeInTheDocument();
    expect(within(published).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/look/edit/11');
    expect(within(published).getByRole('button', { name: '削除' })).toBeInTheDocument();

    const draft = rowOf('Quiet Layers');
    expect(within(draft).getByRole('img', { name: 'Quiet Layers' })).toHaveAttribute('src', PRIVATE.image_urls[0]);
    expect(within(draft).getByText('非公開')).toBeInTheDocument();
    expect(within(draft).getByText('2025 AW')).toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(draft).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/look/edit/12');
  });

  it('SCR-LOOK-006 画像が無い LOOK は placeholder.png を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([{ ...PRIVATE, image_urls: [] }]));

    render(<LookSection />);

    await screen.findByText('Quiet Layers');
    expect(within(rowOf('Quiet Layers')).getByRole('img', { name: 'Quiet Layers' })).toHaveAttribute('src', '/placeholder.png');
  });

  it('SCR-LOOK-006 窓口の並びのまま行を出し、並べ替えない', async () => {
    mockFetch.mockResolvedValueOnce(okList([PRIVATE, PUBLISHED]));

    render(<LookSection />);

    await screen.findByText('Effortless Elegance');
    const themes = screen.getAllByRole('img').map((img) => img.getAttribute('alt'));
    expect(themes).toEqual(['Quiet Layers', 'Effortless Elegance']);
  });

  it('SCR-LOOK-006 0件の時は LOOK が無い旨を出す', async () => {
    mockFetch.mockResolvedValueOnce(okList([]));

    render(<LookSection />);

    expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
  });

  it('SCR-LOOK-006 応答に data が無い時も0件として出す', async () => {
    mockFetch.mockResolvedValueOnce(okEmpty());

    render(<LookSection />);

    expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
  });

  it('SCR-LOOK-006 取り出しが断られた時は0件と同じ文になる', async () => {
    mockFetch.mockResolvedValueOnce(failed(403));

    render(<LookSection />);

    expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument();
  });

  it('SCR-LOOK-006 通信の例外でも0件と同じ文になる', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));

    render(<LookSection />);

    expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
  });

  it('SCR-LOOK-006 公開中の LOOK の切り替えは非公開を PATCH で送り、一覧を読み直す', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PUBLISHED]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([{ ...PUBLISHED, status: 'private' }]));

    render(<LookSection />);
    await screen.findByText('Effortless Elegance');
    await user.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(sent(1)).toMatchObject({
      url: '/api/admin/looks/11',
      method: 'PATCH',
      credentials: 'same-origin',
      body: JSON.stringify({ status: 'private' }),
    });
    expect(sent(1).headers.get('Content-Type')).toBe('application/json');
    expect(sent(1).headers.get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(sent(2)).toMatchObject({ url: '/api/admin/looks', method: 'GET' });
    expect(await within(rowOf('Effortless Elegance')).findByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-006 非公開の LOOK の切り替えは公開を PATCH で送る', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PRIVATE]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([PRIVATE]));

    render(<LookSection />);
    await screen.findByText('Quiet Layers');
    await user.click(within(rowOf('Quiet Layers')).getByRole('button', { name: '公開' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(sent(1)).toMatchObject({
      url: '/api/admin/looks/12',
      method: 'PATCH',
      body: JSON.stringify({ status: 'published' }),
    });
  });

  it('SCR-LOOK-006 切り替えが断られた時は alert を出し、一覧を読み直さない', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockResolvedValueOnce(failed(403));

    render(<LookSection />);
    await screen.findByText('Effortless Elegance');
    await user.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(within(rowOf('Effortless Elegance')).getByText('公開中')).toBeInTheDocument();
  });

  it('SCR-LOOK-006 切り替えの通信の例外でも alert を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockRejectedValueOnce(new Error('network'));

    render(<LookSection />);
    await screen.findByText('Effortless Elegance');
    await user.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
  });

  it('SCR-LOOK-006 削除は確かめを出し、同意しなければ送らない', async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED]));

    render(<LookSection />);
    await screen.findByText('Effortless Elegance');
    await user.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '削除' }));

    expect(confirmSpy).toHaveBeenCalledWith('このLOOKを削除してもよろしいですか？');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Effortless Elegance')).toBeInTheDocument();
  });

  it('SCR-LOOK-006 削除に同意すると DELETE を送り、一覧を読み直す', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(okList([PUBLISHED, PRIVATE]))
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce(okList([PRIVATE]));

    render(<LookSection />);
    await screen.findByText('Effortless Elegance');
    await user.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(screen.queryByText('Effortless Elegance')).not.toBeInTheDocument());
    expect(sent(1)).toMatchObject({ url: '/api/admin/looks/11', method: 'DELETE', credentials: 'same-origin' });
    expect(sent(1).headers.get('x-csrf-token')).toBe(CSRF_TOKEN);
    expect(sent(2)).toMatchObject({ url: '/api/admin/looks', method: 'GET' });
    expect(screen.getByText('Quiet Layers')).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-006 削除が断られた時は alert を出し、LOOK を残す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockResolvedValueOnce(failed(403));

    render(<LookSection />);
    await screen.findByText('Effortless Elegance');
    await user.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('LOOKの削除に失敗しました'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Effortless Elegance')).toBeInTheDocument();
  });

  it('SCR-LOOK-006 削除の通信の例外でも alert を出す', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(okList([PUBLISHED])).mockRejectedValueOnce(new Error('network'));

    render(<LookSection />);
    await screen.findByText('Effortless Elegance');
    await user.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('LOOKの削除に失敗しました'));
  });
});
