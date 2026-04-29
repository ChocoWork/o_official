import { extractNewsImageObjectPath, signNewsImageUrl } from '@/lib/storage/news-images';

describe('news-images storage helpers', () => {
  it('extracts object path from a plain storage path', () => {
    expect(extractNewsImageObjectPath('news/2026-04-26/article.jpg')).toBe('news/2026-04-26/article.jpg');
  });

  it('extracts object path from legacy public URLs', () => {
    expect(
      extractNewsImageObjectPath(
        'https://example.supabase.co/storage/v1/object/public/news-images/news/2026-04-26/article.jpg',
      ),
    ).toBe('news/2026-04-26/article.jpg');
  });

  it('creates a signed URL from a storage path', async () => {
    const createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://example.test/signed-news-image' },
      error: null,
    });

    const supabase = {
      storage: {
        from: jest.fn().mockReturnValue({
          createSignedUrl,
        }),
      },
    } as never;

    await expect(signNewsImageUrl(supabase, 'news/2026-04-26/article.jpg')).resolves.toBe(
      'https://example.test/signed-news-image',
    );
    expect(createSignedUrl).toHaveBeenCalledWith('news/2026-04-26/article.jpg', 3600);
  });
});