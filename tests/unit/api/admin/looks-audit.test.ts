export {};

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/look/services/admin-rate-limit', () => ({
  enforceAdminLookMutationRateLimit: jest.fn().mockResolvedValue(undefined),
  consumeAdminLookUploadQuota: jest.fn().mockResolvedValue(undefined),
  validateLookImageBatch: jest.fn().mockReturnValue(null),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
    }),
  },
}));

const { createServiceRoleClient: mockCreateServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { logAudit: mockLogAudit } = require('@/lib/audit');

const { minimalJpeg } = require('../../../fixtures/images');

const looksRoute = require('@/app/api/admin/looks/route');
const lookByIdRoute = require('@/app/api/admin/looks/[id]/route');

function createLooksServiceMock(options?: {
  existingLook?: { id: string; status?: string; image_urls?: string[] } | null;
  lookInsertId?: string;
  lookItemsInsertError?: { message: string } | null;
}) {
  const existingLook =
    options?.existingLook === undefined
      ? { id: '12', status: 'private', image_urls: [] }
      : options.existingLook;
  const lookInsertId = options?.lookInsertId ?? '10';
  const lookItemsInsertError = options?.lookItemsInsertError ?? null;

  const storageUpload = jest.fn().mockResolvedValue({ error: null });

  return {
    // LOOK の更新は admin_update_look の rpc 1 回。戻りは更新前の image_urls
    rpc: jest.fn().mockResolvedValue({ data: existingLook?.image_urls ?? [], error: null }),
    storage: {
      from: jest.fn().mockReturnValue({
        upload: storageUpload,
        remove: jest.fn().mockResolvedValue({ error: null }),
      }),
    },
    from: jest.fn((table: string) => {
      if (table === 'items') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({ data: [{ id: 1 }], error: null }),
          }),
        };
      }

      if (table === 'looks') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: { id: lookInsertId }, error: null }),
            }),
          }),
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue(
                existingLook
                  ? { data: existingLook, error: null }
                  : { data: null, error: null },
              ),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
          delete: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === 'look_items') {
        return {
          insert: jest.fn().mockResolvedValue({ error: lookItemsInsertError }),
          delete: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      return {};
    }),
  };
}

describe('admin look audit logging', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAuthorizeAdminPermission.mockResolvedValue({
      ok: true,
      userId: 'admin-user',
      role: 'admin',
      actorEmail: 'admin@example.com',
    });
  });

  test('DD-LOOK-065 POST logs successful look creation', async () => {
    mockCreateServiceRoleClient.mockResolvedValue(createLooksServiceMock());

    const formData = new FormData();
    formData.set('seasonYear', '2026');
    formData.set('seasonType', 'SS');
    formData.set('theme', 'Spring Light');
    formData.set('themeDescription', 'Desc');
    formData.set('status', 'published');
    formData.set('linkedItemIds', JSON.stringify([1]));
    const imageFile = new File([new Uint8Array(minimalJpeg())], 'look.jpg', { type: 'image/jpeg' });
    Object.defineProperty(imageFile, 'arrayBuffer', {
      value: jest.fn().mockResolvedValue(new Uint8Array(minimalJpeg()).buffer),
    });
    formData.append('images', imageFile);

    const request = new Request('http://localhost/api/admin/looks', {
      method: 'POST',
      headers: { 'user-agent': 'jest-test' },
    });
    Object.defineProperty(request, 'formData', {
      value: jest.fn().mockResolvedValue(formData),
    });

    const response = await looksRoute.POST(request);

    expect(response.status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.look.create',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'look',
        resource_id: '10',
        outcome: 'success',
        metadata: expect.objectContaining({
          status: 'published',
          linked_item_ids: [1],
        }),
      }),
    );
  });

  test('DD-LOOK-065 PUT logs successful look update', async () => {
    mockCreateServiceRoleClient.mockResolvedValue(
      createLooksServiceMock({
        existingLook: { id: '12', status: 'private', image_urls: [] },
      }),
    );

    const formData = new FormData();
    formData.set('seasonYear', '2026');
    formData.set('seasonType', 'AW');
    formData.set('theme', 'Autumn Dark');
    formData.set('themeDescription', 'Desc');
    formData.set('status', 'published');
    formData.set('linkedItemIds', JSON.stringify([1]));

    const request = new Request('http://localhost/api/admin/looks/12', {
      method: 'PUT',
      headers: { 'user-agent': 'jest-test' },
    });
    Object.defineProperty(request, 'formData', {
      value: jest.fn().mockResolvedValue(formData),
    });

    const response = await lookByIdRoute.PUT(request, {
      params: Promise.resolve({ id: '12' }),
    });

    expect(response.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.look.update',
        actor_id: 'admin-user',
        resource_id: '12',
        outcome: 'success',
        metadata: expect.objectContaining({
          previous_status: 'private',
          next_status: 'published',
          linked_item_ids: [1],
        }),
      }),
    );
  });

  test('DD-LOOK-065 PATCH logs successful status update', async () => {
    mockCreateServiceRoleClient.mockResolvedValue(
      createLooksServiceMock({
        existingLook: { id: '12', status: 'private', image_urls: [] },
      }),
    );

    const request = new Request('http://localhost/api/admin/looks/12', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'published' }),
      headers: { 'content-type': 'application/json', 'user-agent': 'jest-test' },
    });

    const response = await lookByIdRoute.PATCH(request, {
      params: Promise.resolve({ id: '12' }),
    });

    expect(response.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.look.status_update',
        actor_id: 'admin-user',
        resource_id: '12',
        outcome: 'success',
        metadata: expect.objectContaining({
          previous_status: 'private',
          next_status: 'published',
        }),
      }),
    );
  });

  test('DD-LOOK-065 DELETE logs failure when look does not exist', async () => {
    mockCreateServiceRoleClient.mockResolvedValue(
      createLooksServiceMock({
        existingLook: null,
      }),
    );

    const request = new Request('http://localhost/api/admin/looks/404', {
      method: 'DELETE',
      headers: { 'user-agent': 'jest-test' },
    });

    const response = await lookByIdRoute.DELETE(request, {
      params: Promise.resolve({ id: '404' }),
    });

    expect(response.status).toBe(404);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.look.delete',
        actor_id: 'admin-user',
        resource_id: '404',
        outcome: 'failure',
        detail: 'Look not found',
      }),
    );
  });
});

