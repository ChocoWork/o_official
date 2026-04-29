jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  resolveRequestUser: jest.fn(),
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
    const { createClient, resolveRequestUser } = require('@/lib/supabase/server');
    createClient.mockResolvedValue({});
    resolveRequestUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'user@example.com',
          app_metadata: {
            role: 'admin',
            admin_mfa_verified: true,
          },
        },
      },
    });

    const { GET } = await handlerImport();
    const response: { status: number; json: () => Promise<unknown>; headers: Map<string, string> } = await GET(
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

  test('returns authenticated=false when no user is resolved', async () => {
    const { createClient, resolveRequestUser } = require('@/lib/supabase/server');
    createClient.mockResolvedValue({});
    resolveRequestUser.mockResolvedValue({
      data: {
        user: null,
      },
    });

    const { GET } = await handlerImport();
    const response: { status: number; json: () => Promise<unknown> } = await GET(
      new Request('http://localhost:3000/api/auth/me'),
    );

    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });
});