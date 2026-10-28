import {
  DEFAULT_ITEM_IMAGE_SIGNED_URL_EXPIRY_SECONDS,
  signItemImageFields,
  signItemImageUrl,
  signItemImageUrls,
} from '@/lib/storage/item-images';

// 最初の利用者は SEARCH の画像の署名（DD-SEARCH-011）。ITEM の署名は道筋を確かめ、失敗は null にする。

const OWN = 'https://own.supabase.co';

type SignResult = { data: { signedUrl?: string } | null; error: unknown };

function makeSupabase(impl?: (path: string, expiresIn: number) => Promise<SignResult>) {
  const createSignedUrl = jest.fn(
    impl ??
      ((path: string) =>
        Promise.resolve({ data: { signedUrl: `https://signed.test/${path}` }, error: null } as SignResult)),
  );
  const from = jest.fn().mockReturnValue({ createSignedUrl });
  const supabase = { storage: { from } } as never;
  return { supabase, from, createSignedUrl };
}

describe('ITEM の画像の署名の部品', () => {
  const envBackup = { ...process.env };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = OWN;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...envBackup };
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  describe('signItemImageUrl', () => {
    it('DD-SEARCH-011 既定の期限は 3600 秒（7 日でない）', async () => {
      const { supabase, createSignedUrl } = makeSupabase();

      await signItemImageUrl(supabase, 'items/default-expiry.png');

      expect(DEFAULT_ITEM_IMAGE_SIGNED_URL_EXPIRY_SECONDS).toBe(3600);
      expect(createSignedUrl).toHaveBeenCalledWith('items/default-expiry.png', 3600);
    });

    it('DD-SEARCH-011 呼び手が期限を明示すればその値で署名する', async () => {
      const { supabase, createSignedUrl } = makeSupabase();

      await signItemImageUrl(supabase, 'items/explicit-expiry.png', 120);

      expect(createSignedUrl).toHaveBeenCalledWith('items/explicit-expiry.png', 120);
    });

    it('DD-SEARCH-011 自分のプロジェクトの object/public の URL（本番の商品画像）は道筋に直して署名する', async () => {
      const { supabase, from, createSignedUrl } = makeSupabase();

      const result = await signItemImageUrl(
        supabase,
        `${OWN}/storage/v1/object/public/item-images/items/2026-07-01/public-form.jpg`,
      );

      expect(from).toHaveBeenCalledWith('item-images');
      expect(createSignedUrl).toHaveBeenCalledWith('items/2026-07-01/public-form.jpg', 3600);
      expect(result).toBe('https://signed.test/items/2026-07-01/public-form.jpg');
    });

    it.each([
      ['別の host の URL', 'https://evil.example/storage/v1/object/public/item-images/items/x.jpg'],
      ['別のプロジェクトの URL', 'https://other.supabase.co/storage/v1/object/public/item-images/items/x.jpg'],
      ['別のバケットの URL', `${OWN}/storage/v1/object/public/look-images/looks/x.jpg`],
      ['.. を含む道筋', 'items/../looks/x.png'],
      ['置き場の決まった場所の外', 'other/x.png'],
      ['空白だけ', '   '],
      ['空の文字', ''],
      ['null', null],
      ['undefined', undefined],
    ])('DD-SEARCH-011 %s は元の値を返さず null で、署名を呼ばない', async (_label, raw) => {
      const { supabase, createSignedUrl } = makeSupabase();

      const result = await signItemImageUrl(supabase, raw);

      expect(result).toBeNull();
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it.each([
      ['error が返る', { data: null, error: { message: 'secret storage failure for items/fail-error.png' } }],
      ['data が空', { data: null, error: null }],
      ['signedUrl が空', { data: {}, error: null }],
    ])('DD-SEARCH-011 署名に失敗（%s）したら元の値でなく null を返す', async (_label, outcome) => {
      const { supabase } = makeSupabase(() => Promise.resolve(outcome as SignResult));

      const result = await signItemImageUrl(supabase, 'items/fail-sign.png');

      expect(result).toBeNull();
    });

    it('DD-SEARCH-011 署名が例外を投げても null を返す', async () => {
      const { supabase } = makeSupabase(() => Promise.reject(new Error('network down for items/fail-throw.png')));

      await expect(signItemImageUrl(supabase, 'items/fail-throw.png')).resolves.toBeNull();
    });

    it('DD-SEARCH-011 失敗の記録は固定の語だけで、道筋・URL・誤りの文を含まない', async () => {
      const { supabase } = makeSupabase((path) =>
        path === 'items/log-fail.png'
          ? Promise.resolve({ data: null, error: { message: 'bucket secret detail' } })
          : Promise.resolve({ data: { signedUrl: 'https://signed.test/x' }, error: null }),
      );

      await signItemImageUrl(supabase, 'items/log-fail.png');
      await signItemImageUrl(supabase, `https://evil.example/storage/v1/object/public/item-images/items/log-invalid.png`);

      const logged = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('sign_failed');
      expect(logged).toContain('invalid_path');
      expect(logged).not.toContain('log-fail');
      expect(logged).not.toContain('log-invalid');
      expect(logged).not.toContain('evil.example');
      expect(logged).not.toContain('bucket secret detail');
    });
  });

  describe('signItemImageUrls', () => {
    it('DD-SEARCH-011 無効が混ざっても入力と同じ長さ・同じ位置で返し、無効の位置は null', async () => {
      const { supabase } = makeSupabase();

      const result = await signItemImageUrls(supabase, [
        'items/pos-a.png',
        'https://evil.example/storage/v1/object/public/item-images/items/pos-b.png',
        null,
        'items/pos-c.png',
        'other/pos-d.png',
      ]);

      expect(result).toEqual([
        'https://signed.test/items/pos-a.png',
        null,
        null,
        'https://signed.test/items/pos-c.png',
        null,
      ]);
    });

    it('DD-SEARCH-011 署名に失敗した要素だけ null にし、他の要素は署名つきのまま返す', async () => {
      const { supabase } = makeSupabase((path) =>
        path === 'items/pos-fail.png'
          ? Promise.resolve({ data: null, error: { message: 'x' } })
          : Promise.resolve({ data: { signedUrl: `https://signed.test/${path}` }, error: null }),
      );

      const result = await signItemImageUrls(supabase, ['items/pos-ok.png', 'items/pos-fail.png']);

      expect(result).toEqual(['https://signed.test/items/pos-ok.png', null]);
    });

    it('DD-SEARCH-011 空の配列は署名を呼ばず空で返す', async () => {
      const { supabase, createSignedUrl } = makeSupabase();

      await expect(signItemImageUrls(supabase, [])).resolves.toEqual([]);
      expect(createSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('signItemImageFields', () => {
    it('DD-SEARCH-011 image_url が外の URL なら null にし、image_urls は位置を保ったまま署名する（先頭の画像が繰り上がらない）', async () => {
      const { supabase } = makeSupabase();

      const result = await signItemImageFields(supabase, {
        id: 1,
        image_url: 'https://evil.example/x.png',
        image_urls: ['items/fields-a.png', 'items/fields-b.png'],
      });

      expect(result.image_url).toBeNull();
      expect(result.image_urls).toEqual([
        'https://signed.test/items/fields-a.png',
        'https://signed.test/items/fields-b.png',
      ]);
      expect(result.id).toBe(1);
    });

    it('DD-SEARCH-011 image_urls の無効な要素は取り除き、image_url は先頭の要素のまま', async () => {
      const { supabase } = makeSupabase();

      const result = await signItemImageFields(supabase, {
        image_url: 'items/fields-main.png',
        image_urls: ['other/bad.png', 'items/fields-ok.png'],
      });

      expect(result.image_url).toBe('https://signed.test/items/fields-main.png');
      expect(result.image_urls).toEqual(['https://signed.test/items/fields-ok.png']);
    });

    it('DD-SEARCH-011 image_url も image_urls も無い行は null と空配列にする', async () => {
      const { supabase, createSignedUrl } = makeSupabase();

      const result = await signItemImageFields(supabase, { image_url: null, image_urls: null });

      expect(result).toEqual({ image_url: null, image_urls: [] });
      expect(createSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('署名の使い回し', () => {
    it('DD-SEARCH-011 同じ道筋・同じ期限は、残りが期限の半分以上ある間は 2 回目に署名を呼ばない', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
      const { supabase, createSignedUrl } = makeSupabase();

      await signItemImageUrl(supabase, 'items/cache-window.png');
      jest.advanceTimersByTime(1799 * 1000);
      await signItemImageUrl(supabase, 'items/cache-window.png');

      expect(createSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('DD-SEARCH-011 署名の 1801 秒後は新しく署名する（頁に載る URL の残りが 1800 秒を切らない）', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
      const { supabase, createSignedUrl } = makeSupabase();

      await signItemImageUrl(supabase, 'items/cache-expired.png');
      jest.advanceTimersByTime(1801 * 1000);
      await signItemImageUrl(supabase, 'items/cache-expired.png');

      expect(createSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('DD-SEARCH-011 3540 秒後に取り出しても、残りが約 60 秒の使い古しの URL を返さない', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
      let counter = 0;
      const { supabase, createSignedUrl } = makeSupabase(() => {
        counter += 1;
        return Promise.resolve({ data: { signedUrl: `https://signed.test/v${counter}` }, error: null });
      });

      const first = await signItemImageUrl(supabase, 'items/cache-stale.png');
      jest.advanceTimersByTime(3540 * 1000);
      const second = await signItemImageUrl(supabase, 'items/cache-stale.png');

      expect(first).toBe('https://signed.test/v1');
      expect(second).toBe('https://signed.test/v2');
      expect(createSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('DD-SEARCH-011 期限の違う呼び手の URL は取り違えない（キーは道筋と期限）', async () => {
      const { supabase, createSignedUrl } = makeSupabase();

      await signItemImageUrl(supabase, 'items/cache-key.png', 3600);
      await signItemImageUrl(supabase, 'items/cache-key.png', 600);

      expect(createSignedUrl).toHaveBeenCalledTimes(2);
      expect(createSignedUrl).toHaveBeenNthCalledWith(1, 'items/cache-key.png', 3600);
      expect(createSignedUrl).toHaveBeenNthCalledWith(2, 'items/cache-key.png', 600);
    });
  });
});
