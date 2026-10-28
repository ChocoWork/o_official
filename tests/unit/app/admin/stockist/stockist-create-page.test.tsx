import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { clientFetch } from '@/lib/client-fetch';
import AdminStockistCreatePage from '@/app/admin/stockist/create/page';

const mockStockistForm = jest.fn((props: Record<string, unknown>) => {
  void props;
  return <div data-testid="stockist-form" />;
});

jest.mock('@/app/admin/stockist/StockistForm', () => ({
  StockistForm: (props: Record<string, unknown>) => mockStockistForm(props),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

function respond(status: number) {
  const arrayBuffer = jest.fn(async () => new ArrayBuffer(0));
  const response = { ok: status >= 200 && status < 300, status, arrayBuffer, json: jest.fn(async () => ({ error: 'x' })) };
  return { response: response as unknown as Response, arrayBuffer, json: response.json };
}

describe('AdminStockistCreatePage', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    mockStockistForm.mockImplementation(() => <div data-testid="stockist-form" />);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-STOCKIST-040 入口の確かめ GET /api/admin/stockists/access を 1 回だけ呼ぶ', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(204).response);

    render(<AdminStockistCreatePage />);

    expect(await screen.findByTestId('stockist-form')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/stockists/access');
  });

  it('DD-STOCKIST-040 確かめの応答を待つ間は「読み込み中...」だけを出し、フォームを出さない', async () => {
    let resolveAccess: (value: Response) => void = () => {};
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveAccess = resolve;
      }),
    );

    render(<AdminStockistCreatePage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
    expect(mockStockistForm).not.toHaveBeenCalled();

    await act(async () => {
      resolveAccess(respond(204).response);
    });
    expect(await screen.findByTestId('stockist-form')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-032 通ればフォームに送り先 /api/admin/stockists・送り方 POST を渡し初めの値は渡さない', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(204).response);

    render(<AdminStockistCreatePage />);

    expect(await screen.findByTestId('stockist-form')).toBeInTheDocument();
    expect(mockStockistForm).toHaveBeenCalledTimes(1);
    const props = mockStockistForm.mock.calls[0][0];
    expect(props).toEqual({
      submitUrl: '/api/admin/stockists',
      submitMethod: 'POST',
    });
    expect(props).not.toHaveProperty('initialValues');
  });

  it('DD-STOCKIST-040 401 は固定の誤りの文を出してフォームを出さない', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(401).response);

    render(<AdminStockistCreatePage />);

    const message = await screen.findByText('ログインが必要です');
    expect(message).toHaveClass('text-red-600');
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
    expect(mockStockistForm).not.toHaveBeenCalled();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-040 403 は固定の誤りの文を出してフォームを出さない', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(403).response);

    render(<AdminStockistCreatePage />);

    const message = await screen.findByText('STOCKISTを作成する権限がありません');
    expect(message).toHaveClass('text-red-600');
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
    expect(mockStockistForm).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])('DD-STOCKIST-040 %s は確かめの失敗の固定の文を出してフォームを出さない', async (status) => {
    mockClientFetch.mockResolvedValueOnce(respond(status).response);

    render(<AdminStockistCreatePage />);

    const message = await screen.findByText('権限の確認に失敗しました');
    expect(message).toHaveClass('text-red-600');
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-040 通信が失敗しても（例外）確かめの失敗の固定の文を出してフォームを出さない', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network'));

    render(<AdminStockistCreatePage />);

    expect(await screen.findByText('権限の確認に失敗しました')).toBeInTheDocument();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it.each([401, 403, 429, 503])(
    'DD-STOCKIST-040 %s の応答の本文は読み切る（no-store の応答を開いたままにして networkidle を止めない）',
    async (status) => {
      const reply = respond(status);
      mockClientFetch.mockResolvedValueOnce(reply.response);

      render(<AdminStockistCreatePage />);

      await screen.findByText(/./, { selector: '.text-red-600' });
      expect(reply.arrayBuffer).toHaveBeenCalledTimes(1);
    },
  );

  it('DD-STOCKIST-040 通った時（204）は本文が無いので読まない', async () => {
    const reply = respond(204);
    mockClientFetch.mockResolvedValueOnce(reply.response);

    render(<AdminStockistCreatePage />);

    await screen.findByTestId('stockist-form');
    expect(reply.arrayBuffer).not.toHaveBeenCalled();
  });
});
