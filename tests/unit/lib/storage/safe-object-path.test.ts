import { isSafeObjectPath, parseOwnObjectPath } from '@/lib/storage/safe-object-path';

// 最初の利用者は SEARCH の画像の署名（DD-SEARCH-011）。LOOK・NEWS・ITEM の署名もこの関数を通す。

const OWN = 'https://own.supabase.co';
const ITEM = { bucket: 'item-images', prefix: 'items' };
const LOOK = { bucket: 'look-images', prefix: 'looks' };
const NEWS = { bucket: 'news-images', prefix: 'news' };

describe('parseOwnObjectPath と isSafeObjectPath', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = OWN;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  describe('通る物', () => {
    it.each([
      ['本番の商品画像（object/public）を道筋に直す', `${OWN}/storage/v1/object/public/item-images/items/2026-07-01/x.jpg`, ITEM, 'items/2026-07-01/x.jpg'],
      ['object/sign の URL は道筋だけ取り出す（token は捨てる）', `${OWN}/storage/v1/object/sign/item-images/items/x.jpg?token=abc`, ITEM, 'items/x.jpg'],
      ['object/authenticated の URL も取り出す', `${OWN}/storage/v1/object/authenticated/item-images/items/x.jpg`, ITEM, 'items/x.jpg'],
      ['LOOK の公開 URL', `${OWN}/storage/v1/object/public/look-images/looks/2026-01-01/uuid.jpg`, LOOK, 'looks/2026-01-01/uuid.jpg'],
      ['NEWS の本番の URL', `${OWN}/storage/v1/object/public/news-images/news/2026-05-01/a.png`, NEWS, 'news/2026-05-01/a.png'],
      ['NEWS の素の道筋', 'news/e2e/news-1.png', NEWS, 'news/e2e/news-1.png'],
      ['バケット名つきの道筋はバケット名を外す', 'news-images/news/x.png', NEWS, 'news/x.png'],
      ['LOOK の素の道筋', 'looks/e2e-look-sec-002.png', LOOK, 'looks/e2e-look-sec-002.png'],
      ['LOOK の入れ子の素の道筋', 'looks/e2e-sec005-probe/a.png', LOOK, 'looks/e2e-sec005-probe/a.png'],
      ['ITEM の素の道筋', 'items/e2e/item-1-1.png', ITEM, 'items/e2e/item-1-1.png'],
      ['先頭の / は 1 つ外して通す（現行の normalizeObjectPath と同じ向き）', '/items/x.png', ITEM, 'items/x.png'],
      ['前後の空白は落とす', '  items/x.png  ', ITEM, 'items/x.png'],
      ['URL の道筋の符号を戻した後も式に合えば通す', `${OWN}/storage/v1/object/public/item-images/items/a%2Db.png`, ITEM, 'items/a-b.png'],
    ])('DD-SEARCH-011 %s', (_label, raw, options, expected) => {
      expect(parseOwnObjectPath(raw, options)).toBe(expected);
    });

    it('DD-SEARCH-011 NEXT_PUBLIC_SUPABASE_URL が無く SUPABASE_URL だけの時は、その origin の URL を通す', () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      process.env.SUPABASE_URL = 'https://server-only.supabase.co';

      expect(
        parseOwnObjectPath('https://server-only.supabase.co/storage/v1/object/public/item-images/items/x.jpg', ITEM),
      ).toBe('items/x.jpg');
    });

    it('DD-SEARCH-011 手元の Supabase（http と port）の origin も 1 つだけ通す', () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';

      expect(
        parseOwnObjectPath('http://127.0.0.1:54321/storage/v1/object/sign/item-images/items/x.jpg?token=t', ITEM),
      ).toBe('items/x.jpg');
      expect(
        parseOwnObjectPath('http://127.0.0.1:54322/storage/v1/object/sign/item-images/items/x.jpg', ITEM),
      ).toBeNull();
    });
  });

  describe('null になる物', () => {
    it.each([
      ['別 host（evil.example）', 'https://evil.example/storage/v1/object/public/item-images/items/x.jpg'],
      ['別 host（別のプロジェクト）', 'https://other.supabase.co/storage/v1/object/public/item-images/items/x.jpg'],
      ['別 host（example.com）', 'https://example.com/items/x.jpg'],
      ['host の前置きの偽装（own.supabase.co.evil.example）', 'https://own.supabase.co.evil.example/storage/v1/object/public/item-images/items/x.jpg'],
      ['userinfo で偽装', 'https://own.supabase.co@evil.example/storage/v1/object/public/item-images/items/x.jpg'],
      ['プロトコル違い（http）', 'http://own.supabase.co/storage/v1/object/public/item-images/items/x.jpg'],
      ['別バケットの URL', `${OWN}/storage/v1/object/public/look-images/looks/x.jpg`],
      ['object の種類違い（upload）', `${OWN}/storage/v1/object/upload/item-images/items/x.jpg`],
      ['置き場の道の途中に含むだけ（indexOf で拾わない）', `${OWN}/evil/storage/v1/object/public/item-images/items/x.jpg`],
      ['バケットの下が空', `${OWN}/storage/v1/object/public/item-images/`],
      ['URL の中の ..', `${OWN}/storage/v1/object/public/item-images/items/%2e%2e/%2e%2e/secret.jpg`],
      ['URL の中の符号つき ..（二重）', `${OWN}/storage/v1/object/public/item-images/items/%252e%252e/x.jpg`],
      ['URL の壊れた %', `${OWN}/storage/v1/object/public/item-images/items/%E0%A4%A.png`],
      ['URL の中の空白', `${OWN}/storage/v1/object/public/item-images/items/x%20y.png`],
      ['..', 'items/../looks/x.png'],
      ['..（符号）', 'items/%2e%2e/x.png'],
      ['// を含む', 'items//x.png'],
      ['先頭が // ', '//items/x.png'],
      ['接頭辞違い（other）', 'other/x.png'],
      ['接頭辞違い（item）', 'item/x.png'],
      ['接頭辞だけ', 'items'],
      ['接頭辞と / だけ', 'items/'],
      ['空白を含む', 'items/ x.png'],
      ['空白を含む（途中）', 'items/x y.png'],
      ['日本語', 'items/あ.png'],
      ['先頭が . の名前', 'items/.hidden'],
      ['壊れた %', 'items/%E0%A4%A.png'],
      ['大文字の接頭辞', 'Items/x.png'],
      ['他の接頭辞（looks を items として）', 'looks/x.png'],
      ['空', ''],
      ['空白だけ', '   '],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:image/png;base64,AAAA'],
      ['改行を含む', 'items/x.png\nitems/y.png'],
    ])('DD-SEARCH-011 %s は null', (_label, raw) => {
      expect(parseOwnObjectPath(raw, ITEM)).toBeNull();
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['数', 42 as unknown as string],
    ])('DD-SEARCH-011 %s は null', (_label, raw) => {
      expect(parseOwnObjectPath(raw, ITEM)).toBeNull();
    });

    it('DD-SEARCH-011 SUPABASE_URL が NEXT_PUBLIC_SUPABASE_URL と別の origin なら、SUPABASE_URL 側の host は通さない（信頼する origin は 1 つ）', () => {
      process.env.SUPABASE_URL = 'https://server-side.supabase.co';

      expect(
        parseOwnObjectPath('https://server-side.supabase.co/storage/v1/object/public/item-images/items/x.jpg', ITEM),
      ).toBeNull();
      expect(
        parseOwnObjectPath(`${OWN}/storage/v1/object/public/item-images/items/x.jpg`, ITEM),
      ).toBe('items/x.jpg');
    });

    it('DD-SEARCH-011 環境変数が両方無い時は URL の形を全部 null にし、素の道筋だけ通す', () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_URL;

      expect(parseOwnObjectPath(`${OWN}/storage/v1/object/public/item-images/items/x.jpg`, ITEM)).toBeNull();
      expect(parseOwnObjectPath('http://127.0.0.1:54321/storage/v1/object/public/item-images/items/x.jpg', ITEM)).toBeNull();
      expect(parseOwnObjectPath('items/x.png', ITEM)).toBe('items/x.png');
    });

    it('DD-SEARCH-011 環境変数が URL として壊れている時は URL の形を null にする', () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'not a url';

      expect(parseOwnObjectPath(`${OWN}/storage/v1/object/public/item-images/items/x.jpg`, ITEM)).toBeNull();
      expect(parseOwnObjectPath('items/x.png', ITEM)).toBe('items/x.png');
    });

    it('DD-SEARCH-011 接頭辞の正規表現の特殊文字は逃がす（. を任意の 1 文字にしない）', () => {
      const options = { bucket: 'b', prefix: 'a.b' };

      expect(parseOwnObjectPath('a.b/x.png', options)).toBe('a.b/x.png');
      expect(parseOwnObjectPath('axb/x.png', options)).toBeNull();
    });
  });

  describe('isSafeObjectPath', () => {
    it.each([
      ['items/x.png', 'items', true],
      ['items/2026-07-01/a_b-c.jpg', 'items', true],
      ['looks/x.png', 'items', false],
      ['items/../x.png', 'items', false],
      ['items//x.png', 'items', false],
      ['/items/x.png', 'items', false],
      ['items/x.png ', 'items', false],
      ['https://own.supabase.co/storage/v1/object/public/item-images/items/x.png', 'items', false],
      ['', 'items', false],
    ])('DD-SEARCH-011 isSafeObjectPath(%j, %j) は %s', (path, prefix, expected) => {
      expect(isSafeObjectPath(path, prefix)).toBe(expected);
    });
  });
});
