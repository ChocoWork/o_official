/** @jest-environment node */
import { extractOrderStatusLastFour, parseOrderStatusLastFour } from '@/lib/orders/status/status-phone';

describe('parseOrderStatusLastFour', () => {
  test('入力は数字4桁ちょうどだけ受ける', () => {
    const inputs: unknown[] = ['1234', '１２３４', '(12) 34', '123', '12345', '', 1234];

    expect(inputs.map(parseOrderStatusLastFour)).toEqual(['1234', '1234', '1234', null, null, null, null]);
  });

  test('先頭の0を残し、数字以外の記号・空白を取り除いて4桁になる時だけ受ける', () => {
    expect(parseOrderStatusLastFour('0123')).toBe('0123');
    expect(parseOrderStatusLastFour(' 12-34 ')).toBe('1234');
    expect(parseOrderStatusLastFour('１2３4')).toBe('1234');
    expect(parseOrderStatusLastFour('abcd')).toBeNull();
    expect(parseOrderStatusLastFour('12 3x')).toBeNull();
    expect(parseOrderStatusLastFour('+81 90 1234 5678')).toBeNull();
  });

  test('最後の4桁だけを採る処理にはしない（5桁以上は拒む）', () => {
    expect(parseOrderStatusLastFour('12345')).toBeNull();
    expect(parseOrderStatusLastFour('０９０１２３４５６７８')).toBeNull();
  });

  test('文字列以外は拒む', () => {
    const rejected: unknown[] = [null, undefined, 1234, 1234.5, true, ['1234'], { toString: () => '1234' }, new String('1234')];

    expect(rejected.map(parseOrderStatusLastFour)).toEqual(rejected.map(() => null));
  });

  test('長さは1〜64字。64字までは受け、65字以上は4桁でも拒む', () => {
    expect(parseOrderStatusLastFour(`1234${' '.repeat(60)}`)).toBe('1234');
    expect(parseOrderStatusLastFour(`1234${' '.repeat(61)}`)).toBeNull();
    expect(parseOrderStatusLastFour(`${' '.repeat(61)}1234`)).toBeNull();
  });

  test('全角でない他の数字（上付き・丸数字・アラビア数字）は数字に直さず、DB の表の直しと同じ範囲に保つ', () => {
    expect(parseOrderStatusLastFour('①②③④')).toBeNull();
    expect(parseOrderStatusLastFour('¹²³⁴')).toBeNull();
    expect(parseOrderStatusLastFour('١٢٣٤')).toBeNull();
  });
});

describe('extractOrderStatusLastFour', () => {
  test('保存電話は全角をそろえ数字だけの末尾4桁で短い時はnull', () => {
    const phones: Array<string | null> = ['+81 90-1234-5678', '０９０－１２３４－５６７８', '(090) 1234 5678', '12-3', null];

    expect(phones.map(extractOrderStatusLastFour)).toEqual(['5678', '5678', '5678', null, null]);
  });

  test('ちょうど4桁はそのまま、先頭の0を残す。5桁以上は末尾4桁', () => {
    expect(extractOrderStatusLastFour('0123')).toBe('0123');
    expect(extractOrderStatusLastFour('12345')).toBe('2345');
    expect(extractOrderStatusLastFour('tel: 03 (1234) 0056')).toBe('0056');
  });

  test('未設定・空・数字のない値・文字列以外はnull', () => {
    expect(extractOrderStatusLastFour(undefined)).toBeNull();
    expect(extractOrderStatusLastFour('')).toBeNull();
    expect(extractOrderStatusLastFour('---')).toBeNull();
    expect(extractOrderStatusLastFour('abcd')).toBeNull();
    expect(extractOrderStatusLastFour(5678 as unknown as string)).toBeNull();
  });

  test('入力の下4桁と保存電話の末尾4桁は、同じ書き方の違いで同じ値になる', () => {
    const stored = extractOrderStatusLastFour('+81 90-1234-5678');

    expect(parseOrderStatusLastFour('5678')).toBe(stored);
    expect(parseOrderStatusLastFour('５６７８')).toBe(stored);
    expect(parseOrderStatusLastFour('56 78')).toBe(stored);
  });
});
