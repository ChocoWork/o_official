import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useParams } from 'next/navigation';
import { clientFetch } from '@/lib/client-fetch';
import AdminLookEditPage from '@/app/admin/look/edit/[id]/page';

const mockLookForm = jest.fn((props: Record<string, unknown>) => {
  void props;
  return <div data-testid="look-form" />;
});

jest.mock('@/app/admin/look/LookForm', () => ({
  LookForm: (props: Record<string, unknown>) => mockLookForm(props),
}));

jest.mock('next/navigation', () => ({
  useParams: jest.fn(),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

const mockUseParams = useParams as jest.MockedFunction<typeof useParams>;
const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const LOOK = {
  id: 7,
  season_year: 2026,
  season_type: 'AW',
  theme: '冬のテーマ',
  theme_description: '冬の説明',
  image_urls: ['https://example.test/a.jpg', 'https://example.test/b.jpg'],
  status: 'published',
  linkedItemIds: [3, 5],
};

function respond(ok: boolean, json: () => Promise<unknown>) {
  return { ok, json } as unknown as Response;
}

function lastFormProps() {
  const calls = mockLookForm.mock.calls;
  return calls[calls.length - 1][0];
}

describe('AdminLookEditPage', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    mockLookForm.mockImplementation(() => <div data-testid="look-form" />);
    mockUseParams.mockReturnValue({ id: '7' });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-LOOK-062 取り出しの応答を待つ間は「読み込み中...」を出す', async () => {
    let resolveLook: (value: Response) => void = () => {};
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveLook = resolve;
      }),
    );

    render(<AdminLookEditPage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(screen.queryByTestId('look-form')).not.toBeInTheDocument();

    await act(async () => {
      resolveLook(respond(true, async () => ({ data: LOOK })));
    });
    expect(await screen.findByTestId('look-form')).toBeInTheDocument();
  });

  it.each([
    ['id が空のオブジェクト', {}],
    ['params が null', null],
  ])('DD-LOOK-062 %s なら取り出さず「LOOK IDの取得に失敗しました」を出す', async (_label, params) => {
    mockUseParams.mockReturnValue(params as unknown as ReturnType<typeof useParams>);

    render(<AdminLookEditPage />);

    const message = await screen.findByText('LOOK IDの取得に失敗しました');
    expect(message).toHaveClass('text-red-600');
    expect(mockClientFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('look-form')).not.toBeInTheDocument();
  });

  it('DD-LOOK-062 取り出しに成功すると詰めた初めの値で LookForm を PUT で描く', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(true, async () => ({ data: LOOK })));

    render(<AdminLookEditPage />);

    expect(await screen.findByTestId('look-form')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/looks/7');
    expect(lastFormProps()).toEqual({
      submitUrl: '/api/admin/looks/7',
      submitMethod: 'PUT',
      initialValues: {
        seasonYear: 2026,
        seasonType: 'AW',
        theme: '冬のテーマ',
        themeDescription: '冬の説明',
        status: 'published',
        linkedItemIds: [3, 5],
        previewUrls: ['https://example.test/a.jpg', 'https://example.test/b.jpg'],
      },
    });
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-LOOK-062 欄が欠けた data は空の文字・空の配列で詰める', async () => {
    mockClientFetch.mockResolvedValueOnce(
      respond(true, async () => ({
        data: {
          ...LOOK,
          theme_description: undefined,
          linkedItemIds: undefined,
          image_urls: null,
        },
      })),
    );

    render(<AdminLookEditPage />);

    await screen.findByTestId('look-form');
    expect(lastFormProps().initialValues).toEqual({
      seasonYear: 2026,
      seasonType: 'AW',
      theme: '冬のテーマ',
      themeDescription: '',
      status: 'published',
      linkedItemIds: [],
      previewUrls: [],
    });
  });

  it('DD-LOOK-062 ok でない応答はサーバーの error の文を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      respond(false, async () => ({ error: 'Look not found' })),
    );

    render(<AdminLookEditPage />);

    const message = await screen.findByText('Look not found');
    expect(message).toHaveClass('text-red-600');
    expect(screen.queryByTestId('look-form')).not.toBeInTheDocument();
  });

  it('DD-LOOK-062 ok でなく error も無い応答は「LOOKの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(false, async () => ({})));

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
  });

  it('DD-LOOK-062 応答の JSON が読めなくても「LOOKの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      respond(false, async () => {
        throw new Error('invalid json');
      }),
    );

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByTestId('look-form')).not.toBeInTheDocument();
  });

  it('DD-LOOK-062 ok でも data が無ければ「LOOKの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(respond(true, async () => ({})));

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByTestId('look-form')).not.toBeInTheDocument();
  });

  it('DD-LOOK-062 ok でも JSON が読めず data が無ければ「LOOKの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      respond(true, async () => {
        throw new Error('invalid json');
      }),
    );

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
  });

  it('DD-LOOK-062 取り出しが例外なら記録して「LOOKの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network down'));

    render(<AdminLookEditPage />);

    expect(await screen.findByText('LOOKの取得に失敗しました')).toBeInTheDocument();
    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to fetch look:',
        expect.objectContaining({ message: 'network down' }),
      ),
    );
    expect(screen.queryByTestId('look-form')).not.toBeInTheDocument();
  });
});
