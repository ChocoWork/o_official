import { describeErrorForLog } from '@/lib/logging/safe-error';

describe('DD-SEARCH-006 describeErrorForLog', () => {
  it('DD-SEARCH-006 Error は name だけを残し、message を JSON に含めない', () => {
    const result = describeErrorForLog(new Error('secret token abc'));

    expect(result).toEqual({ name: 'Error', code: null });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('DD-SEARCH-006 Supabase の誤りの形のプレーンな物は UnknownError と code だけを残す', () => {
    const result = describeErrorForLog({
      code: '42501',
      message: 'permission denied for table x',
      details: 'details secret',
      hint: 'hint secret',
    });

    expect(result).toEqual({ name: 'UnknownError', code: '42501' });
    expect(JSON.stringify(result)).not.toMatch(/permission|secret/);
  });

  it('DD-SEARCH-006 TypeError の name は残る', () => {
    expect(describeErrorForLog(new TypeError('x'))).toEqual({ name: 'TypeError', code: null });
  });

  it.each([
    ['長い文字', 'x'.repeat(33)],
    ['空白入り', '42 501'],
    ['空文字', ''],
    ['オブジェクト', { nested: 'secret' }],
  ])('DD-SEARCH-006 code が %s なら null', (_label, code) => {
    expect(describeErrorForLog({ code })).toEqual({ name: 'UnknownError', code: null });
  });

  it('DD-SEARCH-006 code が整数 500 なら文字の 500', () => {
    expect(describeErrorForLog({ code: 500 })).toEqual({ name: 'UnknownError', code: '500' });
  });

  it('DD-SEARCH-006 code が小数・NaN なら null', () => {
    expect(describeErrorForLog({ code: 1.5 }).code).toBeNull();
    expect(describeErrorForLog({ code: Number.NaN }).code).toBeNull();
  });

  it.each([[null], [undefined], ['secret text'], [42]])('DD-SEARCH-006 入力が %p でも投げない', (input) => {
    expect(describeErrorForLog(input)).toEqual({ name: 'UnknownError', code: null });
  });

  it('DD-SEARCH-006 name が空白入りの Error は UnknownError', () => {
    const error = new Error('x');
    error.name = 'Err or';

    expect(describeErrorForLog(error)).toEqual({ name: 'UnknownError', code: null });
  });

  it('DD-SEARCH-006 name が 65 字の Error は UnknownError', () => {
    const error = new Error('x');
    error.name = 'E'.repeat(65);

    expect(describeErrorForLog(error).name).toBe('UnknownError');
  });

  it('DD-SEARCH-006 code の getter が投げても投げない', () => {
    const hostile = {
      get code(): string {
        throw new Error('boom');
      },
    };

    expect(describeErrorForLog(hostile)).toEqual({ name: 'UnknownError', code: null });
  });
});
