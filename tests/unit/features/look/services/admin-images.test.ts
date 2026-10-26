/**
 * @jest-environment node
 */
import {
  LOOK_IMAGE_BUCKET,
  buildLookImagePath,
  isOwnLookImagePath,
  listRemovableLookImagePaths,
  prepareLookImage,
  removeLookImages,
} from '@/features/look/services/admin-images';
import { fileOf, minimalJpeg, minimalPng, textAsImage } from '../../../../fixtures/images';

describe('DD-LOOK-070 管理の LOOK の画像の確かめ・保存名・後始末', () => {
  describe('prepareLookImage', () => {
    it('DD-LOOK-070 本物の PNG を image/png と申告すると検出した種類・拡張子・中身を返し、名前は使わない', async () => {
      const prepared = await prepareLookImage(fileOf(minimalPng(), 'a/b.html', 'image/png'));

      expect(prepared).not.toBeNull();
      expect(prepared?.contentType).toBe('image/png');
      expect(prepared?.extension).toBe('png');
      expect(prepared?.buffer.equals(minimalPng())).toBe(true);
    });

    it('DD-LOOK-070 文字のファイルを image/png と申告すると null', async () => {
      await expect(prepareLookImage(fileOf(textAsImage(), 'a.png', 'image/png'))).resolves.toBeNull();
    });

    it('DD-LOOK-070 PNG を image/jpeg と申告すると null（申告と検出が違う）', async () => {
      await expect(prepareLookImage(fileOf(minimalPng(), 'a.jpg', 'image/jpeg'))).resolves.toBeNull();
    });

    it('DD-LOOK-070 JPEG を image/jpeg と申告すると拡張子は jpg', async () => {
      const prepared = await prepareLookImage(fileOf(minimalJpeg(), 'photo', 'image/jpeg'));

      expect(prepared).toMatchObject({ contentType: 'image/jpeg', extension: 'jpg' });
    });
  });

  describe('buildLookImagePath', () => {
    it('DD-LOOK-070 looks/<UTC の日付>/<uuid>.<拡張子> の形で作る', () => {
      const path = buildLookImagePath('png', new Date('2026-10-26T00:00:00Z'));

      expect(path).toMatch(/^looks\/2026-10-26\/[0-9a-f-]{36}\.png$/);
    });

    it('DD-LOOK-070 呼ぶ度に違う名前になる', () => {
      const now = new Date('2026-10-26T00:00:00Z');

      expect(buildLookImagePath('png', now)).not.toBe(buildLookImagePath('png', now));
    });
  });

  describe('isOwnLookImagePath', () => {
    it.each(['looks/2026-10-26/0b0c0a68-0000-4000-8000-000000000000.png', 'looks/e2e/a.png', 'looks/a.png'])(
      'DD-LOOK-070 %s は自分の道筋',
      (path) => {
        expect(isOwnLookImagePath(path)).toBe(true);
      },
    );

    it.each([
      'looks/../x.png',
      '/looks/a.png',
      'looks//a.png',
      'news/a.png',
      'other/looks/a.png',
      'https://evil.example/looks/a.png',
      'e2e/look-1-1.png',
      'looks/a b.png',
      'looks/%2e%2e/a.png',
      'looks/',
      'looks',
      '',
    ])('DD-LOOK-070 %p は自分の道筋ではない', (path) => {
      expect(isOwnLookImagePath(path)).toBe(false);
    });
  });

  describe('listRemovableLookImagePaths', () => {
    it('DD-LOOK-070 自分の道筋だけを重複なしで返し、keep に含まれる物と見本・外の URL・文字でない値は除く', () => {
      const result = listRemovableLookImagePaths(
        ['looks/a.png', 'looks/a.png', 'e2e/look-1-1.png', 'https://x.example/y.png', null, 5],
        ['looks/b.png'],
      );

      expect(result).toEqual(['looks/a.png']);
    });

    it('DD-LOOK-070 keep に含まれる道筋は消す対象にしない', () => {
      expect(listRemovableLookImagePaths(['looks/a.png', 'looks/b.png'], ['looks/b.png'])).toEqual(['looks/a.png']);
    });

    it('DD-LOOK-070 古い公開 URL の形は置き場の道筋に直して返す', () => {
      const legacy = `https://project.supabase.co/storage/v1/object/public/${LOOK_IMAGE_BUCKET}/looks/z.png`;

      expect(listRemovableLookImagePaths([legacy])).toEqual(['looks/z.png']);
    });

    it('DD-LOOK-070 別の置き場の URL は消す対象にしない', () => {
      const other = 'https://project.supabase.co/storage/v1/object/public/news-images/news/z.png';

      expect(listRemovableLookImagePaths([other])).toEqual([]);
    });

    it('DD-LOOK-070 配列でない値は空', () => {
      expect(listRemovableLookImagePaths(null)).toEqual([]);
      expect(listRemovableLookImagePaths('looks/a.png')).toEqual([]);
    });
  });

  describe('removeLookImages', () => {
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

    it('DD-LOOK-070 空の配列は置き場を呼ばず ok', async () => {
      const remove = jest.fn();
      const { supabase, from } = createSupabase(remove);

      await expect(removeLookImages(supabase, [])).resolves.toBe('ok');
      expect(from).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('DD-LOOK-070 look-images の置き場から渡した道筋を消して ok', async () => {
      const remove = jest.fn().mockResolvedValue({ error: null });
      const { supabase, from } = createSupabase(remove);

      await expect(removeLookImages(supabase, ['looks/a.png', 'looks/b.png'])).resolves.toBe('ok');
      expect(from).toHaveBeenCalledWith('look-images');
      expect(remove).toHaveBeenCalledWith(['looks/a.png', 'looks/b.png']);
    });

    it('DD-LOOK-070 置き場が error を返したら failed で投げず、名前と符号だけを記録する', async () => {
      const remove = jest.fn().mockResolvedValue({
        error: Object.assign(new Error('bucket secret'), { name: 'StorageApiError', code: '404' }),
      });
      const { supabase } = createSupabase(remove);

      await expect(removeLookImages(supabase, ['looks/a.png'])).resolves.toBe('failed');
      expect(errorSpy).toHaveBeenCalledWith('Failed to remove look images:', { name: 'StorageApiError', code: '404' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
    });

    it('DD-LOOK-070 置き場が例外を投げても failed で投げず、名前と符号だけを記録する', async () => {
      const remove = jest.fn().mockRejectedValue(new TypeError('network secret'));
      const { supabase } = createSupabase(remove);

      await expect(removeLookImages(supabase, ['looks/a.png'])).resolves.toBe('failed');
      expect(errorSpy).toHaveBeenCalledWith('Failed to remove look images:', { name: 'TypeError', code: null });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
    });
  });
});
