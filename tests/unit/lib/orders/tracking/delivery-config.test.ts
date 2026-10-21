/** @jest-environment node */
import {
  isDeliveryTrackingKeyConfigured,
  readDeliveryTrackingConfig,
} from '@/lib/orders/tracking/delivery-config';

jest.mock('server-only', () => ({}), { virtual: true });

describe('配送の追跡の設定', () => {
  test.each([undefined, '', ' \r\n\t '])('空の鍵 %j はnull、公開判定はfalse', (key) => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TRACKING_17TRACK_API_KEY: key };
    expect(readDeliveryTrackingConfig(env)).toEqual({
      apiKey: null, baseUrl: 'https://api.17track.net/track/v2.4',
    });
    expect(isDeliveryTrackingKeyConfigured(env)).toBe(false);
  });

  test('鍵をtrimし設定済みかだけを公開する', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TRACKING_17TRACK_API_KEY: ' fake-tracking-key \n' };
    expect(readDeliveryTrackingConfig(env).apiKey).toBe('fake-tracking-key');
    expect(isDeliveryTrackingKeyConfigured(env)).toBe(true);
  });

  test('差し替えURLの末尾スラッシュを除く', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TRACKING_17TRACK_BASE_URL: 'http://127.0.0.1:4017/track/v2.4///' };
    expect(readDeliveryTrackingConfig(env).baseUrl).toBe('http://127.0.0.1:4017/track/v2.4');
  });

  test('渡された設定を変更しない', () => {
    const env = Object.freeze({ NODE_ENV: 'test' as const, TRACKING_17TRACK_API_KEY: ' fake ' });
    readDeliveryTrackingConfig(env);
    expect(env.TRACKING_17TRACK_API_KEY).toBe(' fake ');
  });
});
