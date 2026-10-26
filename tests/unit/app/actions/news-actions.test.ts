import { getLatestNews } from '@/app/actions/news';
import { getPublishedNews } from '@/features/news/services/public';

jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn(),
}));

const mockGetPublishedNews = getPublishedNews as jest.MockedFunction<typeof getPublishedNews>;

describe('getLatestNews', () => {
  beforeEach(() => {
    mockGetPublishedNews.mockReset();
  });

  it('DD-NEWS-066 getPublishedNews を limit 3 で1回呼び、その結果をそのまま返す', async () => {
    const articles = [
      { id: '3' },
      { id: '2' },
      { id: '1' },
    ] as unknown as Awaited<ReturnType<typeof getPublishedNews>>;
    mockGetPublishedNews.mockResolvedValue(articles);

    const result = await getLatestNews();

    expect(mockGetPublishedNews).toHaveBeenCalledTimes(1);
    expect(mockGetPublishedNews).toHaveBeenCalledWith({ limit: 3 });
    expect(result).toBe(articles);
  });

  it('DD-NEWS-066 呼ぶ先が空の配列を返す時は空の配列を返す', async () => {
    mockGetPublishedNews.mockResolvedValue([]);

    await expect(getLatestNews()).resolves.toEqual([]);
  });

  it('DD-NEWS-066 呼ぶ先の NewsFetchError もそのまま投げ、空の配列に直さない（SEC-NEWS-020）', async () => {
    const error = Object.assign(new Error('Failed to fetch published news'), {
      name: 'NewsFetchError',
      code: null,
    });
    mockGetPublishedNews.mockRejectedValue(error);

    await expect(getLatestNews()).rejects.toBe(error);
  });

  it('DD-NEWS-066 呼ぶ先の例外をそのまま投げる', async () => {
    const error = new Error('db down');
    mockGetPublishedNews.mockRejectedValue(error);

    await expect(getLatestNews()).rejects.toBe(error);
  });
});
