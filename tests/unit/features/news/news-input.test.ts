import { isNewsId, resolveNewsCategory } from '@/features/news/lib/news-input';

describe('isNewsId', () => {
  it.each(['1', '9', '10', '123456789012345678'])('DD-NEWS-070 bigint の形の id "%s" は真', (value) => {
    expect(isNewsId(value)).toBe(true);
  });

  it.each([
    ['0', '0'],
    ['先頭の 0', '01'],
    ['英字', 'abc'],
    ['小数', '1.5'],
    ['負', '-1'],
    ['19 桁', '1234567890123456789'],
    ['空', ''],
    ['末尾の空白', '1 '],
    ['先頭の空白', ' 1'],
    ['改行を含む', '1\n'],
    ['SQL の断片', '1;drop'],
  ])('DD-NEWS-070 %s の id は偽', (_label, value) => {
    expect(isNewsId(value)).toBe(false);
  });
});

describe('resolveNewsCategory', () => {
  it.each([
    ['collection', 'COLLECTION'],
    ['Event', 'EVENT'],
    ['ALL', 'ALL'],
    ['blog', 'BLOG'],
  ])('DD-NEWS-070 許可の一覧の分類 "%s" は大文字の "%s" にする', (raw, expected) => {
    expect(resolveNewsCategory(raw)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空の文字', ''],
  ])('DD-NEWS-070 %s は ALL', (_label, raw) => {
    expect(resolveNewsCategory(raw)).toBe('ALL');
  });

  it.each([
    ['300 字', 'X'.repeat(300)],
    ['記号つき', 'EVENT;drop'],
    ['複数', 'EVENT,STORE'],
    ['前の空白', ' EVENT'],
    ['一覧に無い', 'FOO'],
  ])('DD-NEWS-070 外れた値（%s）は ALL', (_label, raw) => {
    expect(resolveNewsCategory(raw)).toBe('ALL');
  });
});
