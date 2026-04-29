import { clientFetch } from '@/lib/client-fetch';

describe('clientFetch', () => {
  const originalFetch = global.fetch;
  let cookieGetterSpy: jest.SpyInstance<string, []> | null = null;

  beforeEach(() => {
    Object.defineProperty(global, 'fetch', {
      value: jest.fn().mockResolvedValue({ ok: true }),
      writable: true,
    });
  });

  afterEach(() => {
    cookieGetterSpy?.mockRestore();
    cookieGetterSpy = null;
    Object.defineProperty(global, 'fetch', {
      value: originalFetch,
      writable: true,
    });
  });

  test('POST では sb-csrf-token を x-csrf-token に自動付与する', async () => {
    cookieGetterSpy = jest
      .spyOn(document, 'cookie', 'get')
      .mockReturnValue('foo=bar; sb-csrf-token=csrf-token-value');

    await clientFetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'テスト' }),
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit & { headers: Headers }
    ];
    const headers = options.headers as Headers;
    expect(headers.get('x-csrf-token')).toBe('csrf-token-value');
  });

  test('GET では x-csrf-token を自動付与しない', async () => {
    cookieGetterSpy = jest
      .spyOn(document, 'cookie', 'get')
      .mockReturnValue('foo=bar; sb-csrf-token=csrf-token-value');

    await clientFetch('/api/profile', {
      method: 'GET',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit & { headers: Headers }
    ];
    const headers = options.headers as Headers;
    expect(headers.get('x-csrf-token')).toBeNull();
  });
});
