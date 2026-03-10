import {
  extractAddressFromZipCloud,
  formatPostalCodeInput,
  isCompletePostalCode,
  normalizePostalCode,
} from '@/features/checkout/utils/postal-code.util';

describe('postal-code util', () => {
  test('全角・ハイフン混在の郵便番号を正規化できる', () => {
    expect(normalizePostalCode('９８１ー３３５１')).toBe('9813351');
  });

  test('郵便番号を 123-4567 形式に自動整形する', () => {
    expect(formatPostalCodeInput('9813351')).toBe('981-3351');
    expect(formatPostalCodeInput('981-33')).toBe('981-33');
  });

  test('7桁の郵便番号を完了判定する', () => {
    expect(isCompletePostalCode('981-3351')).toBe(true);
    expect(isCompletePostalCode('981-335')).toBe(false);
  });

  test('zipcloud のレスポンスから都道府県・市区町村・番地を抽出する', () => {
    const payload = {
      status: 200,
      results: [
        {
          address1: '宮城県',
          address2: '富谷市',
          address3: '富谷鷹乃杜',
        },
      ],
    };

    expect(extractAddressFromZipCloud(payload)).toEqual({
      prefecture: '宮城県',
      city: '富谷市',
      address: '富谷鷹乃杜',
    });
  });
});