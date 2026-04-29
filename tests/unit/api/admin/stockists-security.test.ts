jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRequireCsrfOrDeny = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: () => mockRequireCsrfOrDeny(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => {
      const headers = new Headers(init?.headers);
      return {
        status: init?.status ?? 200,
        _body: body,
        headers,
        cookies: {
          set: jest.fn(),
        },
        json: async () => body,
      };
    },
  },
}));

const { createClient: mockCreateClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorizeAdminPermission } = require('@/lib/auth/admin-rbac');

const stockistsRoute = require('@/app/api/admin/stockists/route');
const stockistByIdRoute = require('@/app/api/admin/stockists/[id]/route');

function createStockistServiceMock() {
  return {
    from: jest.fn((table: string) => {
      if (table !== 'stockists') {
        return {};
      }

      return {
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({
            data: [{ id: 1, name: 'Flagship' }],
            error: null,
          }),
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: { id: 1, name: 'Flagship', status: 'private' },
              error: null,
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: { id: 77 }, error: null }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
        delete: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    }),
  };
}

describe('admin stockist security guards', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAuthorizeAdminPermission.mockResolvedValue({
      ok: true,
      userId: 'admin-user',
      role: 'admin',
      actorEmail: 'admin@example.com',
    });
    mockCreateClient.mockResolvedValue(createStockistServiceMock());
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRequireCsrfOrDeny.mockResolvedValue(undefined);
  });

  test('GET applies both ip and actor rate limits before reading stockists', async () => {
    const request = new Request('http://localhost/api/admin/stockists', {
      method: 'GET',
      headers: { 'x-forwarded-for': '198.51.100.10' },
    });

    const response = await stockistsRoute.GET(request);

    expect(response.status).toBe(200);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request,
        endpoint: 'admin:stockists:read',
        limit: 120,
        windowSeconds: 600,
      }),
    );
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request,
        endpoint: 'admin:stockists:read',
        limit: 120,
        windowSeconds: 600,
        subject: 'admin-user',
      }),
    );
  });

  test('POST returns 403 when csrf validation denies cookie-authenticated mutation', async () => {
    mockRequireCsrfOrDeny.mockResolvedValue({
      status: 403,
      _body: { error: 'Forbidden' },
    });

    const request = new Request('http://localhost/api/admin/stockists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'New Store',
        address: 'Tokyo',
        phone: '03-0000-0000',
        time: '11:00-20:00',
        holiday: 'Wed',
        status: 'private',
      }),
    });

    const response = await stockistsRoute.POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Forbidden' });
  });

  test('POST rotates csrf cookie on success', async () => {
    mockRequireCsrfOrDeny.mockResolvedValue({
      rotatedCsrfToken: 'rotated-token',
    });

    const request = new Request('http://localhost/api/admin/stockists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'New Store',
        address: 'Tokyo',
        phone: '03-0000-0000',
        time: '11:00-20:00',
        holiday: 'Wed',
        status: 'private',
      }),
    });

    const response = await stockistsRoute.POST(request);

    expect(response.status).toBe(201);
    expect(response.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'sb-csrf-token',
        value: 'rotated-token',
      }),
    );
  });

  test('PATCH returns 429 when mutation rate limit is exceeded', async () => {
    mockEnforceRateLimit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        status: 429,
        _body: { error: 'Too many requests' },
        json: async () => ({ error: 'Too many requests' }),
      });

    const request = new Request('http://localhost/api/admin/stockists/1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });

    const response = await stockistByIdRoute.PATCH(request, {
      params: Promise.resolve({ id: '1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({ error: 'Too many requests' });
    expect(mockRequireCsrfOrDeny).not.toHaveBeenCalled();
  });
});