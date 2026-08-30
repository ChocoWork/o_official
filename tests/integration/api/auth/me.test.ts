export {};

jest.mock('@/lib/supabase/server', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));

describe('GET /api/auth/me', () => {
  const handlerImport = () => import('@/app/api/auth/me/route');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns authenticated user payload from HttpOnly cookie based session', async () => {
    const { verifyAccessToken } = require('@/lib/supabase/server');
    verifyAccessToken.mockResolvedValue({
      ok: true,
      claims: {
        sub: 'user-1',
        email: 'user@example.com',
        aal: 'aal2',
        app_metadata: { role: 'admin' },
      },
    });

    const { GET } = await handlerImport();
    const response = await GET(
      new Request('http://localhost:3000/api/auth/me', {
        headers: {
          cookie: 'sb-access-token=test-token',
        },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      authenticated: true,
      user: {
        id: 'user-1',
        email: 'user@example.com',
        role: 'admin',
        mfaVerified: true,
      },
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  test('reports mfaVerified=false while the session is still aal1', async () => {
    const { verifyAccessToken } = require('@/lib/supabase/server');
    verifyAccessToken.mockResolvedValue({
      ok: true,
      claims: {
        sub: 'user-1',
        email: 'user@example.com',
        aal: 'aal1',
        app_metadata: { role: 'admin' },
      },
    });

    const { GET } = await handlerImport();
    const response = await GET(new Request('http://localhost:3000/api/auth/me'));
    const body = (await response.json()) as { user: { mfaVerified: boolean } };

    expect(body.user.mfaVerified).toBe(false);
  });

  test('returns authenticated=false when no user is resolved', async () => {
    const { verifyAccessToken } = require('@/lib/supabase/server');
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });

    const { GET } = await handlerImport();
    const response: { status: number; json: () => Promise<unknown> } = await GET(
      new Request('http://localhost:3000/api/auth/me'),
    );

    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });
});
