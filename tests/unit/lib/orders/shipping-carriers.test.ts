import {
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_IDS,
  isShippingCarrierId,
} from '@/lib/orders/shipping-carriers';

describe('shipping carriers', () => {
  test('3社のラベルを持つ', () => {
    expect(SHIPPING_CARRIER_IDS).toEqual(['yamato', 'sagawa', 'japanpost']);
    expect(SHIPPING_CARRIERS.yamato.label).toBe('ヤマト運輸');
    expect(SHIPPING_CARRIERS.sagawa.label).toBe('佐川急便');
    expect(SHIPPING_CARRIERS.japanpost.label).toBe('日本郵便');
  });

  test('追跡番号を含む追跡URLを組み立てる', () => {
    expect(SHIPPING_CARRIERS.yamato.trackingUrl('1234-5678-9012')).toContain('1234-5678-9012');
    expect(SHIPPING_CARRIERS.sagawa.trackingUrl('123456789012')).toContain('123456789012');
    expect(SHIPPING_CARRIERS.japanpost.trackingUrl('123456789012')).toContain('123456789012');
  });

  test('追跡番号をURLエンコードする', () => {
    expect(SHIPPING_CARRIERS.yamato.trackingUrl('a b')).toContain('a%20b');
  });

  test('未知の業者IDを弾く', () => {
    expect(isShippingCarrierId('yamato')).toBe(true);
    expect(isShippingCarrierId('dhl')).toBe(false);
    expect(isShippingCarrierId(null)).toBe(false);
  });
});
