import {
  DEFAULT_LOOK_IMAGE_SIGNED_URL_EXPIRY_SECONDS,
  extractLookImageObjectPath,
  signLookImageUrl,
  signLookImageUrls,
} from '@/lib/storage/look-images';

type SignResult = { data: { signedUrl?: string } | null; error: unknown };

function makeSupabase(impl: (path: string, expiresIn: number) => Promise<SignResult>) {
  const createSignedUrl = jest.fn(impl);
  const from = jest.fn().mockReturnValue({ createSignedUrl });
  const supabase = { storage: { from } } as never;
  return { supabase, from, createSignedUrl };
}

function signedOk() {
  return makeSupabase((path) =>
    Promise.resolve({ data: { signedUrl: `https://example.test/signed/${path}` }, error: null }),
  );
}

const BASE = 'https://example.supabase.co/storage/v1/object';

describe('LOOK の画像の署名の部品', () => {
  describe('extractLookImageObjectPath', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['数', 42 as unknown as string],
      ['空の文字', ''],
      ['空白だけ', '  '],
    ])('DD-LOOK-006 %s からは null を返す', (_label, input) => {
      expect(extractLookImageObjectPath(input)).toBeNull();
    });

    it('DD-LOOK-006 素の道筋は先頭の / を除いて返す', () => {
      expect(extractLookImageObjectPath('/looks/a.png')).toBe('looks/a.png');
      expect(extractLookImageObjectPath('//looks/a.png')).toBe('looks/a.png');
      expect(extractLookImageObjectPath('looks/2024-01-01/uuid.jpg')).toBe('looks/2024-01-01/uuid.jpg');
    });

    it('DD-LOOK-006 前後の空白を除いてから道筋を読む', () => {
      expect(extractLookImageObjectPath('  looks/a.png  ')).toBe('looks/a.png');
    });

    it('DD-LOOK-006 古い公開 URL の道筋は字の符号を戻して取り出す', () => {
      expect(extractLookImageObjectPath(`${BASE}/public/look-images/looks/a%20b.png`)).toBe('looks/a b.png');
    });

    it('DD-LOOK-006 sign・authenticated の URL と http の URL からも道筋を取り出す', () => {
      expect(extractLookImageObjectPath(`${BASE}/sign/look-images/looks/a.png?token=abc`)).toBe('looks/a.png');
      expect(extractLookImageObjectPath(`${BASE}/authenticated/look-images/looks/a.png`)).toBe('looks/a.png');
      expect(
        extractLookImageObjectPath('http://localhost:54321/storage/v1/object/public/look-images/looks/a.png'),
      ).toBe('looks/a.png');
    });

    it('DD-LOOK-006 置き場の印の後ろに何も無ければ null を返す', () => {
      expect(extractLookImageObjectPath(`${BASE}/public/look-images/`)).toBeNull();
    });

    it('DD-LOOK-006 look-images の印が無い URL は null を返す', () => {
      expect(extractLookImageObjectPath('https://x/other.png')).toBeNull();
      expect(extractLookImageObjectPath(`${BASE}/public/news-images/news/a.png`)).toBeNull();
    });

    it('DD-LOOK-006 読めない URL は null を返す', () => {
      expect(extractLookImageObjectPath('http://')).toBeNull();
    });

    it('DD-LOOK-006 道筋の字の符号を戻せない時は null を返す', () => {
      expect(extractLookImageObjectPath(`${BASE}/public/look-images/looks/%E0%A4%A.png`)).toBeNull();
    });
  });

  describe('signLookImageUrl', () => {
    it('DD-LOOK-006 期限の既定は 3600 秒', () => {
      expect(DEFAULT_LOOK_IMAGE_SIGNED_URL_EXPIRY_SECONDS).toBe(3600);
    });

    it('DD-LOOK-006 取り出した道筋を look-images の置き場から既定の期限で署名する', async () => {
      const { supabase, from, createSignedUrl } = signedOk();

      await expect(signLookImageUrl(supabase, 'looks/a.png')).resolves.toBe('https://example.test/signed/looks/a.png');
      expect(from).toHaveBeenCalledWith('look-images');
      expect(createSignedUrl).toHaveBeenCalledWith('looks/a.png', 3600);
    });

    it('DD-LOOK-006 古い公開 URL は取り出した道筋で署名し、署名つき URL を返す', async () => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signLookImageUrl(supabase, `${BASE}/public/look-images/looks/a%20b.png`)).resolves.toBe(
        'https://example.test/signed/looks/a b.png',
      );
      expect(createSignedUrl).toHaveBeenCalledWith('looks/a b.png', 3600);
    });

    it('DD-LOOK-006 渡された期限で署名し、署名つき URL を返す', async () => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signLookImageUrl(supabase, 'looks/a.png', 60)).resolves.toBe(
        'https://example.test/signed/looks/a.png',
      );
      expect(createSignedUrl).toHaveBeenCalledWith('looks/a.png', 60);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['空の文字', ''],
    ])('DD-LOOK-006 %s は署名せずに null を返す', async (_label, input) => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signLookImageUrl(supabase, input)).resolves.toBeNull();
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it('DD-LOOK-006 道筋を取り出せない時は元の値をそのまま返す', async () => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signLookImageUrl(supabase, 'https://x/other.png')).resolves.toBe('https://x/other.png');
      await expect(signLookImageUrl(supabase, '   ')).resolves.toBe('   ');
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it('DD-LOOK-006 署名に失敗した時は元の値をそのまま返す', async () => {
      const { supabase } = makeSupabase(() => Promise.resolve({ data: null, error: new Error('boom') }));

      await expect(signLookImageUrl(supabase, 'looks/a.png')).resolves.toBe('looks/a.png');
    });

    it('DD-LOOK-006 署名つき URL が空で返った時は元の値をそのまま返す', async () => {
      const { supabase } = makeSupabase(() => Promise.resolve({ data: {}, error: null }));
      await expect(signLookImageUrl(supabase, 'looks/a.png')).resolves.toBe('looks/a.png');

      const { supabase: nullData } = makeSupabase(() => Promise.resolve({ data: null, error: null }));
      await expect(signLookImageUrl(nullData, 'looks/a.png')).resolves.toBe('looks/a.png');
    });
  });

  describe('signLookImageUrls', () => {
    it('DD-LOOK-006 全部の値を署名し、null と空の文字は結果から除く', async () => {
      const { supabase, createSignedUrl } = signedOk();

      const result = await signLookImageUrls(supabase, ['looks/a.png', null, '', undefined]);

      expect(result).toEqual(['https://example.test/signed/looks/a.png']);
      expect(createSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('DD-LOOK-006 入力の並びを保つ', async () => {
      const { supabase } = signedOk();

      const result = await signLookImageUrls(supabase, ['looks/a.png', 'looks/b.png']);

      expect(result).toEqual(['https://example.test/signed/looks/a.png', 'https://example.test/signed/looks/b.png']);
    });

    it('DD-LOOK-006 期限を渡さなければ既定の期限で署名する', async () => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signLookImageUrls(supabase, ['looks/a.png'])).resolves.toEqual([
        'https://example.test/signed/looks/a.png',
      ]);
      expect(createSignedUrl).toHaveBeenCalledWith('looks/a.png', 3600);
    });

    it('DD-LOOK-006 渡された期限で署名する', async () => {
      const { supabase, createSignedUrl } = signedOk();

      await expect(signLookImageUrls(supabase, ['looks/a.png', 'looks/b.png'], 120)).resolves.toEqual([
        'https://example.test/signed/looks/a.png',
        'https://example.test/signed/looks/b.png',
      ]);
      expect(createSignedUrl).toHaveBeenNthCalledWith(1, 'looks/a.png', 120);
      expect(createSignedUrl).toHaveBeenNthCalledWith(2, 'looks/b.png', 120);
    });

    it('DD-LOOK-006 入力が空なら空の配列を返す', async () => {
      const { supabase } = signedOk();

      await expect(signLookImageUrls(supabase, [])).resolves.toEqual([]);
    });

    it('DD-LOOK-006 署名に失敗した値は元の値のまま結果に残す', async () => {
      const { supabase } = makeSupabase(() => Promise.resolve({ data: null, error: new Error('x') }));

      await expect(signLookImageUrls(supabase, ['looks/a.png'])).resolves.toEqual(['looks/a.png']);
    });
  });
});
