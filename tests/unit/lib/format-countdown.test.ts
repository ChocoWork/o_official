import { formatResendCountdown } from '@/lib/format-countdown';

describe('formatResendCountdown', () => {
  test.each([
    [60, '1分 00秒後に再送可能'],
    [59, '0分 59秒後に再送可能'],
    [3600, '60分 00秒後に再送可能'],
  ])('DD-AUTH-013 %i 秒は「%s」になる', (seconds, expected) => {
    expect(formatResendCountdown(seconds)).toBe(expected);
  });

  test('DD-AUTH-013 0 秒は「0分 00秒後に再送可能」になる', () => {
    expect(formatResendCountdown(0)).toBe('0分 00秒後に再送可能');
  });

  test('DD-AUTH-013 秒が 1 桁なら 0 を前に足して 2 桁にそろえる', () => {
    expect(formatResendCountdown(65)).toBe('1分 05秒後に再送可能');
  });

  test('DD-AUTH-013 秒が 2 桁ならそのまま出す', () => {
    expect(formatResendCountdown(119)).toBe('1分 59秒後に再送可能');
  });
});
