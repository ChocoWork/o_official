/**
 * DD-AUTH-060 端末の名前の初期値（src/features/auth/passkey/device-name.ts）の単体テスト。
 */
import { deviceNameFromUserAgent } from '@/features/auth/passkey/device-name';

describe('DD-AUTH-060 deviceNameFromUserAgent', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit', 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 'Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 'Mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox/120', 'Linux'],
  ])('DD-AUTH-060 %s → %s', (ua, expected) => {
    expect(deviceNameFromUserAgent(ua)).toBe(expected);
  });

  test('DD-AUTH-060 どれも含まない・空なら「この端末」', () => {
    expect(deviceNameFromUserAgent('curl/8.0')).toBe('この端末');
    expect(deviceNameFromUserAgent('')).toBe('この端末');
  });

  test('DD-AUTH-060 64字以内', () => {
    expect([...deviceNameFromUserAgent('Windows')].length).toBeLessThanOrEqual(64);
  });
});
