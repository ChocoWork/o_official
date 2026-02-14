jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

describe('CSRF middleware integration', () => {
  const { cookies, headers } = require('next/headers');

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('missing CSRF header returns 403 when refresh cookie exists', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'refresh' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const res: any = await requireCsrfOrDeny();

    expect(res.status).toBe(403);
  });

  test('valid CSRF header rotates token', async () => {
    const { tokenHashSha256 } = await import('@/lib/hash');
    const refreshToken = 'refresh-token';
    const csrfToken = 'csrf-token';
    const csrfHash = await tokenHashSha256(csrfToken);

    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: refreshToken }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(csrfToken) });

    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({
      from: () => ({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({ data: { csrf_token_hash: csrfHash } }),
          }),
        }),
        update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({}) }),
      }),
    });

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const res: any = await requireCsrfOrDeny();

    expect(res).toBeDefined();
    expect(res.rotatedCsrfToken).toBeDefined();
  });
});