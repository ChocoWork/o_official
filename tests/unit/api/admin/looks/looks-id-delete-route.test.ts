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
  ...jest.requireActual('@/lib/storage/look-images'),
  signLookImageUrls: jest.fn(),
}));

const { createServiceRoleClient: mockCreateClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { enforceAdminLookMutationRateLimit: mockEnforce } = require('@/features/look/services/admin-rate-limit');
const { logAdminLookAudit: mockAudit } = require('@/features/look/services/admin-audit');

const { DELETE } = require('@/app/api/admin/looks/[id]/route');

type Result = { data?: unknown; error?: unknown };

function createClient(
  options: { existingLook?: Result; deleteError?: unknown; storageRemove?: 'fail' | 'throw' } = {},
) {
  const remove = jest.fn();
  const select = jest.fn();
  const storageRemove = jest.fn().mockImplementation(async () => {
    if (options.storageRemove === 'throw') throw new Error('storage down');
    return { error: options.storageRemove === 'fail' ? { message: 'storage SECRET' } : null };
  });
  const removeEq = jest.fn().mockResolvedValue({ error: options.deleteError ?? null });
  const client = {
    storage: { from: jest.fn(() => ({ remove: storageRemove })) },
    from: jest.fn(() => ({
      select: select.mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: jest.fn().mockResolvedValue(
            options.existingLook ?? { data: { id: 1, status: 'published' }, error: null },
          ),
        }),
      }),
      delete: remove.mockReturnValue({ eq: removeEq }),
    })),
  };
  return { client, remove, removeEq, select, storageRemove };
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

  it.each(['abc', '1e3', '0', '-1', '1.5'])(
    'DD-LOOK-064 id が %s の時は認可と回数の後で 400 Invalid look id と監査（id の生の値は残さず長さだけ）で、DB を呼ばない',
    async (badId) => {
      const response = await DELETE(request, { params: Promise.resolve({ id: badId }) });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid look id' });
      expect(audits()).toEqual([
        expect.objectContaining({
          action: 'admin.look.delete',
          outcome: 'failure',
          detail: 'Invalid look id',
          metadata: { id_length: badId.length },
        }),
      ]);
      expect(audits()[0].resourceId).toBeUndefined();
      expect(mockCreateClient).not.toHaveBeenCalled();
    },
  );

  it('DD-LOOK-064 id が不正でも認可が通らなければ今までの 403 を返す（id の検査より先）', async () => {
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await DELETE(request, { params: Promise.resolve({ id: 'abc' }) });

    expect(response).toBe(denied);
  });

  it('DD-LOOK-064 削除の存在確認が DB の失敗なら 500 と監査 Failed to fetch look で、行も画像も消さない', async () => {
    const { client, remove, storageRemove } = createClient({
      existingLook: { data: null, error: Object.assign(new Error('boom SECRET'), { code: '57014' }) },
    });
    mockCreateClient.mockResolvedValue(client);

    const response = await DELETE(request, { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch look' });
    expect(audits()).toEqual([expect.objectContaining({ outcome: 'failure', detail: 'Failed to fetch look' })]);
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch look:', { name: 'Error', code: '57014' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
    expect(remove).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 削除の無い LOOK（maybeSingle が null）は 404 と監査 Look not found', async () => {
    const { client, remove } = createClient({ existingLook: { data: null, error: null } });
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

  it('DD-LOOK-064 削除の失敗は 500 Failed to delete look と監査 Failed to delete look（消す前の状態つき）で、画像は消さない', async () => {
    const { client, storageRemove } = createClient({ deleteError: { message: 'fk' } });
    mockCreateClient.mockResolvedValue(client);

    const response = await DELETE(request, { params: params() });
    expect(storageRemove).not.toHaveBeenCalled();

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

  describe('画像の後始末', () => {
    const withImages = (imageUrls: unknown) =>
      createClient({ existingLook: { data: { id: 1, status: 'published', image_urls: imageUrls }, error: null } });

    it('DD-LOOK-064 削除の存在確認は image_urls を読む', async () => {
      const { client, select } = withImages([]);
      mockCreateClient.mockResolvedValue(client);

      await DELETE(request, { params: params() });

      expect(select).toHaveBeenCalledWith('id,status,image_urls');
    });

    it('DD-LOOK-064 行を消した後に、自分の置き場の自分の道筋だけを置き場から消す', async () => {
      const { client, storageRemove } = withImages([
        'looks/2026-10-26/a.png',
        'e2e/look-1-1.png',
        'https://evil.example/looks/x.png',
        'looks/../x.png',
        'looks/2026-10-26/a.png',
        null,
        'https://project.supabase.co/storage/v1/object/public/look-images/looks/old/z.png',
      ]);
      mockCreateClient.mockResolvedValue(client);

      const response = await DELETE(request, { params: params() });

      expect(response.status).toBe(200);
      expect(client.storage.from).toHaveBeenCalledWith('look-images');
      expect(storageRemove).toHaveBeenCalledTimes(1);
      expect(storageRemove).toHaveBeenCalledWith(['looks/2026-10-26/a.png', 'looks/old/z.png']);
    });

    it('DD-LOOK-064 消す道筋が無ければ置き場を呼ばない', async () => {
      const { client, storageRemove } = withImages(['e2e/look-1-1.png']);
      mockCreateClient.mockResolvedValue(client);

      const response = await DELETE(request, { params: params() });

      expect(response.status).toBe(200);
      expect(storageRemove).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 置き場の削除が失敗しても 200 のままで、監査 metadata に image_cleanup と件数を残し、記録に置き場の文を出さない', async () => {
      const { client } = createClient({
        existingLook: { data: { id: 1, status: 'published', image_urls: ['looks/a.png', 'looks/b.png'] }, error: null },
        storageRemove: 'fail',
      });
      mockCreateClient.mockResolvedValue(client);

      const response = await DELETE(request, { params: params() });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(audits()[0]).toMatchObject({
        outcome: 'success',
        metadata: { deleted_status: 'published', image_cleanup: 'failed', orphaned_count: 2 },
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
    });

    it('DD-LOOK-064 置き場の削除が例外を投げても 200 のまま', async () => {
      const { client } = createClient({
        existingLook: { data: { id: 1, status: 'published', image_urls: ['looks/a.png'] }, error: null },
        storageRemove: 'throw',
      });
      mockCreateClient.mockResolvedValue(client);

      const response = await DELETE(request, { params: params() });

      expect(response.status).toBe(200);
      expect(audits()[0]).toMatchObject({ outcome: 'success' });
    });
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
