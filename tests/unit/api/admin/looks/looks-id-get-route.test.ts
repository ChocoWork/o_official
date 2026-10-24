export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/features/look/services/admin-rate-limit', () => ({
  consumeAdminLookUploadQuota: jest.fn(),
  enforceAdminLookMutationRateLimit: jest.fn(),
  validateLookImageBatch: jest.fn(),
}));

jest.mock('@/features/look/services/admin-audit', () => ({
  logAdminLookAudit: jest.fn(),
}));

jest.mock('@/lib/storage/look-images', () => ({
  signLookImageUrls: jest.fn(),
}));

const { createServiceRoleClient: mockCreateClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { logAdminLookAudit: mockAudit } = require('@/features/look/services/admin-audit');
const { signLookImageUrls: mockSign } = require('@/lib/storage/look-images');

const { GET } = require('@/app/api/admin/looks/[id]/route');

type Result = { data?: unknown; error?: unknown };

function createClient(options: { look: Result; items?: Result }) {
  const lookEq = jest.fn();
  const itemsEq = jest.fn();
  const client = {
    from: jest.fn((table: string) => {
      if (table === 'looks') {
        return {
          select: jest.fn().mockReturnValue({
            eq: lookEq.mockReturnValue({ single: jest.fn().mockResolvedValue(options.look) }),
          }),
        };
      }
      return {
        select: jest.fn().mockReturnValue({
          eq: itemsEq.mockResolvedValue(options.items ?? { data: [], error: null }),
        }),
      };
    }),
  };
  return { client, lookEq, itemsEq };
}

const request = new Request('http://localhost/api/admin/looks/1');
const params = () => Promise.resolve({ id: '1' });

describe('DD-LOOK-064 GET /api/admin/looks/[id]', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'a@example.com' });
    mockSign.mockImplementation(async (_client: unknown, urls: string[]) => urls.map((url) => `signed:${url}`));
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-LOOK-064 1件の認可が失敗したら認可の応答を返し、DB に触れない', async () => {
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await GET(request, { params: params() });

    expect(response).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.looks.read', request);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 1件が無い時（single が error）は 404 Look not found', async () => {
    const { client } = createClient({ look: { data: null, error: { message: 'no rows' } } });
    mockCreateClient.mockResolvedValue(client);

    const response = await GET(request, { params: params() });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Look not found' });
    expect(client.from).not.toHaveBeenCalledWith('look_items');
  });

  it('DD-LOOK-064 1件の行が null で error も無い時も 404 Look not found', async () => {
    const { client } = createClient({ look: { data: null, error: null } });
    mockCreateClient.mockResolvedValue(client);

    const response = await GET(request, { params: params() });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Look not found' });
  });

  it('DD-LOOK-064 1件の関連の取り出しが失敗したら 500 Failed to fetch look items', async () => {
    const { client } = createClient({
      look: { data: { id: 1, image_urls: [] }, error: null },
      items: { data: null, error: { message: 'boom' } },
    });
    mockCreateClient.mockResolvedValue(client);

    const response = await GET(request, { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch look items' });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 1件の成功は全部の欄・署名つきの画像・linkedItemIds を 200 で返す', async () => {
    const { client, lookEq, itemsEq } = createClient({
      look: { data: { id: 1, theme: 'T', status: 'private', image_urls: ['looks/a.jpg', 'looks/b.jpg'] }, error: null },
      items: { data: [{ item_id: 3 }, { item_id: 7 }], error: null },
    });
    mockCreateClient.mockResolvedValue(client);

    const response = await GET(request, { params: params() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        id: 1,
        theme: 'T',
        status: 'private',
        image_urls: ['signed:looks/a.jpg', 'signed:looks/b.jpg'],
        linkedItemIds: [3, 7],
      },
    });
    expect(mockSign).toHaveBeenCalledWith(client, ['looks/a.jpg', 'looks/b.jpg']);
    expect(lookEq).toHaveBeenCalledWith('id', '1');
    expect(itemsEq).toHaveBeenCalledWith('look_id', '1');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 1件の欠け（関連 data が null・image_urls が配列でない）は空として扱う', async () => {
    const { client } = createClient({
      look: { data: { id: 1, image_urls: null }, error: null },
      items: { data: null, error: null },
    });
    mockCreateClient.mockResolvedValue(client);

    const response = await GET(request, { params: params() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 1, image_urls: [], linkedItemIds: [] } });
    expect(mockSign).toHaveBeenCalledWith(client, []);
  });

  it('DD-LOOK-064 1件の例外は 500 Internal server error で、監査は残さない', async () => {
    mockCreateClient.mockRejectedValue(new Error('client down'));

    const response = await GET(request, { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
