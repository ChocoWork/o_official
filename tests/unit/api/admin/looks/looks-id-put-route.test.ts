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
const {
  consumeAdminLookUploadQuota: mockConsumeQuota,
  enforceAdminLookMutationRateLimit: mockEnforce,
  validateLookImageBatch: mockValidateBatch,
} = require('@/features/look/services/admin-rate-limit');
const { logAdminLookAudit: mockAudit } = require('@/features/look/services/admin-audit');

const { PUT } = require('@/app/api/admin/looks/[id]/route');

type Result = { data?: unknown; error?: unknown };

interface ClientOptions {
  existingLook?: Result;
  items?: Result;
  uploadError?: { message: string } | null;
  updateError?: unknown;
  deleteItemsError?: unknown;
  insertItemsError?: unknown;
}

function createClient(options: ClientOptions = {}) {
  const upload = jest.fn().mockResolvedValue({ error: options.uploadError ?? null });
  const lookUpdate = jest.fn();
  const lookItemsDelete = jest.fn();
  const lookItemsInsert = jest.fn().mockResolvedValue({ error: options.insertItemsError ?? null });
  const itemsIn = jest.fn().mockResolvedValue(options.items ?? { data: [{ id: 1 }], error: null });
  const client = {
    storage: { from: jest.fn().mockReturnValue({ upload }) },
    from: jest.fn((table: string) => {
      if (table === 'looks') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue(
                options.existingLook ?? {
                  data: { id: 1, status: 'private', image_urls: ['looks/old.jpg'] },
                  error: null,
                },
              ),
            }),
          }),
          update: lookUpdate.mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: options.updateError ?? null }),
          }),
        };
      }
      if (table === 'items') {
        return { select: jest.fn().mockReturnValue({ in: itemsIn }) };
      }
      return {
        delete: lookItemsDelete.mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: options.deleteItemsError ?? null }),
        }),
        insert: lookItemsInsert,
      };
    }),
  };
  return { client, upload, lookUpdate, lookItemsDelete, lookItemsInsert, itemsIn };
}

function createImage(name: string, type: string, size?: number) {
  const file = new File(['image-bytes'], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    value: jest.fn().mockResolvedValue(new TextEncoder().encode('image-bytes').buffer),
  });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
}

function createForm(overrides: Record<string, string | null> = {}, images: File[] = []) {
  const fields: Record<string, string | null> = {
    seasonYear: '2026',
    seasonType: 'SS',
    theme: 'Spring Light',
    themeDescription: 'Desc',
    status: 'published',
    linkedItemIds: JSON.stringify([1]),
    ...overrides,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) {
      formData.set(key, value);
    }
  }
  for (const image of images) {
    formData.append('images', image);
  }
  return formData;
}

function createRequest(formData: FormData) {
  return { formData: async () => formData, headers: new Headers() } as unknown as Request;
}

const params = () => Promise.resolve({ id: '1' });
const audits = () => mockAudit.mock.calls.map((call: unknown[]) => call[0]);

