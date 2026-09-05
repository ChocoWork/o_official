import { maskEmail } from '@/lib/mask-email';

describe('maskEmail', () => {
  test('ローカル部が 5 文字以上なら先頭 2 + マスク + 末尾 2', () => {
    expect(maskEmail('14masa56@gmail.com')).toBe('14***56@gmail.com');
    expect(maskEmail('abcde@example.com')).toBe('ab***de@example.com');
  });

  test('ローカル部が 4 文字以下なら先頭 1 + マスク', () => {
    expect(maskEmail('abcd@example.com')).toBe('a***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  test('マスク部は常に 3 文字で、ローカル部の長さを漏らさない', () => {
    const short = maskEmail('abcde@example.com');
    const long = maskEmail('abcdefghijklmno@example.com');
    expect(short.split('@')[0]).toHaveLength(7);
    expect(long.split('@')[0]).toHaveLength(7);
  });

  test('サブドメインを含むドメインはそのまま残す', () => {
    expect(maskEmail('user@sub.example.co.jp')).toBe('u***@sub.example.co.jp');
  });

  test('@ を含まない値や空文字は空文字を返す', () => {
    expect(maskEmail('nope')).toBe('');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('a@')).toBe('');
    expect(maskEmail('@example.com')).toBe('');
  });
});
