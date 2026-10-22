/** @jest-environment node */
import { isOrderStatusToken } from '@/lib/orders/status/status-token';

// 43 文字（英大小文字・数字・ハイフン・アンダースコアを含む）
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde';

describe('isOrderStatusToken', () => {
  test('見本のトークンは43文字', () => {
    expect(TOKEN).toHaveLength(43);
  });

  test('トークンは43文字のbase64urlだけを受ける', () => {
    const inputs: unknown[] = [
      TOKEN,
      TOKEN.slice(0, 42),
      `${TOKEN}A`,
      `${TOKEN.slice(0, 42)}+`,
      ` ${TOKEN.slice(0, 42)}`,
      12345,
    ];

    const validities = inputs.map(isOrderStatusToken);

    expect(validities).toEqual([true, false, false, false, false, false]);
  });

  test('パディング・改行・全角・空白・文字列以外は受けない。前後を切り落として通さない', () => {
    const rejected: unknown[] = [
      `${TOKEN.slice(0, 42)}=`,
      `${TOKEN.slice(0, 42)}\n`,
      `\n${TOKEN.slice(0, 42)}`,
      `${TOKEN.slice(0, 42)}Ａ`,
      `${TOKEN.slice(0, 21)} ${TOKEN.slice(22)}`,
      `${TOKEN.slice(0, 42)}/`,
      `${TOKEN.slice(0, 42)}.`,
      `${TOKEN} `,
      '',
      null,
      undefined,
      ['a'.repeat(43)],
      { toString: () => TOKEN },
      new String(TOKEN),
    ];

    expect(rejected.filter(isOrderStatusToken)).toEqual([]);
  });

  test('ハイフンとアンダースコアだけの43文字も受ける', () => {
    expect(isOrderStatusToken('-'.repeat(43))).toBe(true);
    expect(isOrderStatusToken('_'.repeat(43))).toBe(true);
    expect(isOrderStatusToken('0'.repeat(43))).toBe(true);
  });

  test('受けた値は文字列として使える（型の絞り込み）', () => {
    const value: unknown = TOKEN;

    if (isOrderStatusToken(value)) {
      const text: string = value;
      expect(text.length).toBe(43);
    } else {
      throw new Error('token should be accepted');
    }
  });
});
