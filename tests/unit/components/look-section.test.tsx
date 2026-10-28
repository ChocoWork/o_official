import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LookSection from '@/components/LookSection';
import { clientFetch } from '@/lib/client-fetch';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) =>
    React.createElement('img', { src, alt }),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const PUBLISHED_LOOK = {
  id: 1,
  season_year: 2026,
  season_type: 'SS',
  theme: '公開のテーマ',
  image_urls: ['https://example.test/look-1.jpg', 'https://example.test/look-1b.jpg'],
  status: 'published',
};

const PRIVATE_LOOK = {
  id: 2,
  season_year: 2025,
  season_type: 'AW',
  theme: '非公開のテーマ',
  image_urls: ['https://example.test/look-2.jpg'],
  status: 'private',
};

function respond(ok: boolean, body: unknown = {}) {
  return { ok, json: async () => body } as unknown as Response;
}

/** 一覧の取得の応答を1回分積む（既定は管理の権限あり） */
function mockList(data: unknown, meta: unknown = { canManage: true }) {
  mockClientFetch.mockResolvedValueOnce(respond(true, { data, meta }));
}

/** テーマの文字を含むカード（画像・札・ボタンの親）を返す */
function cardOf(theme: string): HTMLElement {
  const card = screen.getByText(theme).closest('[data-ui-card]');
  return card as HTMLElement;
}

