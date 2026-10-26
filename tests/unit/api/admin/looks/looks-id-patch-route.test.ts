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

const { PATCH } = require('@/app/api/admin/looks/[id]/route');

type Result = { data?: unknown; error?: unknown };

function createClient(options: { existingLook?: Result; updateError?: unknown } = {}) {
  const update = jest.fn();
  const updateEq = jest.fn().mockResolvedValue({ error: options.updateError ?? null });
  const select = jest.fn();
  const client = {
    from: jest.fn(() => ({
      select: select.mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: jest.fn().mockResolvedValue(
            options.existingLook ?? { data: { id: 1, status: 'private' }, error: null },
          ),
        }),
      }),
      update: update.mockReturnValue({ eq: updateEq }),
    })),
  };
  return { client, update, updateEq, select };
}

function createRequest(body: unknown) {
  return {
    json: body instanceof Error ? jest.fn().mockRejectedValue(body) : jest.fn().mockResolvedValue(body),
    headers: new Headers(),
  } as unknown as Request;
}

const params = () => Promise.resolve({ id: '1' });
const audits = () => mockAudit.mock.calls.map((call: unknown[]) => call[0]);

describe('DD-LOOK-064 PATCH /api/admin/looks/[id]', () => {
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

  it('DD-LOOK-064 切り替えの認可が失敗したら認可の応答を返し、回数も監査も触れない', async () => {
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });
    const request = createRequest({ status: 'published' });

    const response = await PATCH(request, { params: params() });

    expect(response).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.looks.manage', request);
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 切り替えの回数が超過したら 429 を返し、本文も DB も監査も触れない', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    mockEnforce.mockResolvedValue(limited);
    const request = createRequest({ status: 'published' });

    const response = await PATCH(request, { params: params() });

    expect(response).toBe(limited);
    expect(mockEnforce).toHaveBeenCalledWith({ request, actorId: 'admin-1', kind: 'status' });
    expect(request.json).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 切り替えの状態の形の誤り（draft）は 400 Invalid request と監査 Invalid status payload', async () => {
    const response = await PATCH(createRequest({ status: 'draft' }), { params: params() });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid request');
    expect(body.details.fieldErrors.status).toBeDefined();
    expect(audits()).toEqual([
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Invalid status payload',
        resourceId: '1',
        metadata: { invalid_fields: ['status'] },
      }),
    ]);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 切り替えの本文が JSON でない時は 500 でなく 400 Invalid request と監査 Invalid JSON で、更新しない', async () => {
    const { client, update } = createClient();
    mockCreateClient.mockResolvedValue(client);

    const response = await PATCH(createRequest(new SyntaxError('Unexpected token x')), { params: params() });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
    expect(audits()).toEqual([
      expect.objectContaining({
        actorId: 'admin-1',
        actorEmail: 'a@example.com',
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Invalid JSON',
        resourceId: '1',
      }),
    ]);
    expect(update).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it.each(['abc', '1e3', '0', '-1', '1.5'])(
    'DD-LOOK-064 id が %s の時は認可と回数の後で 400 Invalid look id と監査（id の生の値は残さず長さだけ）で、DB も本文も読まない',
    async (badId) => {
      const request = createRequest({ status: 'published' });

      const response = await PATCH(request, { params: Promise.resolve({ id: badId }) });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid look id' });
      expect(audits()).toEqual([
        expect.objectContaining({
          action: 'admin.look.status_update',
          outcome: 'failure',
          detail: 'Invalid look id',
          metadata: { id_length: badId.length },
        }),
      ]);
      expect(audits()[0].resourceId).toBeUndefined();
      expect(request.json).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
    },
  );

  it('DD-LOOK-064 id が不正でも認可が通らなければ今までの 403 を返す（id の検査より先）', async () => {
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await PATCH(createRequest({ status: 'published' }), { params: Promise.resolve({ id: 'abc' }) });

    expect(response).toBe(denied);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 切り替えの存在確認が DB の失敗なら 500 と監査 Failed to fetch look で、更新しない', async () => {
    const { client, update } = createClient({
      existingLook: { data: null, error: Object.assign(new Error('boom SECRET'), { code: '57014' }) },
    });
    mockCreateClient.mockResolvedValue(client);

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch look' });
    expect(audits()).toEqual([expect.objectContaining({ outcome: 'failure', detail: 'Failed to fetch look' })]);
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch look:', { name: 'Error', code: '57014' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
    expect(update).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 切り替えの無い LOOK（maybeSingle が null）は 404 と監査 Look not found', async () => {
    const { client, update } = createClient({ existingLook: { data: null, error: null } });
    mockCreateClient.mockResolvedValue(client);

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Look not found' });
    expect(audits()).toEqual([
      expect.objectContaining({
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Look not found',
        resourceId: '1',
      }),
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('DD-LOOK-064 切り替えの行が null で error も無い時も 404', async () => {
    const { client } = createClient({ existingLook: { data: null, error: null } });
    mockCreateClient.mockResolvedValue(client);

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(404);
  });

  it('DD-LOOK-064 切り替えの更新が失敗したら 500 Failed to update status と監査 Failed to update look status', async () => {
    const { client } = createClient({ updateError: { message: 'x' } });
    mockCreateClient.mockResolvedValue(client);

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update status' });
    expect(audits()).toEqual([
      expect.objectContaining({
        detail: 'Failed to update look status',
        resourceId: '1',
        metadata: { previous_status: 'private', next_status: 'published' },
      }),
    ]);
  });

  it('DD-LOOK-064 切り替えの成功は状態の列だけを更新し、監査 success に前と次の状態を残す', async () => {
    const { client, update, updateEq } = createClient();
    mockCreateClient.mockResolvedValue(client);

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(update).toHaveBeenCalledWith({ status: 'published' });
    expect(updateEq).toHaveBeenCalledWith('id', '1');
    expect(audits()).toEqual([
      {
        request: expect.anything(),
        actorId: 'admin-1',
        actorEmail: 'a@example.com',
        action: 'admin.look.status_update',
        outcome: 'success',
        detail: 'Look status updated',
        resourceId: '1',
        metadata: { previous_status: 'private', next_status: 'published' },
      },
    ]);
  });

  it('DD-LOOK-064 切り替えは前と同じ状態でも成功として残す', async () => {
    const { client } = createClient({ existingLook: { data: { id: 1, status: 'published' }, error: null } });
    mockCreateClient.mockResolvedValue(client);

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(200);
    expect(audits()[0]).toMatchObject({
      outcome: 'success',
      metadata: { previous_status: 'published', next_status: 'published' },
    });
  });

  it('DD-LOOK-064 切り替えの例外（操作者あり）は 500 Internal server error と監査 Unexpected status update error', async () => {
    mockEnforce.mockRejectedValue(new Error('counter down'));

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(audits()).toEqual([
      expect.objectContaining({
        actorId: 'admin-1',
        actorEmail: 'a@example.com',
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Unexpected status update error',
        metadata: undefined,
      }),
    ]);
  });

  it('DD-LOOK-064 切り替えの例外（操作者なし＝認可が投げる）は 500 で監査を残さない', async () => {
    mockAuthorize.mockRejectedValue(new Error('rbac down'));

    const response = await PATCH(createRequest({ status: 'published' }), { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