describe('logAdminLookAudit', () => {
  const { logAdminLookAudit } = require('@/features/look/services/admin-audit');

  beforeEach(() => {
    jest.resetAllMocks();
    mockLogAudit.mockResolvedValue(undefined);
  });

  test('DD-LOOK-065 全部の値を resource look に固定して logAudit へ渡す', async () => {
    const request = new Request('http://localhost/api/admin/looks', {
      headers: { 'user-agent': 'jest-agent' },
    });

    await logAdminLookAudit({
      request,
      actorId: 'admin-user',
      actorEmail: 'admin@example.com',
      action: 'admin.look.create',
      outcome: 'success',
      detail: 'Look created',
      resourceId: 5,
      metadata: { status: 'published' },
    });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.look.create',
      actor_id: 'admin-user',
      actor_email: 'admin@example.com',
      resource: 'look',
      resource_id: '5',
      outcome: 'success',
      detail: 'Look created',
      user_agent: 'jest-agent',
      metadata: { status: 'published' },
    });
  });

  test('DD-LOOK-065 resourceId・metadata・user-agent が無い時は null にそろえる', async () => {
    const request = new Request('http://localhost/api/admin/looks');

    await logAdminLookAudit({
      request,
      actorId: 'admin-user',
      actorEmail: null,
      action: 'admin.look.delete',
      outcome: 'failure',
      detail: 'Look not found',
    });

    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.look.delete',
      actor_id: 'admin-user',
      actor_email: null,
      resource: 'look',
      resource_id: null,
      outcome: 'failure',
      detail: 'Look not found',
      user_agent: null,
      metadata: null,
    });
  });

  test('DD-LOOK-065 resourceId が null の時は resource_id を null にする', async () => {
    const request = new Request('http://localhost/api/admin/looks', {
      headers: { 'user-agent': 'jest-agent' },
    });

    await logAdminLookAudit({
      request,
      actorId: 'admin-user',
      actorEmail: 'admin@example.com',
      action: 'admin.look.create',
      outcome: 'failure',
      detail: 'Failed',
      resourceId: null,
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: null, user_agent: 'jest-agent' }),
    );
  });

  test('DD-LOOK-065 user-agent が空の時は null にし、文字の resourceId はそのまま渡す', async () => {
    const request = new Request('http://localhost/api/admin/looks', {
      headers: { 'user-agent': '' },
    });

    await logAdminLookAudit({
      request,
      actorId: 'admin-user',
      actorEmail: 'admin@example.com',
      action: 'admin.look.update',
      outcome: 'success',
      detail: 'Look updated',
      resourceId: 'abc',
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: 'abc', user_agent: null }),
    );
  });

  test('DD-LOOK-065 resourceId が 0 でも null にせず文字の 0 にする', async () => {
    const request = new Request('http://localhost/api/admin/looks');

    await logAdminLookAudit({
      request,
      actorId: 'admin-user',
      actorEmail: null,
      action: 'admin.look.update',
      outcome: 'success',
      detail: 'Look updated',
      resourceId: 0,
    });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: '0' }));
  });

  test('DD-LOOK-065 logAudit の戻り値をそのまま返す', async () => {
    mockLogAudit.mockResolvedValue('logged');
    const request = new Request('http://localhost/api/admin/looks');

    await expect(
      logAdminLookAudit({
        request,
        actorId: 'admin-user',
        actorEmail: null,
        action: 'admin.look.create',
        outcome: 'success',
        detail: 'ok',
      }),
    ).resolves.toBe('logged');
  });
});
