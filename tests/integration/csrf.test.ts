export {};

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

  // ローテーションはログイン・セッション更新に限定した。ミューテーションのたびに
  // 回すと、失敗した要求でも Cookie と DB がずれて以降が全部 403 になるため。
  // 検証を通ったときは何も返さない（＝通過）のが新しい契約。
  test('valid CSRF header passes without rotating', async () => {
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

    // 検証を通ったので拒否レスポンスは返らない。
    expect(res).toBeUndefined();
  });

  test('CSRF hash mismatch returns 403', async () => {
    const { tokenHashSha256 } = await import('@/lib/hash');
    const otherHash = await tokenHashSha256('someone-elses-token');

    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'refresh-token' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue('csrf-token') });

    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({
      from: () => ({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({ data: { csrf_token_hash: otherHash } }),
          }),
        }),
      }),
    });

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const res: any = await requireCsrfOrDeny();

    expect(res.status).toBe(403);
  });
});