export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      body,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/lib/auth/audit-authz-denial', () => ({
  auditAuthzDenial: jest.fn(),
}));

jest.mock('@/features/stockist/services/admin-security', () => ({
  enforceAdminStockistActorRateLimit: jest.fn(),
  enforceAdminStockistIpRateLimit: jest.fn(),
}));

const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { auditAuthzDenial: mockAuditDenial } = require('@/lib/auth/audit-authz-denial');
const {
  enforceAdminStockistActorRateLimit: mockActorLimit,
  enforceAdminStockistIpRateLimit: mockIpLimit,
} = require('@/features/stockist/services/admin-security');

const { GET } = require('@/app/api/admin/stockists/access/route');

function getRequest() {
  return new Request('http://localhost/api/admin/stockists/access', { method: 'GET' });
}

function tooManyResponse() {
  return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
}

describe('GET /api/admin/stockists/access', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIpLimit.mockResolvedValue(null);
    mockActorLimit.mockResolvedValue(null);
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'user-1' });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-STOCKIST-040 admin.stockists.manage を持つ人には本文の無い 204 を no-store で返し、監査は残さない', async () => {
    const response = await GET(getRequest());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockAuthorize).toHaveBeenCalledWith('admin.stockists.manage', expect.any(Request));
    expect(mockAuditDenial).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-040 送り元の枠 → 認可 → 操作者の枠の順に、読みの枠で呼ぶ', async () => {
    const order: string[] = [];
    mockIpLimit.mockImplementation(async () => { order.push('ip'); return null; });
    mockAuthorize.mockImplementation(async () => { order.push('authz'); return { ok: true, userId: 'user-1' }; });
    mockActorLimit.mockImplementation(async () => { order.push('actor'); return null; });

    await GET(getRequest());

    expect(order).toEqual(['ip', 'authz', 'actor']);
    expect(mockIpLimit).toHaveBeenCalledWith(expect.any(Request), 'read');
    expect(mockActorLimit).toHaveBeenCalledWith(expect.any(Request), 'user-1', 'read');
  });

  it('DD-STOCKIST-040 送り元の枠が止めたら認可も操作者の枠も呼ばず、その応答を no-store で返す', async () => {
    mockIpLimit.mockResolvedValue(tooManyResponse());

    const response = await GET(getRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockActorLimit).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-040 認可が断った時は action admin.stockists.access で監査してから、その応答を no-store で返す', async () => {
    const denied = { ok: false, response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) };
    mockAuthorize.mockResolvedValue(denied);

    const response = await GET(getRequest());

    expect(response).toBe(denied.response);
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockAuditDenial).toHaveBeenCalledWith(denied, {
      request: expect.any(Request),
      action: 'admin.stockists.access',
      resource: 'stockists',
    });
    expect(mockActorLimit).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-040 操作者の枠が止めたら 204 にせず、その応答を no-store で返す', async () => {
    mockActorLimit.mockResolvedValue(tooManyResponse());

    const response = await GET(getRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('DD-STOCKIST-040 途中で例外が出たら 500 を返し、詳細は応答に出さない', async () => {
    mockAuthorize.mockRejectedValue(new Error('boom secret'));

    const response = await GET(getRequest());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
