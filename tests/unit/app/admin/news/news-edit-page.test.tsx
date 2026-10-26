import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { useParams } from 'next/navigation';
import { clientFetch } from '@/lib/client-fetch';
import EditNewsPage from '@/app/admin/news/edit/[id]/page';

const mockNewsForm = jest.fn((props: Record<string, unknown>) => {
  void props;
  return <div data-testid="news-form" />;
});

jest.mock('@/app/admin/news/NewsForm', () => ({
  NewsForm: (props: Record<string, unknown>) => mockNewsForm(props),
}));

jest.mock('next/navigation', () => ({
  useParams: jest.fn(),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

const mockUseParams = useParams as jest.MockedFunction<typeof useParams>;
const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const ARTICLE = {
  id: '12',
  title: '記事の題',
  category: 'COLLECTION',
  published_date: '2026-10-01',
  image_url: 'https://example.test/signed/news.jpg',
  content: '要約',
  detailed_content: '詳細',
  status: 'published',
};

function respond(ok: boolean, json: () => Promise<unknown>) {
  return { ok, json } as unknown as Response;
}

function lastFormProps() {
  return mockNewsForm.mock.calls[mockNewsForm.mock.calls.length - 1][0];
}

describe('EditNewsPage', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseParams.mockReturnValue({ id: '12' });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-NEWS-063 取り出しの間は「読み込み中...」を出し、フォームを出さない', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    mockClientFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<EditNewsPage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(mockNewsForm).not.toHaveBeenCalled();

    resolveFetch(respond(true, async () => ({ data: ARTICLE })));
    await screen.findByTestId('news-form');
  });

  it('DD-NEWS-063 useParams が id を返さない時は「記事IDの取得に失敗しました」を出し、取り出しを呼ばない', async () => {
    mockUseParams.mockReturnValue({} as { id: string });

    render(<EditNewsPage />);

    expect(await screen.findByText('記事IDの取得に失敗しました')).toHaveClass('text-red-600');
    expect(mockClientFetch).not.toHaveBeenCalled();
    expect(mockNewsForm).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 useParams が params を返さない時も「記事IDの取得に失敗しました」を出し、取り出しを呼ばない', async () => {
    mockUseParams.mockReturnValue(null as unknown as { id: string });

    render(<EditNewsPage />);

    expect(await screen.findByText('記事IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 成功すると取り出した値と image_url を NewsForm に渡し、送り先を /api/admin/news/<id> の PUT にする', async () => {
    mockClientFetch.mockResolvedValue(respond(true, async () => ({ data: ARTICLE })));

    render(<EditNewsPage />);

    await screen.findByTestId('news-form');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/news/12');
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
    expect(lastFormProps()).toEqual({
      submitUrl: '/api/admin/news/12',
      submitMethod: 'PUT',
      initialValues: {
        title: '記事の題',
        category: 'COLLECTION',
        date: '2026-10-01',
        content: '要約',
        detailedContent: '詳細',
        status: 'published',
      },
      existingImageUrl: 'https://example.test/signed/news.jpg',
    });
  });

  it('DD-NEWS-063 category を確かめずに型の断言だけで初めの値に入れる', async () => {
    mockClientFetch.mockResolvedValue(
      respond(true, async () => ({ data: { ...ARTICLE, category: 'UNKNOWN' } })),
    );

    render(<EditNewsPage />);

    await screen.findByTestId('news-form');
    const props = lastFormProps() as { initialValues: { category: string } };
    expect(props.initialValues.category).toBe('UNKNOWN');
  });

  it('DD-NEWS-063 応答が OK でなく error がある時はその文を出す', async () => {
    mockClientFetch.mockResolvedValue(respond(false, async () => ({ error: 'Forbidden' })));

    render(<EditNewsPage />);

    expect(await screen.findByText('Forbidden')).toHaveClass('text-red-600');
    expect(mockNewsForm).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 応答が OK でなく error が無い時は「記事の読み込みに失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValue(respond(false, async () => ({})));

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
    expect(mockNewsForm).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 応答が OK でなく JSON で読めない時は「記事の読み込みに失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValue(
      respond(false, async () => {
        throw new SyntaxError('Unexpected token');
      }),
    );

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
    expect(mockNewsForm).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 応答が OK でなく error が空の文字の時は文もフォームも描かない', async () => {
    mockClientFetch.mockResolvedValue(respond(false, async () => ({ error: '' })));

    const { container } = render(<EditNewsPage />);

    await waitFor(() => expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
    expect(mockNewsForm).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 clientFetch が例外を投げる時は記録して「記事の読み込みに失敗しました」を出す', async () => {
    const error = new Error('network down');
    mockClientFetch.mockRejectedValue(error);

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load article:', error);
    expect(mockNewsForm).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 OK の応答に data が無い時は記録して「記事の読み込みに失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValue(respond(true, async () => ({})));

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load article:', expect.any(TypeError));
    expect(mockNewsForm).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 OK の応答が JSON で読めない時は記録して「記事の読み込みに失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValue(
      respond(true, async () => {
        throw new SyntaxError('Unexpected token');
      }),
    );

    render(<EditNewsPage />);

    expect(await screen.findByText('記事の読み込みに失敗しました')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load article:', expect.any(TypeError));
    expect(mockNewsForm).not.toHaveBeenCalled();
  });

  it('DD-NEWS-063 読み終えた後に id が無くなると、フォームを描き直さずに「記事IDの取得に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValue(respond(true, async () => ({ data: ARTICLE })));
    const { rerender } = render(<EditNewsPage />);
    await screen.findByTestId('news-form');
    const callsBefore = mockNewsForm.mock.calls.length;

    mockUseParams.mockReturnValue({} as { id: string });
    rerender(<EditNewsPage />);

    expect(await screen.findByText('記事IDの取得に失敗しました')).toBeInTheDocument();
    expect(mockNewsForm.mock.calls.length).toBe(callsBefore);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['abc', '..%2F..%2Fadmin%2Fusers', '../../admin', '0', '007', '1'.repeat(19), '12/../13', '12?x=1'])(
    'DD-NEWS-063 useParams が記事の id の形でない %p を返す時は、取り出しを送らず「記事の読み込みに失敗しました」を出す（SEC-NEWS-012）',
    async (id) => {
      mockUseParams.mockReturnValue({ id });
      mockClientFetch.mockResolvedValue(respond(true, async () => ({ data: ARTICLE })));

      render(<EditNewsPage />);

      expect(await screen.findByText('記事の読み込みに失敗しました')).toHaveClass('text-red-600');
      expect(mockClientFetch).not.toHaveBeenCalled();
      expect(mockNewsForm).not.toHaveBeenCalled();
    },
  );

  it('DD-NEWS-063 記事の id の形（18 桁の数字）なら取り出しを送る', async () => {
    const id = '9'.repeat(18);
    mockUseParams.mockReturnValue({ id });
    mockClientFetch.mockResolvedValue(respond(true, async () => ({ data: ARTICLE })));

    render(<EditNewsPage />);

    await screen.findByTestId('news-form');
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/news/${id}`);
  });
});