describe('DD-LOOK-064 PUT /api/admin/looks/[id]', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'a@example.com' });
    mockEnforce.mockResolvedValue(undefined);
    mockConsumeQuota.mockResolvedValue(undefined);
    mockValidateBatch.mockReturnValue(null);
    mockAudit.mockResolvedValue(undefined);
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...(globalThis.crypto ?? {}), randomUUID: () => 'uuid-fixed' },
        configurable: true,
      });
    }
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('認可と回数', () => {
    it('DD-LOOK-064 更新の認可が失敗したら認可の応答を返し、回数も監査も触れない', async () => {
      const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
      mockAuthorize.mockResolvedValue({ ok: false, response: denied });
      const request = createRequest(createForm());

      const response = await PUT(request, { params: params() });

      expect(response).toBe(denied);
      expect(mockAuthorize).toHaveBeenCalledWith('admin.looks.manage', request);
      expect(mockEnforce).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の回数が超過したら 429 を返し、監査も DB も触れない', async () => {
      const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
      mockEnforce.mockResolvedValue(limited);
      const request = createRequest(createForm());

      const response = await PUT(request, { params: params() });

      expect(response).toBe(limited);
      expect(mockEnforce).toHaveBeenCalledWith({ request, actorId: 'admin-1', kind: 'update' });
      expect(mockAudit).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の数え場所の失敗（503）もそのまま返す', async () => {
      const unavailable = { status: 503, json: async () => ({ error: 'Rate limit unavailable' }) };
      mockEnforce.mockResolvedValue(unavailable);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(503);
      expect(mockAudit).not.toHaveBeenCalled();
    });
  });

  describe('入力の誤り', () => {
    it.each([
      ['欄が無い', null],
      ['JSON でない', 'not-json'],
      ['配列の中身が数でない', '["a"]'],
      ['配列でない', '"x"'],
    ])(
      'DD-LOOK-064 更新の linkedItemIds（%s）は 400 Invalid request と監査 Invalid update payload（id なし）',
      async (_label, value) => {
        const response = await PUT(createRequest(createForm({ linkedItemIds: value })), { params: params() });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('Invalid request');
        expect(audits()).toHaveLength(1);
        expect(audits()[0]).toMatchObject({
          actorId: 'admin-1',
          actorEmail: 'a@example.com',
          action: 'admin.look.update',
          outcome: 'failure',
          detail: 'Invalid update payload',
        });
        expect(audits()[0].resourceId).toBeUndefined();
        expect(mockCreateClient).not.toHaveBeenCalled();
      },
    );

    it('DD-LOOK-064 更新の欄の形の誤り（theme が空）は 400 と誤りの欄の名前を監査に残す', async () => {
      const response = await PUT(createRequest(createForm({ theme: '' })), { params: params() });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request');
      expect(body.details.fieldErrors.theme).toBeDefined();
      expect(audits()).toEqual([
        expect.objectContaining({
          action: 'admin.look.update',
          outcome: 'failure',
          detail: 'Invalid update payload',
          resourceId: '1',
          metadata: { invalid_fields: ['theme'] },
        }),
      ]);
    });

    it('DD-LOOK-064 更新の商品が0件（linkedItemIds が空配列）は 400', async () => {
      const response = await PUT(createRequest(createForm({ linkedItemIds: '[]' })), { params: params() });

      expect(response.status).toBe(400);
      expect(audits()[0].metadata).toEqual({ invalid_fields: ['linkedItemIds'] });
    });

    it('DD-LOOK-064 更新で themeDescription が無くても空の文字として通る', async () => {
      const { client, lookUpdate } = createClient();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({ themeDescription: null })), { params: params() });

      expect(response.status).toBe(200);
      expect(lookUpdate).toHaveBeenCalledWith(expect.objectContaining({ theme_description: '' }));
    });

    it('DD-LOOK-064 更新の画像の枚数・合計の誤りは 400 でその文を返し、監査にも同じ文と枚数を残す', async () => {
      mockValidateBatch.mockReturnValue('Too many images');
      const images = [createImage('a.png', 'image/png'), createImage('b.png', 'image/png')];

      const response = await PUT(createRequest(createForm({}, images)), { params: params() });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Too many images' });
      expect(mockValidateBatch).toHaveBeenCalledWith(images);
      expect(audits()).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          detail: 'Too many images',
          resourceId: '1',
          metadata: { image_count: 2 },
        }),
      ]);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の画像の申告の種類が4つ以外（text/plain）は 400 Unsupported image type', async () => {
      const response = await PUT(createRequest(createForm({}, [createImage('a.txt', 'text/plain')])), {
        params: params(),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Unsupported image type' });
      expect(audits()[0]).toMatchObject({
        detail: 'Unsupported image type',
        resourceId: '1',
        metadata: { image_type: 'text/plain' },
      });
    });

    it('DD-LOOK-064 更新の画像が 5MB を超える（5MB+1）と 400 Image size must be 5MB or less', async () => {
      const big = createImage('a.png', 'image/png', 5 * 1024 * 1024 + 1);

      const response = await PUT(createRequest(createForm({}, [big])), { params: params() });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Image size must be 5MB or less' });
      expect(audits()[0]).toMatchObject({
        detail: 'Image size limit exceeded',
        metadata: { image_size: 5 * 1024 * 1024 + 1, image_type: 'image/png' },
      });
    });

    it('DD-LOOK-064 更新の画像がちょうど 5MB なら通る', async () => {
      const { client } = createClient();
      mockCreateClient.mockResolvedValue(client);
      const edge = createImage('a.png', 'image/png', 5 * 1024 * 1024);

      const response = await PUT(createRequest(createForm({}, [edge])), { params: params() });

      expect(response.status).toBe(200);
    });

    it('DD-LOOK-064 更新で images の欄に文字が来ても画像として数えない', async () => {
      const { client, upload } = createClient();
      mockCreateClient.mockResolvedValue(client);
      const formData = createForm();
      formData.append('images', 'just-text');

      const response = await PUT(createRequest(formData), { params: params() });

      expect(response.status).toBe(200);
      expect(mockValidateBatch).toHaveBeenCalledWith([]);
      expect(upload).not.toHaveBeenCalled();
    });
  });

  describe('今の LOOK と商品の照らし', () => {
    it('DD-LOOK-064 更新の今の LOOK が無い時（single が error）は 404 と監査 Look not found', async () => {
      const { client, lookUpdate } = createClient({ existingLook: { data: null, error: { message: 'none' } } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Look not found' });
      expect(audits()).toEqual([
        expect.objectContaining({ detail: 'Look not found', resourceId: '1', outcome: 'failure' }),
      ]);
      expect(lookUpdate).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の今の LOOK の行が null で error も無い時も 404', async () => {
      const { client } = createClient({ existingLook: { data: null, error: null } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(404);
    });

    it('DD-LOOK-064 更新の商品の照らしが失敗したら 500 Failed to validate linked items', async () => {
      const { client } = createClient({ items: { data: null, error: { message: 'boom' } } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to validate linked items' });
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to validate linked items',
        metadata: { linked_item_ids: [1], status: 'published' },
      });
      expect(mockConsumeQuota).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の商品の数が合わない時は 400 Some linked items do not exist', async () => {
      const { client } = createClient({ items: { data: [{ id: 1 }], error: null } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({ linkedItemIds: '[1,2]' })), { params: params() });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Some linked items do not exist' });
      expect(audits()[0]).toMatchObject({
        detail: 'Some linked items do not exist',
        metadata: { linked_item_ids: [1, 2], status: 'published' },
      });
    });

    it('DD-LOOK-064 更新の商品の照らしの data が null の時も 400 Some linked items do not exist', async () => {
      const { client } = createClient({ items: { data: null, error: null } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Some linked items do not exist' });
    });
  });

  describe('1時間の量', () => {
    it('DD-LOOK-064 更新の1時間の量が超過したら 429 を返し、監査も書き込みもしない', async () => {
      const { client, lookUpdate, upload } = createClient();
      mockCreateClient.mockResolvedValue(client);
      const limited = { status: 429, json: async () => ({ error: 'Upload quota exceeded' }) };
      mockConsumeQuota.mockResolvedValue(limited);

      const response = await PUT(createRequest(createForm({}, [createImage('a.png', 'image/png', 100)])), {
        params: params(),
      });

      expect(response).toBe(limited);
      expect(mockConsumeQuota).toHaveBeenCalledWith({ actorId: 'admin-1', kind: 'update', totalBytes: 100 });
      expect(mockAudit).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(lookUpdate).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 画像なしの更新は 0 バイトを量の部品に渡して更新を進める（0 を数えない決まりは量の部品が持つ）', async () => {
      const { client } = createClient();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(200);
      expect(mockConsumeQuota).toHaveBeenCalledWith({ actorId: 'admin-1', kind: 'update', totalBytes: 0 });
    });
  });

  describe('保存', () => {
    it('DD-LOOK-064 更新（画像なし）は今の image_urls の並びのまま上げ直さずに更新する', async () => {
      const { client, upload, lookUpdate, lookItemsDelete, lookItemsInsert } = createClient();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(upload).not.toHaveBeenCalled();
      expect(lookUpdate).toHaveBeenCalledWith({
        season_year: 2026,
        season_type: 'SS',
        theme: 'Spring Light',
        theme_description: 'Desc',
        image_urls: ['looks/old.jpg'],
        status: 'published',
      });
      expect(lookItemsDelete).toHaveBeenCalled();
      expect(lookItemsInsert).toHaveBeenCalledWith([{ look_id: 1, item_id: 1 }]);
    });

    it('DD-LOOK-064 更新（画像なし）で今の image_urls が配列でない時は空のまま更新する', async () => {
      const { client, lookUpdate } = createClient({
        existingLook: { data: { id: 1, status: 'private', image_urls: null }, error: null },
      });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(200);
      expect(lookUpdate).toHaveBeenCalledWith(expect.objectContaining({ image_urls: [] }));
      expect(audits()[0].metadata.image_count).toBe(0);
    });

    it('DD-LOOK-064 更新（画像あり）は全部を置き場に上げ、並びを差し替える。拡張子が無ければ jpg', async () => {
      const { client, upload, lookUpdate } = createClient();
      mockCreateClient.mockResolvedValue(client);
      const images = [createImage('a.png', 'image/png'), createImage('noext', 'image/webp')];

      const response = await PUT(createRequest(createForm({}, images)), { params: params() });

      expect(response.status).toBe(200);
      expect(client.storage.from).toHaveBeenCalledWith('look-images');
      expect(upload).toHaveBeenCalledTimes(2);
      const firstPath: string = upload.mock.calls[0][0];
      const secondPath: string = upload.mock.calls[1][0];
      expect(firstPath).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/.+\.png$/);
      expect(secondPath).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/.+\.jpg$/);
      expect(upload.mock.calls[0][2]).toEqual({ contentType: 'image/png', cacheControl: '3600', upsert: false });
      expect(upload.mock.calls[1][2]).toEqual(expect.objectContaining({ contentType: 'image/webp' }));
      const { image_urls: imageUrls } = lookUpdate.mock.calls[0][0];
      expect(imageUrls).toEqual([firstPath, secondPath]);
      expect(imageUrls).not.toContain('looks/old.jpg');
      expect(audits()[0].metadata.image_count).toBe(2);
    });

    it('DD-LOOK-064 更新の置き場の失敗は 500 Failed to upload image と監査 Failed to upload look image', async () => {
      const { client, lookUpdate } = createClient({ uploadError: { message: 'bucket down' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, [createImage('a.png', 'image/png')])), {
        params: params(),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to upload image: bucket down' });
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to upload look image',
        resourceId: '1',
        metadata: { image_type: 'image/png', storage_path: expect.stringMatching(/^looks\//) },
      });
      expect(lookUpdate).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の looks の更新が失敗したら 500 Failed to update look で関連には触れない', async () => {
      const { client, lookItemsDelete } = createClient({ updateError: { message: 'x' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to update look' });
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to update look',
        metadata: { status: 'published', linked_item_ids: [1] },
      });
      expect(lookItemsDelete).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の関連の削除が失敗したら 500 Failed to update linked items と監査 Failed to replace look-item links', async () => {
      const { client, lookItemsInsert } = createClient({ deleteItemsError: { message: 'x' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to update linked items' });
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to replace look-item links',
        metadata: { linked_item_ids: [1] },
      });
      expect(lookItemsInsert).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の関連の追加が失敗したら 500 Failed to update linked items と監査 Failed to update look-item links', async () => {
      const { client } = createClient({ insertItemsError: { message: 'x' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to update linked items' });
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to update look-item links',
        metadata: { linked_item_ids: [1] },
      });
    });

    it('DD-LOOK-064 更新の成功は監査 success に前の状態・次の状態・関連・枚数・シーズンを残す', async () => {
      const { client } = createClient();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(200);
      expect(audits()).toEqual([
        {
          request: expect.anything(),
          actorId: 'admin-1',
          actorEmail: 'a@example.com',
          action: 'admin.look.update',
          outcome: 'success',
          detail: 'Look updated',
          resourceId: '1',
          metadata: {
            previous_status: 'private',
            next_status: 'published',
            linked_item_ids: [1],
            image_count: 1,
            season_year: 2026,
            season_type: 'SS',
          },
        },
      ]);
    });

    it('DD-LOOK-064 更新の成功で前の状態が空なら監査の previous_status は null', async () => {
      const { client } = createClient({
        existingLook: { data: { id: 1, status: null, image_urls: [] }, error: null },
      });
      mockCreateClient.mockResolvedValue(client);

      await PUT(createRequest(createForm()), { params: params() });

      expect(audits()[0].metadata.previous_status).toBeNull();
    });
  });

  describe('例外', () => {
    it('DD-LOOK-064 更新の例外（操作者あり）は 500 Internal server error と監査 Unexpected update error', async () => {
      mockEnforce.mockRejectedValue(new Error('counter down'));

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(audits()).toEqual([
        expect.objectContaining({
          actorId: 'admin-1',
          actorEmail: 'a@example.com',
          outcome: 'failure',
          detail: 'Unexpected update error',
          metadata: undefined,
        }),
      ]);
    });

    it('DD-LOOK-064 更新の例外（操作者なし＝認可が投げる）は 500 で監査を残さない', async () => {
      mockAuthorize.mockRejectedValue(new Error('rbac down'));

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(mockAudit).not.toHaveBeenCalled();
    });
  });
});
