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

  test('GET が401ならセッション更新後に元のリクエストを一度だけ再送する', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await clientFetch('/api/admin/kpi/targets', {
      cache: 'no-store',
    });

    expect(response).toEqual({ ok: true, status: 200 });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch).toHaveBeenNthCalledWith(2, '/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      '/api/admin/kpi/targets',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  test('同時に401になった複数GETはセッション更新を共有してそれぞれ再送する', async () => {
    let refreshed = false;
    let completeRefresh: (() => void) | undefined;
    const refreshResponse = new Promise<{ ok: boolean; status: number }>((resolve) => {
      completeRefresh = () => {
        refreshed = true;
        resolve({ ok: true, status: 200 });
      };
    });
    (global.fetch as jest.Mock).mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/auth/refresh') {
        return refreshResponse;
      }

      return refreshed
        ? { ok: true, status: 200 }
        : { ok: false, status: 401 };
    });

    const responses = Promise.all([
      clientFetch('/api/admin/kpi/targets', { cache: 'no-store' }),
      clientFetch('/api/admin/kpi/monthly-record?season=2026SS', { cache: 'no-store' }),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    completeRefresh?.();
    const [targetsResponse, monthlyResponse] = await responses;

    expect(targetsResponse.status).toBe(200);
    expect(monthlyResponse.status).toBe(200);
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(([endpoint]) => endpoint === '/api/auth/refresh'),
    ).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  test('POST が401でも二重送信を避けるため自動再送しない', async () => {
    cookieGetterSpy = jest
      .spyOn(document, 'cookie', 'get')
      .mockReturnValue('sb-csrf-token=csrf-token-value');
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 401 });

    const response = await clientFetch('/api/admin/kpi/targets', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1);
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

  // クールダウンはモジュールスコープの状態なので、ケースごとにモジュールを作り直す。
  const loadFreshClientFetch = () => {
    jest.resetModules();
    return require('@/lib/client-fetch') as typeof import('@/lib/client-fetch');
  };

  test('refresh が429ならクールダウン中は再発行しない', async () => {
    const { clientFetch: freshFetch } = loadFreshClientFetch();
    (global.fetch as jest.Mock).mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/auth/refresh') {
        return { ok: false, status: 429, headers: { get: () => '30' } };
      }
      return { ok: false, status: 401 };
    });

    await freshFetch('/api/admin/kpi/targets', { cache: 'no-store' });
    await freshFetch('/api/admin/kpi/targets', { cache: 'no-store' });

    const refreshCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([endpoint]) => endpoint === '/api/auth/refresh',
    );
    expect(refreshCalls).toHaveLength(1);
  });

  test('refresh が401ならセッション失効を通知し、その後は再発行しない', async () => {
    const { clientFetch: freshFetch, SESSION_EXPIRED_EVENT } = loadFreshClientFetch();
    const listener = jest.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    (global.fetch as jest.Mock).mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/auth/refresh') {
        return { ok: false, status: 401, headers: { get: () => null } };
      }
      return { ok: false, status: 401 };
    });

    const response = await freshFetch('/api/admin/kpi/targets', { cache: 'no-store' });
    await freshFetch('/api/admin/kpi/targets', { cache: 'no-store' });

    expect(response.status).toBe(401);
    expect(listener).toHaveBeenCalledTimes(1);
    const refreshCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([endpoint]) => endpoint === '/api/auth/refresh',
    );
    expect(refreshCalls).toHaveLength(1);

    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  });

  test('クールダウン中は CSRF Cookie 欠落のPOSTでも refresh しない', async () => {
    const { clientFetch: freshFetch } = loadFreshClientFetch();
    cookieGetterSpy = jest.spyOn(document, 'cookie', 'get').mockReturnValue('foo=bar');
    (global.fetch as jest.Mock).mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/auth/refresh') {
        return { ok: false, status: 429, headers: { get: () => '30' } };
      }
      return { ok: true, status: 200 };
    });

    await freshFetch('/api/admin/kpi/targets', { method: 'POST' });
    await freshFetch('/api/admin/kpi/cost-profit', { method: 'POST' });

    const refreshCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([endpoint]) => endpoint === '/api/auth/refresh',
    );
    expect(refreshCalls).toHaveLength(1);
  });

  // 決済の画面の通信が、ログインの印が古いと断られた時に自分で送り直すための入口（グループ C 設計書第6章）。
  // 結果は3つに分ける: 新しくできた（refreshed）・失効（expired。更新の入口が 401）・一時的にできない（unavailable）
  describe('refreshSessionOnce', () => {
    test('/api/auth/refresh を1回呼び、200 なら refreshed を返す', async () => {
      const { refreshSessionOnce } = loadFreshClientFetch();
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200 });

      await expect(refreshSessionOnce()).resolves.toBe('refreshed');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
    });

    test('/api/auth/refresh が401なら expired を返し、セッション失効を1回通知する', async () => {
      const { refreshSessionOnce, SESSION_EXPIRED_EVENT } = loadFreshClientFetch();
      const listener = jest.fn();
      window.addEventListener(SESSION_EXPIRED_EVENT, listener);
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => null } });

      await expect(refreshSessionOnce()).resolves.toBe('expired');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    });

    test.each([
      ['429（回数の制限）', { ok: false, status: 429, headers: { get: () => '30' } }],
      ['500', { ok: false, status: 500, headers: { get: () => null } }],
      ['503', { ok: false, status: 503, headers: { get: () => null } }],
    ])('/api/auth/refresh が%sなら unavailable を返し、失効は通知しない', async (_label, response) => {
      const { refreshSessionOnce, SESSION_EXPIRED_EVENT } = loadFreshClientFetch();
      const listener = jest.fn();
      window.addEventListener(SESSION_EXPIRED_EVENT, listener);
      (global.fetch as jest.Mock).mockResolvedValueOnce(response);

      await expect(refreshSessionOnce()).resolves.toBe('unavailable');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    });

    test('/api/auth/refresh の通信が失敗したら unavailable を返す', async () => {
      const { refreshSessionOnce } = loadFreshClientFetch();
      (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(refreshSessionOnce()).resolves.toBe('unavailable');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('同時の2回の呼び出しは1回の更新にまとまり、同じ結果を返す', async () => {
      const { refreshSessionOnce } = loadFreshClientFetch();
      let completeRefresh: (() => void) | undefined;
      const refreshResponse = new Promise<{ ok: boolean; status: number }>((resolve) => {
        completeRefresh = () => resolve({ ok: true, status: 200 });
      });
      (global.fetch as jest.Mock).mockImplementation(async () => refreshResponse);

      const results = Promise.all([refreshSessionOnce(), refreshSessionOnce()]);
      completeRefresh?.();

      await expect(results).resolves.toEqual(['refreshed', 'refreshed']);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('更新に失敗した直後はクールダウン中なので、続けて呼んでも更新を発行せず unavailable を返す', async () => {
      const { refreshSessionOnce } = loadFreshClientFetch();
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 429, headers: { get: () => '30' } });

      await expect(refreshSessionOnce()).resolves.toBe('unavailable');
      await expect(refreshSessionOnce()).resolves.toBe('unavailable');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('401 で失効した直後のクールダウン中も、更新を発行せず unavailable を返す（通信しなかった）', async () => {
      const { refreshSessionOnce } = loadFreshClientFetch();
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, headers: { get: () => null } });

      await expect(refreshSessionOnce()).resolves.toBe('expired');
      await expect(refreshSessionOnce()).resolves.toBe('unavailable');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
