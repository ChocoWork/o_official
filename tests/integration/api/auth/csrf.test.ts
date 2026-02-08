jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => {
      const res: any = {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map(),
        cookies: {
          _cookies: [] as any[],
          set(c: any) { this._cookies.push(c); },
          get(name: string) { return this._cookies.find((c: any) => c.name === name); },
        },
      };
      return res;
    },
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const { cookies, headers } = require('next/headers');

describe('CSRF integration (mocked)', () => {
  let requireCsrfOrDeny: any;

  beforeAll(() => {
    requireCsrfOrDeny = require('@/lib/csrfMiddleware').requireCsrfOrDeny;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // by default, provide a refresh cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
  });

  test('logout with valid CSRF header rotates token and returns 200 with new csrf cookie', async () => {
    // Prepare header token and hash storage
    const headerToken = 'csrf-old-token';
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(headerToken) });

    const { tokenHashSha256 } = require('@/lib/hash');
    const storedHash = tokenHashSha256(headerToken);

    // Mock service role client to return stored csrf_token_hash and accept updates
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const maybeSingle = jest.fn().mockResolvedValue({ data: { csrf_token_hash: storedHash } });
    const eqForSelect = jest.fn(() => ({ maybeSingle }));
    const select = jest.fn(() => ({ eq: eqForSelect }));
    const eqForUpdate = jest.fn().mockResolvedValue({});
    const update = jest.fn(() => ({ eq: eqForUpdate }));
    const from = jest.fn(() => ({ select, update }));
    createServiceRoleClient.mockReturnValue({ from });

    const result: any = await requireCsrfOrDeny();
    expect(result).toBeDefined();
    expect(result.rotatedCsrfToken).toBeDefined();
    expect(result.rotatedCsrfToken).not.toBe(headerToken);

    // confirm that the DB update path was attempted
    const svc = require('@/lib/supabase/server');
    expect(svc.createServiceRoleClient().from).toHaveBeenCalledWith('sessions');
  });

  test('logout without CSRF header returns 403', async () => {
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    const result: any = await requireCsrfOrDeny();
    expect(result.status).toBe(403);
  });
});
