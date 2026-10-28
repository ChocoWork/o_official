import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StockistSection from '@/components/StockistSection';

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

import { clientFetch } from '@/lib/client-fetch';

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const PUBLISHED_STOCKIST = {
  id: 1,
  name: '公開の店',
  address: '東京都渋谷区1-1-1',
  phone: '03-0000-0001',
  time: '11:00-19:00',
  holiday: '水曜日',
  status: 'published' as const,
};

const PRIVATE_STOCKIST = {
  id: 2,
  name: '非公開の店',
  address: '大阪府大阪市2-2-2',
  phone: '06-0000-0002',
  time: '12:00-20:00',
  holiday: '火曜日',
  status: 'private' as const,
};

function okResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
}

function ngResponse(): Response {
  return { ok: false, json: async () => ({}) } as Response;
}

function cardOf(name: string): HTMLElement {
  const card = screen.getByText(name).closest('[data-ui-card]');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

describe('StockistSection', () => {
  let alertSpy: jest.SpyInstance;
  let confirmSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockClientFetch.mockReset();
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
    confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
    confirmSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function renderList(stockists = [PUBLISHED_STOCKIST, PRIVATE_STOCKIST]) {
    mockClientFetch.mockResolvedValueOnce(okResponse({ data: stockists }));
    render(<StockistSection />);
    await screen.findByText(stockists[0].name);
  }

  it('DD-STOCKIST-030 取り出しの間は「読み込み中...」を出し、一覧のAPIを取りに行く', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<StockistSection />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(screen.queryByText('STOCKISTがありません')).not.toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/stockists');

    resolveFetch(okResponse({ data: [PUBLISHED_STOCKIST] }));
    expect(await screen.findByText('公開の店')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-030 1件以上あれば店ごとにカードを並べ、店舗名と住所・電話・営業時間・定休日を出す', async () => {
    await renderList();

    const card = cardOf('公開の店');
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('公開の店');
    expect(within(card).getByText('東京都渋谷区1-1-1')).toBeInTheDocument();
    expect(within(card).getByText('03-0000-0001')).toBeInTheDocument();
    expect(within(card).getByText('11:00-19:00')).toBeInTheDocument();
    expect(within(card).getByText('水曜日')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.getByText('非公開の店')).toBeInTheDocument();
  });

  it('DD-STOCKIST-030 電話が空の店でも電話の行を出す', async () => {
    await renderList([{ ...PUBLISHED_STOCKIST, phone: '' }]);

    const card = cardOf('公開の店');
    const icon = card.querySelector('.ri-phone-line');
    expect(icon).not.toBeNull();
    expect(icon?.nextElementSibling).toHaveTextContent('');
  });

  it('DD-STOCKIST-030 公開中の店は札が「公開中」の positive、ボタンが「非公開」、背景が薄い緑になる', async () => {
    await renderList();

    const card = cardOf('公開の店');
    const badge = within(card).getByText('公開中');
    expect(badge).toHaveAttribute('data-ui-badge-tone', 'positive');
    expect(within(card).getByRole('button', { name: '非公開' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '公開' })).not.toBeInTheDocument();
    expect(card.className).toContain('bg-[#f7fff1]');
    expect(card.className).not.toContain('bg-[#fafafa]');
  });

  it('DD-STOCKIST-030 非公開の店は札が「非公開」の warning、ボタンが「公開」、背景が薄い灰色になる', async () => {
    await renderList();

    const card = cardOf('非公開の店');
    const badge = within(card).getByText('非公開', { selector: '[data-ui-badge]' });
    expect(badge).toHaveAttribute('data-ui-badge-tone', 'warning');
    expect(within(card).getByRole('button', { name: '公開' })).toBeInTheDocument();
    expect(within(card).queryByText('公開中')).not.toBeInTheDocument();
    expect(card.className).toContain('bg-[#fafafa]');
    expect(card.className).not.toContain('bg-[#f7fff1]');
  });

  it('DD-STOCKIST-030 応答がOKでない時は「STOCKISTがありません」を出し、記録を残す', async () => {
    mockClientFetch.mockResolvedValueOnce(ngResponse());

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith('Failed to load stockists:', expect.any(Error));
  });

  it('DD-STOCKIST-030 clientFetch が例外を投げた時も「STOCKISTがありません」を出す', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network down'));

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith('Failed to load stockists:', expect.any(Error));
  });

  it('DD-STOCKIST-030 応答の本文の解析に失敗した時も「STOCKISTがありません」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    } as unknown as Response);

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('DD-STOCKIST-030 応答に data が無い時は空の配列として「STOCKISTがありません」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse({}));

    render(<StockistSection />);

    expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-030 公開中の店の切り替えで status が private の PATCH を送り、成功で一覧を読み直す', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce(okResponse({}));
    mockClientFetch.mockResolvedValueOnce(
      okResponse({ data: [{ ...PUBLISHED_STOCKIST, status: 'private' }, PRIVATE_STOCKIST] }),
    );

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/stockists/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'private' }),
    });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, '/api/admin/stockists');
    await waitFor(() => {
      expect(within(cardOf('公開の店')).getByText('非公開', { selector: '[data-ui-badge]' })).toBeInTheDocument();
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-030 非公開の店の切り替えで status が published の PATCH を送る', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce(okResponse({}));
    mockClientFetch.mockResolvedValueOnce(
      okResponse({ data: [PUBLISHED_STOCKIST, { ...PRIVATE_STOCKIST, status: 'published' }] }),
    );

    fireEvent.click(within(cardOf('非公開の店')).getByRole('button', { name: '公開' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/stockists/2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
    await waitFor(() => {
      expect(within(cardOf('非公開の店')).getByText('公開中')).toBeInTheDocument();
    });
  });

  it('DD-STOCKIST-030 PATCH がOKでない時は「ステータスの更新に失敗しました」の alert を出し、読み直さない', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce(ngResponse());

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith('Failed to toggle stockist status:', expect.any(Error));
    expect(within(cardOf('公開の店')).getByText('公開中')).toBeInTheDocument();
  });

  it('DD-STOCKIST-030 PATCH が例外を投げた時も「ステータスの更新に失敗しました」の alert を出す', async () => {
    await renderList();
    mockClientFetch.mockRejectedValueOnce(new Error('network down'));

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('DD-STOCKIST-030 切り替えの後の読み直しに失敗しても alert は出ず、前の一覧が残る', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce(okResponse({}));
    mockClientFetch.mockRejectedValueOnce(new Error('reload failed'));

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '非公開' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('Failed to load stockists:', expect.any(Error)));
    expect(alertSpy).not.toHaveBeenCalled();
    expect(within(cardOf('公開の店')).getByText('公開中')).toBeInTheDocument();
  });

  it('DD-STOCKIST-030 削除の確かめを取り消すと DELETE を送らない', async () => {
    await renderList();
    confirmSpy.mockReturnValue(false);

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '削除' }));

    expect(confirmSpy).toHaveBeenCalledWith('このSTOCKISTを削除してもよろしいですか？');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-030 削除に同意すると DELETE を送り、成功で一覧を読み直す', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce(okResponse({}));
    mockClientFetch.mockResolvedValueOnce(okResponse({ data: [PRIVATE_STOCKIST] }));

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/admin/stockists/1', { method: 'DELETE' });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, '/api/admin/stockists');
    await waitFor(() => expect(screen.queryByText('公開の店')).not.toBeInTheDocument());
    expect(screen.getByText('非公開の店')).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-030 DELETE がOKでない時は「STOCKISTの削除に失敗しました」の alert を出し、読み直さない', async () => {
    await renderList();
    mockClientFetch.mockResolvedValueOnce(ngResponse());

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('STOCKISTの削除に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith('Failed to delete stockist:', expect.any(Error));
    expect(screen.getByText('公開の店')).toBeInTheDocument();
  });

  it('DD-STOCKIST-030 DELETE が例外を投げた時も「STOCKISTの削除に失敗しました」の alert を出す', async () => {
    await renderList();
    mockClientFetch.mockRejectedValueOnce(new Error('network down'));

    fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '削除' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('STOCKISTの削除に失敗しました'));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  describe('回数の制限の 429（no-store。本文は使わない）でも本文を読み始める', () => {
    function limitedResponse(): { response: Response; drain: jest.Mock } {
      const drain = jest.fn(async () => new ArrayBuffer(0));
      return {
        response: { ok: false, status: 429, json: async () => ({}), arrayBuffer: drain } as unknown as Response,
        drain,
      };
    }

    it('DD-STOCKIST-030 一覧の取得が 429 の時', async () => {
      const { response, drain } = limitedResponse();
      mockClientFetch.mockResolvedValueOnce(response);

      render(<StockistSection />);

      expect(await screen.findByText('STOCKISTがありません')).toBeInTheDocument();
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('DD-STOCKIST-030 公開の切り替え（PATCH）が 429 の時', async () => {
      await renderList();
      const { response, drain } = limitedResponse();
      mockClientFetch.mockResolvedValueOnce(response);

      fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '非公開' }));

      await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ステータスの更新に失敗しました'));
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('DD-STOCKIST-030 削除（DELETE）が 429 の時', async () => {
      await renderList();
      const { response, drain } = limitedResponse();
      mockClientFetch.mockResolvedValueOnce(response);

      fireEvent.click(within(cardOf('公開の店')).getByRole('button', { name: '削除' }));

      await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('STOCKISTの削除に失敗しました'));
      expect(drain).toHaveBeenCalledTimes(1);
    });
  });

  it('DD-STOCKIST-030 「編集」の行き先が /admin/stockist/edit/<id> になる', async () => {
    await renderList();

    expect(within(cardOf('公開の店')).getByRole('link', { name: '編集' })).toHaveAttribute(
      'href',
      '/admin/stockist/edit/1',
    );
    expect(within(cardOf('非公開の店')).getByRole('link', { name: '編集' })).toHaveAttribute(
      'href',
      '/admin/stockist/edit/2',
    );
  });
});
