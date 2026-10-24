import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LookSection from '@/components/LookSection';
import AdminLookCreatePage from '@/app/admin/look/create/page';
import AdminLookEditPage from '@/app/admin/look/edit/[id]/page';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: '11' }),
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

const LIST_URL = '/admin?tab=LOOK';

const ITEMS = [
  { id: 101, name: 'リネンシャツ', price: 12000, image_url: 'https://example.test/signed/101.jpg', status: 'published' },
];

const LOOK = {
  id: 11,
  season_year: 2026,
  season_type: 'SS' as const,
  theme: 'Effortless Elegance',
  theme_description: '説明',
  image_urls: ['https://example.test/signed/11-a.jpg'],
  status: 'published' as const,
  linkedItemIds: [101],
};

const OTHER = { ...LOOK, id: 12, theme: 'Quiet Layers', status: 'private' as const };

function json(ok: boolean, body: unknown): Response {
  return { ok, status: ok ? 200 : 400, statusText: '', json: async () => body } as unknown as Response;
}

function makeFile(name: string, type: string) {
  return new File(['x'], name, { type });
}

function rowOf(theme: string): HTMLElement {
  let node: HTMLElement | null = screen.getByText(theme);
  while (node && !(within(node).queryByRole('button', { name: '削除' }) && within(node).queryByRole('img'))) {
    node = node.parentElement;
  }
  if (!node) throw new Error(`row for ${theme} not found`);
  return node;
}

// 一覧の取り出し・商品の取り出し・保存の送信を、URL と方法で振り分ける
let listResults: Array<() => Promise<Response>>;
let itemResult: () => Promise<Response>;
let lookResult: () => Promise<Response>;
let submitResult: () => Promise<Response>;

function sentTo(url: string, method: string) {
  return mockFetch.mock.calls.filter(([u, init]) => u === url && (init as RequestInit).method === method);
}

