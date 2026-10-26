/**
 * @jest-environment node
 */
import {
  NEWS_IMAGE_BUCKET,
  buildNewsImagePath,
  isOwnNewsImagePath,
  prepareNewsImage,
  removeNewsImages,
} from '@/features/news/services/admin-images';
import { fileOf, minimalJpeg, minimalPng, textAsImage } from '../../../../fixtures/images';

describe('DD-NEWS-071 管理のニュースの画像の確かめ・保存名・後始末', () => {
  describe('prepareNewsImage', () => {
    it('DD-NEWS-071 本物の PNG を image/png と申告すると検出した種類・拡張子・中身を返し、名前は使わない', async () => {
      const prepared = await prepareNewsImage(fileOf(minimalPng(), 'x.html', 'image/png'));

      expect(prepared).not.toBeNull();
      expect(prepared?.contentType).toBe('image/png');
      expect(prepared?.extension).toBe('png');
      expect(prepared?.buffer.equals(minimalPng())).toBe(true);
    });

    it('DD-NEWS-071 文字のファイルを image/png と申告すると null', async () => {
      await expect(prepareNewsImage(fileOf(textAsImage(), 'a.png', 'image/png'))).resolves.toBeNull();
    });

    it('DD-NEWS-071 PNG を image/jpeg と申告すると null（申告と検出が違う）', async () => {
      await expect(prepareNewsImage(fileOf(minimalPng(), 'a.jpg', 'image/jpeg'))).resolves.toBeNull();
    });

    it('DD-NEWS-071 JPEG を image/jpeg と申告すると拡張子は jpg', async () => {
      const prepared = await prepareNewsImage(fileOf(minimalJpeg(), 'photo', 'image/jpeg'));

      expect(prepared).toMatchObject({ contentType: 'image/jpeg', extension: 'jpg' });
    });
  });

  describe('buildNewsImagePath', () => {
    it('DD-NEWS-071 news/<UTC の日付>/<uuid>.<拡張子> の形で作る', () => {
      const path = buildNewsImagePath('png', new Date('2026-10-26T00:00:00Z'));

      expect(path).toMatch(/^news\/2026-10-26\/[0-9a-f-]{36}\.png$/);
    });

    it('DD-NEWS-071 呼ぶ度に違う名前になる', () => {
      const now = new Date('2026-10-26T00:00:00Z');

      expect(buildNewsImagePath('png', now)).not.toBe(buildNewsImagePath('png', now));
    });
  });

  describe('isOwnNewsImagePath', () => {
    it.each(['news/2026-10-26/0b0c0a68-0000-4000-8000-000000000000.png', 'news/e2e/a.png', 'news/a.png'])(
      'DD-NEWS-071 %s は自分の道筋',
      (path) => {
        expect(isOwnNewsImagePath(path)).toBe(true);
      },
    );

    it.each([
      'news/../x.png',
      '/news/a.png',
      'news//a.png',
      'looks/a.png',
      'other/news/a.png',
      'https://evil.example/news/a.png',
      'e2e/news-1.png',
      'news/a b.png',
      'news/%2e%2e/a.png',
      'news/',
      'news',
      '',
    ])('DD-NEWS-071 %p は自分の道筋ではない', (path) => {
      expect(isOwnNewsImagePath(path)).toBe(false);
    });
  });

  describe('removeNewsImages', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    function createSupabase(remove: jest.Mock) {
      const from = jest.fn().mockReturnValue({ remove });
      return { supabase: { storage: { from } } as never, from };
    }

    it('DD-NEWS-071 自分の道筋だけを remove し、見本・null・keep の物は渡さない', async () => {
      const remove = jest.fn().mockResolvedValue({ error: null });
      const { supabase, from } = createSupabase(remove);

      await expect(
        removeNewsImages(supabase, ['news/e2e/a.png', 'e2e/news-1.png', null], ['news/e2e/b.png']),
      ).resolves.toBe('ok');
      expect(from).toHaveBeenCalledWith(NEWS_IMAGE_BUCKET);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith(['news/e2e/a.png']);
    });

    it('DD-NEWS-071 keep に含まれる道筋は消す対象にしない', async () => {
      const remove = jest.fn().mockResolvedValue({ error: null });
      const { supabase } = createSupabase(remove);

      await removeNewsImages(supabase, ['news/a.png', 'news/b.png'], ['news/b.png']);

      expect(remove).toHaveBeenCalledWith(['news/a.png']);
    });

    it('DD-NEWS-071 同じ道筋が重なっていても 1 回だけ渡す', async () => {
      const remove = jest.fn().mockResolvedValue({ error: null });
      const { supabase } = createSupabase(remove);

      await removeNewsImages(supabase, ['news/a.png', 'news/a.png']);

      expect(remove).toHaveBeenCalledWith(['news/a.png']);
    });

    it('DD-NEWS-071 古い公開 URL の形は置き場の道筋に直して消す', async () => {
      const remove = jest.fn().mockResolvedValue({ error: null });
      const { supabase } = createSupabase(remove);
      const legacy = `https://project.supabase.co/storage/v1/object/public/${NEWS_IMAGE_BUCKET}/news/z.png`;

      await removeNewsImages(supabase, [legacy]);

      expect(remove).toHaveBeenCalledWith(['news/z.png']);
    });

    it('DD-NEWS-071 別の置き場の URL・外の URL・.. を含む道筋は消す対象にしない', async () => {
      const remove = jest.fn();
      const { supabase, from } = createSupabase(remove);

      await expect(
        removeNewsImages(supabase, [
          'https://project.supabase.co/storage/v1/object/public/look-images/looks/z.png',
          'https://evil.example/news/a.png',
          'news/../secret.png',
        ]),
      ).resolves.toBe('ok');
      expect(from).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('DD-NEWS-071 消す物が無い（空・null だけ）なら置き場を呼ばず ok', async () => {
      const remove = jest.fn();
      const { supabase, from } = createSupabase(remove);

      await expect(removeNewsImages(supabase, [])).resolves.toBe('ok');
      await expect(removeNewsImages(supabase, [null, undefined, ''])).resolves.toBe('ok');
      expect(from).not.toHaveBeenCalled();
    });

    it('DD-NEWS-071 置き場が error を返したら failed で投げず、名前と符号だけを記録する', async () => {
      const remove = jest.fn().mockResolvedValue({
        error: Object.assign(new Error('bucket secret'), { name: 'StorageApiError', code: '404' }),
      });
      const { supabase } = createSupabase(remove);

      await expect(removeNewsImages(supabase, ['news/a.png'])).resolves.toBe('failed');
      expect(errorSpy).toHaveBeenCalledWith('Failed to remove news images:', { name: 'StorageApiError', code: '404' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
    });

    it('DD-NEWS-071 置き場が例外を投げても failed で投げず、名前と符号だけを記録する', async () => {
      const remove = jest.fn().mockRejectedValue(new TypeError('network secret'));
      const { supabase } = createSupabase(remove);

      await expect(removeNewsImages(supabase, ['news/a.png'])).resolves.toBe('failed');
      expect(errorSpy).toHaveBeenCalledWith('Failed to remove news images:', { name: 'TypeError', code: null });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
    });
  });
});
