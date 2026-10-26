export {};

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => {
      const headers = new Map<string, string>(Object.entries(init?.headers ?? {}));
      return {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers,
      };
    },
  },
}));

type MeResponse = {
  status: number;
  json: () => Promise<any>;
  headers: Map<string, string>;
};

const { authenticateRequest } = require('@/lib/auth/authenticate');

const callMe = async (init?: RequestInit): Promise<MeResponse> => {
  const { GET } = await import('@/app/api/auth/me/route');
  return (await GET(new Request('http://localhost:3000/api/auth/me', init))) as unknown as MeResponse;
};

const expectNoStoreHeaders = (response: MeResponse) => {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
};

describe('GET /api/auth/me', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('API-AUTH-013 ログイン中なら id・role・mfaVerified を 200 で返し、email は返さない', async () => {
    authenticateRequest.mockResolvedValue({
      ok: true,
      claims: {
        sub: 'user-1',
        email: 'user@example.com',
        aal: 'aal2',
        app_metadata: { role: 'admin' },
      },
    });

    const response = await callMe({ headers: { cookie: 'sb-access-token=test-token' } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      user: {
        id: 'user-1',
        role: 'admin',
        mfaVerified: true,
      },
    });
    expectNoStoreHeaders(response);
  });

  test('API-AUTH-013 認証の確かめには受け取った Request をそのまま渡す', async () => {
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'missing' });

    await callMe({ headers: { authorization: 'Bearer abc' } });

    expect(authenticateRequest).toHaveBeenCalledTimes(1);
    const passed = authenticateRequest.mock.calls[0][0] as Request;
    expect(passed.url).toBe('http://localhost:3000/api/auth/me');
    expect(passed.headers.get('authorization')).toBe('Bearer abc');
  });

  test('API-AUTH-013 JWT の aal が aal1 の間は mfaVerified を false にする', async () => {
    authenticateRequest.mockResolvedValue({
      ok: true,
      claims: {
        sub: 'user-1',
        email: 'user@example.com',
        aal: 'aal1',
        app_metadata: { role: 'admin' },
      },
    });

    const body = await (await callMe()).json();

    expect(body.user.mfaVerified).toBe(false);
  });

  test.each(['admin', 'supporter', 'user'])(
    'API-AUTH-013 app_metadata の役割 %s をそのまま返す',
    async (role) => {
      authenticateRequest.mockResolvedValue({
        ok: true,
        claims: { sub: 'user-1', email: 'a@example.com', aal: 'aal1', app_metadata: { role } },
      });

      const body = await (await callMe()).json();

      expect(body.user.role).toBe(role);
    },
  );

  test.each([
    ['知らない値', { role: 'superuser' }],
    ['文字列でない値', { role: 1 }],
    ['役割が無い app_metadata', {}],
    ['app_metadata が無い', undefined],
  ])('API-AUTH-013 %s の役割は user にする', async (_label, appMetadata) => {
    authenticateRequest.mockResolvedValue({
      ok: true,
      claims: { sub: 'user-1', email: 'a@example.com', aal: 'aal2', app_metadata: appMetadata },
    });

    const body = await (await callMe()).json();

    expect(body.user.role).toBe('user');
  });

  test('API-AUTH-013 user_metadata の役割は読まず、app_metadata だけを見る', async () => {
    authenticateRequest.mockResolvedValue({
      ok: true,
      claims: {
        sub: 'user-1',
        email: 'a@example.com',
        aal: 'aal1',
        user_metadata: { role: 'admin' },
        app_metadata: {},
      },
    });

    const body = await (await callMe()).json();

    expect(body.user.role).toBe('user');
  });

  test('API-AUTH-013 email が JWT にあっても、無くても、応答の user に email のキーを持たない', async () => {
    for (const claims of [
      { sub: 'user-1', email: 'user@example.com', aal: 'aal1', app_metadata: { role: 'user' } },
      { sub: 'user-1', aal: 'aal1', app_metadata: { role: 'user' } },
    ]) {
      authenticateRequest.mockResolvedValue({ ok: true, claims });

      const body = await (await callMe()).json();
      const text = JSON.stringify(body);

      expect(Object.keys(body.user).sort()).toEqual(['id', 'mfaVerified', 'role']);
      expect(text).not.toContain('user@example.com');
    }
  });

  test.each(['missing', 'invalid', 'expired', 'revoked'])(
    'API-AUTH-013 未ログイン・失効（%s）は authenticated=false を 200 で返す',
    async (reason) => {
      authenticateRequest.mockResolvedValue({ ok: false, reason });

      const response = await callMe();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ authenticated: false });
      expect(response.headers.has('Retry-After')).toBe(false);
      expectNoStoreHeaders(response);
    },
  );

  test('API-AUTH-013 失効を確かめられない時は 503 と Retry-After 30 を返し、未ログインとは区別する', async () => {
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const response = await callMe();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ authenticated: false, reason: 'unavailable' });
    expect(response.headers.get('Retry-After')).toBe('30');
    expectNoStoreHeaders(response);
  });

  test('API-AUTH-013 認証の確かめが例外を投げたら authenticated=false を返し、ヘッダーも付ける', async () => {
    authenticateRequest.mockRejectedValue(new Error('boom'));

    const response = await callMe();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expectNoStoreHeaders(response);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