describe('LOOK の管理の一覧と作成・編集の行き来', () => {
  let getContextSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let alertSpy: jest.SpyInstance;
  let confirmSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPush.mockReset();
    mockFetch.mockReset();
    listResults = [async () => json(true, { data: [LOOK, OTHER] })];
    itemResult = async () => json(true, { data: ITEMS });
    lookResult = async () => json(true, { data: LOOK });
    submitResult = async () => json(true, { data: LOOK });
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/admin/items') return itemResult();
      if (url === '/api/admin/looks' && method === 'GET') {
        // 読み直すたびに次の結果を返し、足りなくなったら最後のものを返す
        const next = listResults.length > 1 ? listResults.shift()! : listResults[0];
        return next();
      }
      if (method === 'GET') return lookResult();
      return submitResult();
    });
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

  it('FLOW-LOOK-002 一覧の編集は LOOK ごとの編集の画面へつながる', async () => {
    render(<LookSection />);
    await screen.findByText('Effortless Elegance');

    expect(within(rowOf('Effortless Elegance')).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/look/edit/11');
    expect(within(rowOf('Quiet Layers')).getByRole('link', { name: '編集' })).toHaveAttribute('href', '/admin/look/edit/12');
  });

  it('FLOW-LOOK-002 作成の保存に成功すると保存しました を見せ、すぐ一覧へ戻る', async () => {
    const { container } = render(<AdminLookCreatePage />);
    await screen.findByText('リネンシャツ');
    fireEvent.change(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), { target: { value: 'New theme' } });
    fireEvent.click(screen.getByText('リネンシャツ'));
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('a.png', 'image/png')] },
    });
    await screen.findByRole('img', { name: 'プレビュー 1' });

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lookを保存しました'));
    expect(sentTo('/api/admin/looks', 'POST')).toHaveLength(1);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
  });

  it('FLOW-LOOK-002 編集の更新に成功すると Lookを更新しました を見せ、一覧へ戻る', async () => {
    const { container } = render(<AdminLookEditPage />);
    await screen.findByDisplayValue('Effortless Elegance');

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lookを更新しました'));
    expect(sentTo('/api/admin/looks/11', 'PUT')).toHaveLength(1);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
  });

  it('FLOW-LOOK-002 作成のキャンセルは送らずに一覧へ戻る', async () => {
    render(<AdminLookCreatePage />);
    await screen.findByText('リネンシャツ');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
    expect(sentTo('/api/admin/looks', 'POST')).toHaveLength(0);
  });

  it('FLOW-LOOK-002 編集のキャンセルは送らずに一覧へ戻る', async () => {
    render(<AdminLookEditPage />);
    await screen.findByDisplayValue('Effortless Elegance');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(mockPush).toHaveBeenCalledWith(LIST_URL);
    expect(sentTo('/api/admin/looks/11', 'PUT')).toHaveLength(0);
  });

  it('FLOW-LOOK-002 作成の保存に失敗すると同じ画面に文を出し、移らない', async () => {
    submitResult = async () => json(false, { error: '保存できません' });
    const { container } = render(<AdminLookCreatePage />);
    await screen.findByText('リネンシャツ');
    fireEvent.change(screen.getByLabelText(/^シーズンテーマ(?!詳細)/), { target: { value: 'New theme' } });
    fireEvent.click(screen.getByText('リネンシャツ'));
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('a.png', 'image/png')] },
    });
    await screen.findByRole('img', { name: 'プレビュー 1' });

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('保存できません'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('FLOW-LOOK-002 編集の更新に失敗すると同じ画面に文を出し、移らない', async () => {
    submitResult = async () => {
      throw new Error('network');
    };
    const { container } = render(<AdminLookEditPage />);
    await screen.findByDisplayValue('Effortless Elegance');

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('通信エラーが発生しました'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('FLOW-LOOK-002 編集の頁で取り出しに失敗すると、その頁に文を出して移らない', async () => {
    lookResult = async () => json(false, { error: 'Not found' });

    render(<AdminLookEditPage />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-LOOK-002 一覧の上で公開を切り替えると読み直した状態を出し、画面を移らない', async () => {
    listResults = [
      async () => json(true, { data: [LOOK] }),
      async () => json(true, { data: [{ ...LOOK, status: 'private' }] }),
    ];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PATCH') return Promise.resolve(json(true, {}));
      return listResults.length > 1 ? listResults.shift()!() : listResults[0]();
    });
    render(<LookSection />);
    await screen.findByText('Effortless Elegance');

    fireEvent.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '非公開' }));

    expect(await within(rowOf('Effortless Elegance')).findByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(rowOf('Effortless Elegance')).getAllByText('非公開')).toHaveLength(1);
    expect(sentTo('/api/admin/looks/11', 'PATCH')).toHaveLength(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-LOOK-002 一覧の上で削除を確かめて同意すると、読み直した一覧から LOOK が消える', async () => {
    listResults = [
      async () => json(true, { data: [LOOK, OTHER] }),
      async () => json(true, { data: [OTHER] }),
    ];
    render(<LookSection />);
    await screen.findByText('Effortless Elegance');

    fireEvent.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(screen.queryByText('Effortless Elegance')).not.toBeInTheDocument());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(sentTo('/api/admin/looks/11', 'DELETE')).toHaveLength(1);
    expect(screen.getByText('Quiet Layers')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('FLOW-LOOK-002 削除の確かめで断ると送らずに一覧に留まる', async () => {
    confirmSpy.mockReturnValue(false);
    render(<LookSection />);
    await screen.findByText('Effortless Elegance');

    fireEvent.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '削除' }));

    expect(sentTo('/api/admin/looks/11', 'DELETE')).toHaveLength(0);
    expect(screen.getByText('Effortless Elegance')).toBeInTheDocument();
  });

  it('FLOW-LOOK-002 一覧の上の操作に失敗すると alert を出し、前の一覧のまま留まる', async () => {
    submitResult = async () => json(false, {});
    render(<LookSection />);
    await screen.findByText('Effortless Elegance');

    fireEvent.click(within(rowOf('Effortless Elegance')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('LOOKの削除に失敗しました'));
    expect(screen.getByText('Effortless Elegance')).toBeInTheDocument();
    expect(mockFetch.mock.calls.filter(([u, init]) => u === '/api/admin/looks' && (init as RequestInit).method === 'GET')).toHaveLength(1);
  });
});