describe('LookSection', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let confirmSpy: jest.SpyInstance;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    confirmSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('DD-LOOK-060 一覧の応答を待つ間は「読み込み中...」を出す', async () => {
    let resolveList: (value: Response) => void = () => {};
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<LookSection />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(screen.queryByText('LOOKがありません')).not.toBeInTheDocument();

    await act(async () => {
      resolveList(respond(true, { data: [] }));
    });
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-LOOK-060 公開中と非公開のカードに札・切り替えボタン・編集リンクを出す', async () => {
    mockList([PUBLISHED_LOOK, PRIVATE_LOOK]);

    render(<LookSection />);

    await screen.findByText('公開のテーマ');
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/looks');

    const published = cardOf('公開のテーマ');
    expect(within(published).getByText('公開中')).toHaveAttribute(
      'data-ui-tag-label-variant',
      'solid',
    );
    expect(within(published).getByText('2026 SS')).toBeInTheDocument();
    expect(within(published).getByRole('button', { name: '非公開' })).toBeInTheDocument();
    expect(within(published).getByRole('link', { name: '編集' })).toHaveAttribute(
      'href',
      '/admin/look/edit/1',
    );
    expect(within(published).getByRole('button', { name: '削除' })).toBeInTheDocument();
    expect(within(published).getByRole('img')).toHaveAttribute(
      'src',
      'https://example.test/look-1.jpg',
    );

    const priv = cardOf('非公開のテーマ');
    expect(within(priv).getByText('非公開', { selector: 'span' })).toHaveAttribute(
      'data-ui-tag-label-variant',
      'outline',
    );
    expect(within(priv).getByText('2025 AW')).toBeInTheDocument();
    expect(within(priv).getByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(priv).getByRole('link', { name: '編集' })).toHaveAttribute(
      'href',
      '/admin/look/edit/2',
    );
  });

  describe('操作ボタンの出し分け', () => {
    it.each([
      ['canManage が false', { canManage: false }],
      ['meta が空', {}],
      ['meta が無い', undefined],
      ['canManage が文字の true', { canManage: 'true' }],
      ['canManage が 1', { canManage: 1 }],
    ])('DD-LOOK-060 %s の時はカードの公開の切り替え・編集・削除を出さず、LOOK 自体は見せる', async (_label, meta) => {
      mockClientFetch.mockResolvedValueOnce(respond(true, { data: [PUBLISHED_LOOK, PRIVATE_LOOK], meta }));

      render(<LookSection />);

      await screen.findByText('公開のテーマ');
      for (const theme of ['公開のテーマ', '非公開のテーマ']) {
        const card = cardOf(theme);
        expect(within(card).queryByRole('button')).not.toBeInTheDocument();
        expect(within(card).queryByRole('link')).not.toBeInTheDocument();
        expect(within(card).getByRole('img')).toBeInTheDocument();
      }
      expect(screen.getByText('公開中')).toBeInTheDocument();
      expect(screen.getByText('2026 SS')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: '編集' })).not.toBeInTheDocument();
    });

    it('DD-LOOK-060 canManage が true の時は各カードに公開（または非公開）・編集・削除が出る', async () => {
      mockList([PUBLISHED_LOOK, PRIVATE_LOOK], { canManage: true });

      render(<LookSection />);

      await screen.findByText('公開のテーマ');
      for (const theme of ['公開のテーマ', '非公開のテーマ']) {
        const card = cardOf(theme);
        expect(within(card).getAllByRole('button')).toHaveLength(2);
        expect(within(card).getByRole('link', { name: '編集' })).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: '削除' })).toBeInTheDocument();
      }
    });

    it('DD-LOOK-060 canManage が true の時だけ「新規作成」を出し、作成の頁へのリンクにする', async () => {
      mockList([PUBLISHED_LOOK], { canManage: true });

      render(<LookSection />);

      await screen.findByText('公開のテーマ');
      expect(screen.getByRole('link', { name: '新規作成' })).toHaveAttribute('href', '/admin/look/create');
    });

    it('DD-LOOK-060 canManage が true なら LOOK が 0 件でも「新規作成」を出す（最初の 1 件を作れる）', async () => {
      mockList([], { canManage: true });

      render(<LookSection />);

      expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: '新規作成' })).toHaveAttribute('href', '/admin/look/create');
    });

    it.each([
      ['canManage が false', { canManage: false }],
      ['meta が空', {}],
      ['meta が無い', undefined],
      ['canManage が文字の true', { canManage: 'true' }],
    ])('DD-LOOK-060 %s の時は LOOK があっても 0 件でも「新規作成」を出さない', async (_label, meta) => {
      mockClientFetch.mockResolvedValueOnce(respond(true, { data: [PUBLISHED_LOOK], meta }));
      const { unmount } = render(<LookSection />);
      await screen.findByText('公開のテーマ');
      expect(screen.queryByRole('link', { name: '新規作成' })).not.toBeInTheDocument();
      unmount();

      mockClientFetch.mockResolvedValueOnce(respond(true, { data: [], meta }));
      render(<LookSection />);
      await screen.findByText('LOOKがありません');
      expect(screen.queryByRole('link', { name: '新規作成' })).not.toBeInTheDocument();
    });

    it('DD-LOOK-060 読み込み中と取得の失敗では「新規作成」を出さない', async () => {
      mockClientFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
      const { unmount } = render(<LookSection />);
      expect(screen.queryByRole('link', { name: '新規作成' })).not.toBeInTheDocument();
      unmount();

      mockClientFetch.mockResolvedValueOnce(respond(false, { error: 'Forbidden' }));
      render(<LookSection />);
      await screen.findByText('LOOKがありません');
      expect(screen.queryByRole('link', { name: '新規作成' })).not.toBeInTheDocument();
    });

    it('DD-LOOK-060 読み込み中はボタンを出さない（一覧を取る前に権限を決めつけない）', () => {
      mockClientFetch.mockReturnValueOnce(new Promise<Response>(() => {}));

      render(<LookSection />);

      expect(screen.getByText('読み込み中...')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('DD-LOOK-060 一覧の取得に失敗した時もボタンを出さない', async () => {
      mockClientFetch.mockResolvedValueOnce(respond(false, { error: 'Forbidden' }));

      render(<LookSection />);

      await screen.findByText('LOOKがありません');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('DD-LOOK-060 取り直した一覧で canManage が false になったらボタンを引っ込める', async () => {
      mockList([PUBLISHED_LOOK], { canManage: true });
      mockClientFetch.mockResolvedValueOnce(respond(true));
      mockList([PUBLISHED_LOOK], { canManage: false });

      render(<LookSection />);
      await screen.findByText('公開のテーマ');

      fireEvent.click(screen.getByRole('button', { name: '非公開' }));

      await waitFor(() => expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument());
      expect(screen.getByText('公開のテーマ')).toBeInTheDocument();
    });
  });

  it('DD-LOOK-060 一度 canManage が true になった後、取り直しが失敗したらボタンを引っ込める', async () => {
    mockList([PUBLISHED_LOOK], { canManage: true });
    mockClientFetch.mockResolvedValueOnce(respond(true));
    mockClientFetch.mockResolvedValueOnce(respond(false));

    render(<LookSection />);
    await screen.findByText('公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument());
    expect(screen.getByText('公開のテーマ')).toBeInTheDocument();
  });

  it('DD-LOOK-060 data が無い応答は「LOOKがありません」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(true, {}));

    render(<LookSection />);

    expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('DD-LOOK-060 一覧の応答が ok でなければ記録して「LOOKがありません」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(false, { error: 'Forbidden' }));

    render(<LookSection />);

    expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to load looks:',
      expect.objectContaining({ message: 'Failed to fetch looks' }),
    );
  });

  it('DD-LOOK-060 一覧の取得が例外なら記録して「LOOKがありません」を出す', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network down'));

    render(<LookSection />);

    expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to load looks:',
      expect.objectContaining({ message: 'network down' }),
    );
  });

  it('DD-LOOK-060 image_urls が空か無い LOOK は /placeholder.png を出す', async () => {
    mockList([
      { ...PUBLISHED_LOOK, id: 3, theme: '空の画像', image_urls: [] },
      { ...PRIVATE_LOOK, id: 4, theme: '画像の項目なし', image_urls: undefined },
    ]);

    render(<LookSection />);

    await screen.findByText('空の画像');
    expect(within(cardOf('空の画像')).getByRole('img')).toHaveAttribute('src', '/placeholder.png');
    expect(within(cardOf('画像の項目なし')).getByRole('img')).toHaveAttribute(
      'src',
      '/placeholder.png',
    );
  });

  it('DD-LOOK-060 公開中の LOOK を切り替えると private を PATCH して一覧を取り直す', async () => {
    mockList([PUBLISHED_LOOK]);
    mockClientFetch.mockResolvedValueOnce(respond(true));
    mockList([{ ...PUBLISHED_LOOK, status: 'private' }]);

    render(<LookSection />);
    await screen.findByText('公開中');

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '公開' })).toBeInTheDocument());
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/looks/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'private' }),
    });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, '/api/admin/looks');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-LOOK-060 非公開の LOOK を切り替えると published を PATCH する', async () => {
    mockList([PRIVATE_LOOK]);
    mockClientFetch.mockResolvedValueOnce(respond(true));
    mockList([{ ...PRIVATE_LOOK, status: 'published' }]);

    render(<LookSection />);
    await screen.findByText('非公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '公開' }));

    await waitFor(() => expect(screen.getByText('公開中')).toBeInTheDocument());
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/looks/2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
  });

  it('DD-LOOK-060 取り直しの最中も一覧のまま「読み込み中...」に戻さない', async () => {
    mockList([PUBLISHED_LOOK]);
    mockClientFetch.mockResolvedValueOnce(respond(true));
    let resolveRefetch: (value: Response) => void = () => {};
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRefetch = resolve;
      }),
    );

    render(<LookSection />);
    await screen.findByText('公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));

    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(screen.getByText('公開のテーマ')).toBeInTheDocument();

    await act(async () => {
      resolveRefetch(respond(true, { data: [PUBLISHED_LOOK] }));
    });
  });

  it('DD-LOOK-060 切り替えの応答が ok でなければ記録して alert を出し取り直さない', async () => {
    mockList([PUBLISHED_LOOK]);
    mockClientFetch.mockResolvedValueOnce(respond(false));

    render(<LookSection />);
    await screen.findByText('公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '非公開' }));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to toggle look status:',
      expect.objectContaining({ message: 'Failed to update status' }),
    );
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('DD-LOOK-060 切り替えが例外なら記録して alert を出す', async () => {
    mockList([PRIVATE_LOOK]);
    mockClientFetch.mockRejectedValueOnce(new Error('offline'));

    render(<LookSection />);
    await screen.findByText('非公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '公開' }));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to toggle look status:',
      expect.objectContaining({ message: 'offline' }),
    );
  });

  it('DD-LOOK-060 削除の確かめで断ると DELETE を送らない', async () => {
    mockList([PUBLISHED_LOOK]);
    confirmSpy.mockReturnValue(false);

    render(<LookSection />);
    await screen.findByText('公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    expect(confirmSpy).toHaveBeenCalledWith('このLOOKを削除してもよろしいですか？');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-LOOK-060 削除に同意すると DELETE を送って一覧を取り直す', async () => {
    mockList([PUBLISHED_LOOK, PRIVATE_LOOK]);
    mockClientFetch.mockResolvedValueOnce(respond(true));
    mockList([PRIVATE_LOOK]);

    render(<LookSection />);
    await screen.findByText('公開のテーマ');

    fireEvent.click(within(cardOf('公開のテーマ')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(screen.queryByText('公開のテーマ')).not.toBeInTheDocument());
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/looks/1', {
      method: 'DELETE',
    });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, '/api/admin/looks');
    expect(screen.getByText('非公開のテーマ')).toBeInTheDocument();
  });

  it('DD-LOOK-060 削除の応答が ok でなければ記録して alert を出し一覧を残す', async () => {
    mockList([PUBLISHED_LOOK]);
    mockClientFetch.mockResolvedValueOnce(respond(false));

    render(<LookSection />);
    await screen.findByText('公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('LOOKの削除に失敗しました'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to delete look:',
      expect.objectContaining({ message: 'Failed to delete look' }),
    );
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('公開のテーマ')).toBeInTheDocument();
  });

  it('DD-LOOK-060 削除が例外なら記録して alert を出す', async () => {
    mockList([PUBLISHED_LOOK]);
    mockClientFetch.mockRejectedValueOnce(new Error('boom'));

    render(<LookSection />);
    await screen.findByText('公開のテーマ');

    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('LOOKの削除に失敗しました'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to delete look:',
      expect.objectContaining({ message: 'boom' }),
    );
  });

  describe('429（本文は使わない）でも本文を読み始める（波 4 Task 1b）', () => {
    /** 回数の制限の 429 は no-store。arrayBuffer が呼ばれたかを見る */
    function limited(): { response: Response; drain: jest.Mock } {
      const drain = jest.fn(async () => new ArrayBuffer(0));
      return {
        response: { ok: false, status: 429, json: async () => ({ error: 'Too many requests' }), arrayBuffer: drain } as unknown as Response,
        drain,
      };
    }

    it('DD-LOOK-060 一覧の取得（GET）が 429 の時', async () => {
      const { response, drain } = limited();
      mockClientFetch.mockResolvedValueOnce(response);

      render(<LookSection />);

      expect(await screen.findByText('LOOKがありません')).toBeInTheDocument();
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('DD-LOOK-060 公開の切り替え（PATCH）が 429 の時', async () => {
      const { response, drain } = limited();
      mockList([PUBLISHED_LOOK]);
      mockClientFetch.mockResolvedValueOnce(response);

      render(<LookSection />);
      await screen.findByText('公開のテーマ');

      fireEvent.click(screen.getByRole('button', { name: '非公開' }));

      await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('DD-LOOK-060 削除（DELETE）が 429 の時', async () => {
      const { response, drain } = limited();
      mockList([PUBLISHED_LOOK]);
      mockClientFetch.mockResolvedValueOnce(response);

      render(<LookSection />);
      await screen.findByText('公開のテーマ');

      fireEvent.click(screen.getByRole('button', { name: '削除' }));

      await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('LOOKの削除に失敗しました'));
      expect(drain).toHaveBeenCalledTimes(1);
    });
  });
});
