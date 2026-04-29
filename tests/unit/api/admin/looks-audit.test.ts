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
    storage: {
      from: jest.fn().mockReturnValue({
        upload: storageUpload,
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
              single: jest.fn().mockResolvedValue(
                existingLook
                  ? { data: existingLook, error: null }
                  : { data: null, error: { message: 'not found' } },
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

  test('POST logs successful look creation', async () => {
    mockCreateServiceRoleClient.mockResolvedValue(createLooksServiceMock());

    const formData = new FormData();
    formData.set('seasonYear', '2026');
    formData.set('seasonType', 'SS');
    formData.set('theme', 'Spring Light');
    formData.set('themeDescription', 'Desc');
    formData.set('status', 'published');
    formData.set('linkedItemIds', JSON.stringify([1]));
    const imageFile = new File(['image-bytes'], 'look.jpg', { type: 'image/jpeg' });
    Object.defineProperty(imageFile, 'arrayBuffer', {
      value: jest.fn().mockResolvedValue(new TextEncoder().encode('image-bytes').buffer),
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

  test('PUT logs successful look update', async () => {
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

  test('PATCH logs successful status update', async () => {
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

  test('DELETE logs failure when look does not exist', async () => {
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