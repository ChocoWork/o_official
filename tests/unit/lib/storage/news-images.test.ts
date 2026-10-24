import {
  extractNewsImageObjectPath,
  signNewsImageFields,
  signNewsImageUrl,
} from '@/lib/storage/news-images';

type SignResult = { data: { signedUrl?: string } | null; error: unknown };

function makeSupabase(impl: () => Promise<SignResult>) {
  const createSignedUrl = jest.fn(impl);
  const from = jest.fn().mockReturnValue({ createSignedUrl });
  const supabase = { storage: { from } } as never;
  return { supabase, from, createSignedUrl };
}

function signedOk(url = 'https://example.test/signed-news-image') {
  return makeSupabase(() => Promise.resolve({ data: { signedUrl: url }, error: null }));
}

describe('news-images storage helpers', () => {
  describe('extractNewsImageObjectPath', () => {
    it('DD-NEWS-067 extracts object path from a plain storage path', () => {
      expect(extractNewsImageObjectPath('news/2026-04-26/article.jpg')).toBe('news/2026-04-26/article.jpg');
    });

    it('DD-NEWS-067 extracts object path from legacy public URLs', () => {
      expect(
        extractNewsImageObjectPath(
          'https://example.supabase.co/storage/v1/object/public/news-images/news/2026-04-26/article.jpg',
        ),
      ).toBe('news/2026-04-26/article.jpg');
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 42 as unknown as string],
      ['an empty string', ''],
      ['whitespace only', '   \t\n'],
    ])('DD-NEWS-067 returns null for %s', (_label, input) => {
      expect(extractNewsImageObjectPath(input)).toBeNull();
    });

    it('DD-NEWS-067 strips the bucket prefix and leading slashes from plain paths', () => {
      expect(extractNewsImageObjectPath('/news-images/news/a.jpg')).toBe('news/a.jpg');
      expect(extractNewsImageObjectPath('news-images/news/a.jpg')).toBe('news/a.jpg');
      expect(extractNewsImageObjectPath('//news/a.jpg')).toBe('news/a.jpg');
    });

    it('DD-NEWS-067 trims surrounding whitespace before normalizing', () => {
      expect(extractNewsImageObjectPath('  news/a.jpg  ')).toBe('news/a.jpg');
    });

    it('DD-NEWS-067 extracts path from public, sign (with token) and authenticated URLs', () => {
      const base = 'https://example.supabase.co/storage/v1/object';
      expect(extractNewsImageObjectPath(`${base}/public/news-images/news/a.jpg`)).toBe('news/a.jpg');
      expect(extractNewsImageObjectPath(`${base}/sign/news-images/news/a.jpg?token=abc.def`)).toBe('news/a.jpg');
      expect(extractNewsImageObjectPath(`${base}/authenticated/news-images/news/a.jpg`)).toBe('news/a.jpg');
      expect(extractNewsImageObjectPath(`http://localhost:54321/storage/v1/object/public/news-images/news/a.jpg`)).toBe(
        'news/a.jpg',
      );
    });

    it('DD-NEWS-067 decodes percent-encoded characters in the path', () => {
      expect(
        extractNewsImageObjectPath('https://example.supabase.co/storage/v1/object/public/news-images/news/my%20photo.jpg'),
      ).toBe('news/my photo.jpg');
    });

    it('DD-NEWS-067 normalizes a decoded path that repeats the bucket prefix', () => {
      expect(
        extractNewsImageObjectPath(
          'https://example.supabase.co/storage/v1/object/public/news-images/news-images/news/a.jpg',
        ),
      ).toBe('news/a.jpg');
    });

    it('DD-NEWS-067 returns null when nothing follows the marker', () => {
      expect(
        extractNewsImageObjectPath('https://example.supabase.co/storage/v1/object/public/news-images/'),
      ).toBeNull();
    });

    it('DD-NEWS-067 returns null for an unparsable URL', () => {
      expect(extractNewsImageObjectPath('http://')).toBeNull();
    });

    it('DD-NEWS-067 returns null when the path cannot be decoded', () => {
      expect(
        extractNewsImageObjectPath('https://example.supabase.co/storage/v1/object/public/news-images/news/%E0%A4%A.jpg'),
      ).toBeNull();
    });

    it('DD-NEWS-067 returns null for an external URL without any storage marker', () => {
      expect(extractNewsImageObjectPath('https://cdn.example.com/images/news/a.jpg')).toBeNull();
      expect(
        extractNewsImageObjectPath('https://example.supabase.co/storage/v1/object/public/other-bucket/news/a.jpg'),
      ).toBeNull();
    });
  });

  describe('signNewsImageUrl', () => {
    it('DD-NEWS-068 creates a signed URL from a storage path', async () => {
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

    it('DD-NEWS-068 signs in the news-images bucket with a 3600 second default expiry', async () => {
      const { supabase, from, createSignedUrl } = signedOk();

      await signNewsImageUrl(
        supabase,
        'https://example.supabase.co/storage/v1/object/public/news-images/news/a.jpg',
      );

      expect(from).toHaveBeenCalledWith('news-images');
      expect(createSignedUrl).toHaveBeenCalledTimes(1);
      expect(createSignedUrl).toHaveBeenCalledWith('news/a.jpg', 3600);
    });

    it('DD-NEWS-068 uses the given expiresIn when provided', async () => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signNewsImageUrl(supabase, 'news/a.jpg', 120)).resolves.toBe(
        'https://example.test/signed-news-image',
      );
      expect(createSignedUrl).toHaveBeenCalledWith('news/a.jpg', 120);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
    ])('DD-NEWS-068 returns null for %s without signing', async (_label, input) => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signNewsImageUrl(supabase, input)).resolves.toBeNull();
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it('DD-NEWS-068 returns the original value for an external URL without signing', async () => {
      const { supabase, createSignedUrl } = signedOk();
      const external = 'https://cdn.example.com/images/news/a.jpg';

      await expect(signNewsImageUrl(supabase, external)).resolves.toBe(external);
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it('DD-NEWS-068 returns the original value when signing reports an error', async () => {
      const { supabase, createSignedUrl } = makeSupabase(() =>
        Promise.resolve({ data: { signedUrl: 'https://example.test/ignored' }, error: { message: 'boom' } }),
      );

      await expect(signNewsImageUrl(supabase, 'news/a.jpg')).resolves.toBe('news/a.jpg');
      expect(createSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('DD-NEWS-068 returns the original value when data has no signedUrl', async () => {
      const noUrl = makeSupabase(() => Promise.resolve({ data: {}, error: null }));
      await expect(signNewsImageUrl(noUrl.supabase, 'news/a.jpg')).resolves.toBe('news/a.jpg');

      const noData = makeSupabase(() => Promise.resolve({ data: null, error: null }));
      await expect(signNewsImageUrl(noData.supabase, 'news/b.jpg')).resolves.toBe('news/b.jpg');
    });

    it('DD-NEWS-068 propagates an exception thrown by createSignedUrl', async () => {
      const { supabase } = makeSupabase(() => Promise.reject(new Error('storage down')));

      await expect(signNewsImageUrl(supabase, 'news/a.jpg')).rejects.toThrow('storage down');
    });
  });

  describe('signNewsImageFields', () => {
    it('DD-NEWS-068 replaces only image_url and keeps the other columns', async () => {
      const { supabase, createSignedUrl } = signedOk('https://example.test/signed-row');
      const row = { id: 'n1', title: 'Title', status: 'published', image_url: 'news/a.jpg' };

      const result = await signNewsImageFields(supabase, row);

      expect(result).toEqual({ id: 'n1', title: 'Title', status: 'published', image_url: 'https://example.test/signed-row' });
      expect(result).not.toBe(row);
      expect(row.image_url).toBe('news/a.jpg');
      expect(createSignedUrl).toHaveBeenCalledWith('news/a.jpg', 3600);
    });

    it('DD-NEWS-068 sets image_url to null for a row without image_url and does not sign', async () => {
      const { supabase, createSignedUrl } = signedOk();
      const row: { id: string; image_url?: string | null } = { id: 'n2' };

      await expect(signNewsImageFields(supabase, row)).resolves.toEqual({ id: 'n2', image_url: null });
      await expect(signNewsImageFields(supabase, { id: 'n3', image_url: null })).resolves.toEqual({
        id: 'n3',
        image_url: null,
      });
      expect(createSignedUrl).not.toHaveBeenCalled();
    });
  });
});
