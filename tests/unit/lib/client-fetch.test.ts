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

  test('GET の一時的な通信失敗は一度だけ再試行する', async () => {
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true });

    const response = await clientFetch('/api/admin/kpi/cost-profit', {
      method: 'GET',
      cache: 'no-store',
    });

    expect(response).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      '/api/admin/kpi/cost-profit',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
      }),
    );
  });

  test('POST の通信失敗は二重送信を避けるため再試行しない', async () => {
    cookieGetterSpy = jest
      .spyOn(document, 'cookie', 'get')
      .mockReturnValue('sb-csrf-token=csrf-token-value');
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );

    await expect(
      clientFetch('/api/admin/kpi/cost-profit', { method: 'POST' }),
    ).rejects.toThrow('Failed to fetch');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('パーセントエンコード済みの既存 CSRF Cookie をそのまま transport できる', async () => {
    cookieGetterSpy = jest
      .spyOn(document, 'cookie', 'get')
      .mockReturnValue('foo=bar; sb-csrf-token=%01legacy-csrf-token');

    await clientFetch('/api/profile', {
      method: 'POST',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit & { headers: Headers }
    ];
    const headers = options.headers as Headers;
    expect(headers.get('x-csrf-token')).toBe('%01legacy-csrf-token');
  });

  test('CSRF Cookie がない場合はセッションを更新してから元のPOSTを送る', async () => {
    cookieGetterSpy = jest
      .spyOn(document, 'cookie', 'get')
      .mockReturnValueOnce('foo=bar')
      .mockReturnValue('foo=bar; sb-csrf-token=recovered-token');

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await clientFetch('/api/admin/kpi/cost-profit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'plan.update' }),
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(1, '/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });

    const [, options] = (global.fetch as jest.Mock).mock.calls[1] as [
      string,
      RequestInit & { headers: Headers }
    ];
    expect((options.headers as Headers).get('x-csrf-token')).toBe('recovered-token');
  });
});
