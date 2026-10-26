import { searchQuerySchema } from '@/features/search/lib/query-schema';

describe('searchQuerySchema', () => {
  it('DD-SEARCH-009 通常の語を通す', () => {
    expect(searchQuerySchema().parse('coat')).toBe('coat');
  });

  it('DD-SEARCH-009 前後の空白を取る', () => {
    expect(searchQuerySchema().parse('  coat \t')).toBe('coat');
  });

  it('DD-SEARCH-009 100字は通し、101字は断る', () => {
    expect(searchQuerySchema().safeParse('a'.repeat(100)).success).toBe(true);
    expect(searchQuerySchema().safeParse('a'.repeat(101)).success).toBe(false);
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['US(0x1F)', 'a\u001Fb'],
    ['DEL(0x7F)', 'a\u007Fb'],
    ['途中の改行', 'a\nb'],
  ])('DD-SEARCH-009 制御文字（%s）を含む語は断る', (_label, value) => {
    expect(searchQuerySchema().safeParse(value).success).toBe(false);
  });

  it('DD-SEARCH-009 前後の改行は空白として取るので断らない', () => {
    expect(searchQuerySchema().parse('\ncoat\n')).toBe('coat');
  });

  it.each(['\u3000コート', '🧥 coat', 'ウールのコート', 'a,b).or('])('DD-SEARCH-009 全角空白・絵文字・日本語・記号は通す（%s）', (value) => {
    expect(searchQuerySchema().safeParse(value).success).toBe(true);
  });
});
