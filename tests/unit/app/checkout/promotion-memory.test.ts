import { clearPromotionCodes, readPromotionCodes, writePromotionCodes } from '@/app/checkout/_lib/promotion-memory';

const KEY = 'checkout:promotion-codes';
const LEGACY_KEY = 'checkout:promotion-code';

describe('このタブの割引コードの記録', () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  test('FREQ-550-AC-02: コードだけを{version:1,codes}で保存し、読んでも消さず、外したときに消す', () => {
    expect(readPromotionCodes()).toEqual([]);
    writePromotionCodes(['welcome10', 'SPRING-2', 'WELCOME10']);
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null')).toEqual({ version: 1, codes: ['WELCOME10', 'SPRING-2'] });
    expect(readPromotionCodes()).toEqual(['WELCOME10', 'SPRING-2']);
    expect(readPromotionCodes()).toEqual(['WELCOME10', 'SPRING-2']);
    clearPromotionCodes();
    expect(readPromotionCodes()).toEqual([]);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test('FREQ-550-AC-02: 金額・資格・メール・名前を保存しない', () => {
    writePromotionCodes(['WELCOME10']);
    expect(Object.keys(JSON.parse(window.sessionStorage.getItem(KEY) ?? '{}'))).toEqual(['version', 'codes']);
  });

  test('FREQ-550-AC-02: 旧キーのコードは初回の読取で配列へ取り込み、旧キーを消す', () => {
    window.sessionStorage.setItem(LEGACY_KEY, JSON.stringify({ code: 'OLD10' }));

    expect(readPromotionCodes()).toEqual(['OLD10']);

    expect(window.sessionStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null')).toEqual({ version: 1, codes: ['OLD10'] });
    expect(readPromotionCodes()).toEqual(['OLD10']);
  });

  test('FREQ-550-AC-02: 新しい記録がある時は旧キーを読まずに消す', () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, codes: ['NEW10'] }));
    window.sessionStorage.setItem(LEGACY_KEY, JSON.stringify({ code: 'OLD10' }));

    expect(readPromotionCodes()).toEqual(['NEW10']);
    expect(window.sessionStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  test.each([
    'not json', 'null', '[]', '{}', '{"version":2,"codes":["A"]}', '{"version":1}', '{"version":1,"codes":"A"}',
    '{"version":1,"codes":[1]}', '{"version":1,"codes":["<script>"]}', '{"version":1,"codes":["A","B","C","D","E","F"]}',
    JSON.stringify({ version: 1, codes: ['A'.repeat(65)] }), '{"version":1,"codes":["A"],"amount":5}',
  ])('FREQ-550-AC-02: 壊れた記録 %s は捨てる', (raw) => {
    window.sessionStorage.setItem(KEY, raw);
    expect(readPromotionCodes()).toEqual([]);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test.each(['not json', '{"code":123}', '{"code":""}', '{"code":"<script>"}'])('FREQ-550-AC-02: 壊れた旧記録 %s は捨てる', (raw) => {
    window.sessionStorage.setItem(LEGACY_KEY, raw);
    expect(readPromotionCodes()).toEqual([]);
    expect(window.sessionStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  test('FREQ-550-AC-02: 空の配列を書くと記録を消す', () => {
    writePromotionCodes(['A']);
    writePromotionCodes([]);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test.each(['setItem', 'getItem', 'removeItem'] as const)('記録の %s が使えなくても例外を外へ出さない', (method) => {
    jest.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => writePromotionCodes(['WELCOME10'])).not.toThrow();
    expect(() => readPromotionCodes()).not.toThrow();
    expect(() => clearPromotionCodes()).not.toThrow();
  });
});
