import { clearPromotionCode, readPromotionCode, rememberPromotionCode } from '@/app/checkout/_lib/promotion-memory';

describe('このタブの割引コードの記録', () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  test('コードを読んでも消さず、外したときに消す', () => {
    expect(readPromotionCode()).toBeNull();
    rememberPromotionCode({ code: 'WELCOME10' });
    expect(window.sessionStorage.getItem('checkout:promotion-code')).toBe('{"code":"WELCOME10"}');
    expect(readPromotionCode()).toEqual({ code: 'WELCOME10' });
    expect(readPromotionCode()).toEqual({ code: 'WELCOME10' });
    clearPromotionCode();
    expect(readPromotionCode()).toBeNull();
  });

  test.each(['not json', 'null', '[]', '{}', '{"code":123}', '{"code":""}', '{"code":" "}', '{"code":"<script>"}', JSON.stringify({ code: 'A'.repeat(65) })])(
    '壊れた記録 %s は捨てる', (raw) => {
      window.sessionStorage.setItem('checkout:promotion-code', raw);
      expect(readPromotionCode()).toBeNull();
      expect(window.sessionStorage.getItem('checkout:promotion-code')).toBeNull();
    },
  );

  test.each(['setItem', 'getItem', 'removeItem'] as const)('記録の %s が使えなくても例外を外へ出さない', (method) => {
    jest.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => rememberPromotionCode({ code: 'WELCOME10' })).not.toThrow();
    expect(() => readPromotionCode()).not.toThrow();
    expect(() => clearPromotionCode()).not.toThrow();
  });
});
