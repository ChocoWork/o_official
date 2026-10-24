import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useParams } from 'next/navigation';
import { clientFetch } from '@/lib/client-fetch';
import AdminStockistEditPage from '@/app/admin/stockist/edit/[id]/page';

const mockStockistForm = jest.fn((props: Record<string, unknown>) => {
  void props;
  return <div data-testid="stockist-form" />;
});

jest.mock('@/app/admin/stockist/StockistForm', () => ({
  StockistForm: (props: Record<string, unknown>) => mockStockistForm(props),
}));

jest.mock('next/navigation', () => ({
  useParams: jest.fn(),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

const mockUseParams = useParams as jest.MockedFunction<typeof useParams>;
const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const STOCKIST = {
  id: 7,
  name: '青山店',
  address: '東京都港区南青山1-2-3',
  phone: '03-1234-5678',
  time: '11:00-19:00',
  holiday: '水曜日',
  status: 'published',
  created_at: '2026-01-01T00:00:00Z',
};

function respond(ok: boolean, json: () => Promise<unknown>) {
  return { ok, json } as unknown as Response;
}

function lastFormProps() {
  const calls = mockStockistForm.mock.calls;
  return calls[calls.length - 1][0];
}

describe('AdminStockistEditPage', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    mockStockistForm.mockImplementation(() => <div data-testid="stockist-form" />);
    mockUseParams.mockReturnValue({ id: '7' });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-STOCKIST-033 取り出しの応答を待つ間は「読み込み中...」だけを出す', async () => {
    let resolveStockist: (value: Response) => void = () => {};
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveStockist = resolve;
      }),
    );

    render(<AdminStockistEditPage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();

    await act(async () => {
      resolveStockist(respond(true, async () => ({ data: STOCKIST })));
    });
    expect(await screen.findByTestId('stockist-form')).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it.each([
    ['id が空のオブジェクト', {}],
    ['params が null', null],
  ])(
    'DD-STOCKIST-033 %s なら取り出さず「STOCKIST IDの取得に失敗しました」を赤で出す',
    async (_label, params) => {
      mockUseParams.mockReturnValue(params as unknown as ReturnType<typeof useParams>);

      render(<AdminStockistEditPage />);

      const message = await screen.findByText('STOCKIST IDの取得に失敗しました');
      expect(message).toHaveClass('text-red-600');
      expect(mockClientFetch).not.toHaveBeenCalled();
      expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
      expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    },
  );

  it('DD-STOCKIST-033 取り出しに成功すると6つの値を初めの値にして StockistForm を PUT で描く', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(true, async () => ({ data: STOCKIST })));

    render(<AdminStockistEditPage />);

    expect(await screen.findByTestId('stockist-form')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/stockists/7');
    expect(lastFormProps()).toEqual({
      submitUrl: '/api/admin/stockists/7',
      submitMethod: 'PUT',
      initialValues: {
        name: '青山店',
        address: '東京都港区南青山1-2-3',
        phone: '03-1234-5678',
        time: '11:00-19:00',
        holiday: '水曜日',
        status: 'published',
      },
    });
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 ok でない応答はサーバーの error の文を赤で出す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      respond(false, async () => ({ error: 'Stockist not found' })),
    );

    render(<AdminStockistEditPage />);

    const message = await screen.findByText('Stockist not found');
    expect(message).toHaveClass('text-red-600');
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 403 の Forbidden もそのまま出す', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(false, async () => ({ error: 'Forbidden' })));

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('Forbidden')).toHaveClass('text-red-600');
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 数でない id は窓口の 400 の文 Invalid stockist id をそのまま出す', async () => {
    mockUseParams.mockReturnValue({ id: 'abc' });
    mockClientFetch.mockResolvedValueOnce(
      respond(false, async () => ({ error: 'Invalid stockist id' })),
    );

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('Invalid stockist id')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/stockists/abc');
  });

  it('DD-STOCKIST-033 ok でなく error も無い応答は「STOCKISTの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(false, async () => ({})));

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 ok でなく error が空の文字の応答は何も描かない（白い頁になる現状の記録。直したらこの件を直す）', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(false, async () => ({ error: '' })));

    const { container } = render(<AdminStockistEditPage />);

    await waitFor(() => expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 ok でなく本文が JSON でない応答も「STOCKISTの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      respond(false, async () => {
        throw new Error('invalid json');
      }),
    );

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 ok でも data が無ければ「STOCKISTの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(true, async () => ({})));

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 ok でも本文が JSON でなければ「STOCKISTの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      respond(true, async () => {
        throw new Error('invalid json');
      }),
    );

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-033 取り出しが例外なら記録して「STOCKISTの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network down'));

    render(<AdminStockistEditPage />);

    expect(await screen.findByText('STOCKISTの取得に失敗しました')).toBeInTheDocument();
    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to fetch stockist:',
        expect.objectContaining({ message: 'network down' }),
      ),
    );
    expect(screen.queryByTestId('stockist-form')).not.toBeInTheDocument();
  });
});
