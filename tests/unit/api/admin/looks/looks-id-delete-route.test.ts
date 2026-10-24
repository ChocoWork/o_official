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
const { enforceAdminLookMutationRateLimit: mockEnforce } = require('@/features/look/services/admin-rate-limit');
const { logAdminLookAudit: mockAudit } = require('@/features/look/services/admin-audit');

const { DELETE } = require('@/app/api/admin/looks/[id]/route');

type Result = { data?: unknown; error?: unknown };

function createClient(options: { existingLook?: Result; deleteError?: unknown } = {}) {
  const remove = jest.fn();
  const removeEq = jest.fn().mockResolvedValue({ error: options.deleteError ?? null });
  const client = {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue(
            options.existingLook ?? { data: { id: 1, status: 'published' }, error: null },
          ),
        }),
      }),
      delete: remove.mockReturnValue({ eq: removeEq }),
    })),
  };
  return { client, remove, removeEq };
}

const request = new Request('http://localhost/api/admin/looks/1', { method: 'DELETE' });
const params = () => Promise.resolve({ id: '1' });
const audits = () => mockAudit.mock.calls.map((call: unknown[]) => call[0]);

describe('DD-LOOK-064 DELETE /api/admin/looks/[id]', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'a@example.com' });
    mockEnforce.mockResolvedValue(undefined);
    mockAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-LOOK-064 削除の認可が失敗したら認可の応答を返し、回数も監査も触れない', async () => {
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await DELETE(request, { params: params() });

    expect(response).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.looks.manage', request);
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 削除の回数が超過したら 429 を返し、DB も監査も触れない', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    mockEnforce.mockResolvedValue(limited);

    const response = await DELETE(request, { params: params() });

    expect(response).toBe(limited);
    expect(mockEnforce).toHaveBeenCalledWith({ request, actorId: 'admin-1', kind: 'delete' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 削除の無い LOOK（single が error）は 404 と監査 Look not found', async () => {
    const { client, remove } = createClient({ existingLook: { data: null, error: { message: 'none' } } });
    mockCreateClient.mockResolvedValue(client);

    const response = await DELETE(request, { params: params() });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Look not found' });
    expect(audits()).toEqual([
      expect.objectContaining({
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Look not found',
        resourceId: '1',
      }),
    ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 削除の行が null で error も無い時も 404', async () => {
    const { client } = createClient({ existingLook: { data: null, error: null } });
    mockCreateClient.mockResolvedValue(client);

    const response = await DELETE(request, { params: params() });

    expect(response.status).toBe(404);
  });

  it('DD-LOOK-064 削除の失敗は 500 Failed to delete look と監査 Failed to delete look（消す前の状態つき）', async () => {
    const { client } = createClient({ deleteError: { message: 'fk' } });
    mockCreateClient.mockResolvedValue(client);

    const response = await DELETE(request, { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to delete look' });
    expect(audits()).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        detail: 'Failed to delete look',
        resourceId: '1',
        metadata: { deleted_status: 'published' },
      }),
    ]);
  });

  it('DD-LOOK-064 削除の成功は looks の行だけを消し、監査 success に消した LOOK の状態を残す', async () => {
    const { client, remove, removeEq } = createClient();
    mockCreateClient.mockResolvedValue(client);

    const response = await DELETE(request, { params: params() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(client.from).toHaveBeenNthCalledWith(1, 'looks');
    expect(client.from).toHaveBeenNthCalledWith(2, 'looks');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(removeEq).toHaveBeenCalledWith('id', '1');
    expect(audits()).toEqual([
      {
        request,
        actorId: 'admin-1',
        actorEmail: 'a@example.com',
        action: 'admin.look.delete',
        outcome: 'success',
        detail: 'Look deleted',
        resourceId: '1',
        metadata: { deleted_status: 'published' },
      },
    ]);
  });

  it('DD-LOOK-064 削除の例外（操作者あり）は 500 Internal server error と監査 Unexpected delete error', async () => {
    mockCreateClient.mockRejectedValue(new Error('client down'));

    const response = await DELETE(request, { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(audits()).toEqual([
      {
        request,
        actorId: 'admin-1',
        actorEmail: 'a@example.com',
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Unexpected delete error',
      },
    ]);
  });

  it('DD-LOOK-064 削除の例外（操作者なし＝認可が投げる）は 500 で監査を残さない', async () => {
    mockAuthorize.mockRejectedValue(new Error('rbac down'));

    const response = await DELETE(request, { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
