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
const {
  consumeAdminLookUploadQuota: mockConsumeQuota,
  enforceAdminLookMutationRateLimit: mockEnforce,
  validateLookImageBatch: mockValidateBatch,
} = require('@/features/look/services/admin-rate-limit');
const { logAdminLookAudit: mockAudit } = require('@/features/look/services/admin-audit');

const { PUT } = require('@/app/api/admin/looks/[id]/route');
const { minimalGif, minimalJpeg, minimalPng, minimalWebp, textAsImage } = require('../../../../fixtures/images');

type Result = { data?: unknown; error?: unknown };

interface ClientOptions {
  existingLook?: Result;
  items?: Result;
  uploadError?: { message: string } | null;
  /** 何回目（0 始まり）の上げで失敗させるか。既定は全部 */
  failUploadAt?: number;
  storageRemove?: 'fail' | 'throw';
  /** admin_update_look の戻り（更新前の image_urls）。既定は ['looks/old.jpg'] */
  previousImages?: unknown;
  /** admin_update_look の失敗 */
  rpcError?: { code?: string; message: string };
}

function createClient(options: ClientOptions = {}) {
  const upload = jest.fn().mockImplementation(async () => {
    const callIndex = upload.mock.calls.length - 1;
    const failing = options.uploadError && (options.failUploadAt === undefined || options.failUploadAt === callIndex);
    return { error: failing ? options.uploadError : null };
  });
  const storageRemove = jest.fn().mockImplementation(async () => {
    if (options.storageRemove === 'throw') throw new Error('storage down');
    return { error: options.storageRemove === 'fail' ? { message: 'storage SECRET' } : null };
  });
  const select = jest.fn();
  const lookUpdate = jest.fn();
  const lookItemsDelete = jest.fn();
  const lookItemsInsert = jest.fn();
  const rpc = jest.fn().mockResolvedValue(
    options.rpcError
      ? { data: null, error: options.rpcError }
      : { data: 'previousImages' in options ? options.previousImages : ['looks/old.jpg'], error: null },
  );
  const itemsIn = jest.fn().mockResolvedValue(options.items ?? { data: [{ id: 1 }], error: null });
  const client = {
    rpc,
    storage: { from: jest.fn().mockReturnValue({ upload, remove: storageRemove }) },
    from: jest.fn((table: string) => {
      if (table === 'looks') {
        return {
          select: select.mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue(
                options.existingLook ?? {
                  data: { id: 1, status: 'private', image_urls: ['looks/old.jpg'] },
                  error: null,
                },
              ),
            }),
          }),
          update: lookUpdate,
        };
      }
      if (table === 'items') {
        return { select: jest.fn().mockReturnValue({ in: itemsIn }) };
      }
      return {
        delete: lookItemsDelete,
        insert: lookItemsInsert,
      };
    }),
  };
  return { client, upload, storageRemove, select, rpc, lookUpdate, lookItemsDelete, lookItemsInsert, itemsIn };
}

const IMAGE_BYTES: Record<string, () => Buffer> = {
  'image/jpeg': minimalJpeg,
  'image/png': minimalPng,
  'image/webp': minimalWebp,
  'image/gif': minimalGif,
};

// 申告の種類に合う本物の先頭の印を持つ画像。bytes を渡すと中身をそれにする（申告とずらす試験用）。
function createImage(name: string, type: string, size?: number, bytes?: Buffer) {
  const content: Buffer = bytes ?? (IMAGE_BYTES[type]?.() ?? textAsImage());
  const file = new File([new Uint8Array(content)], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    value: jest.fn().mockResolvedValue(new Uint8Array(content).buffer),
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

  describe('id の確かめ', () => {
    it.each(['abc', '1e3', '0', '-1', '1.5'])(
      'DD-LOOK-064 id が %s の時は認可と回数の後で 400 Invalid look id と監査（id の生の値は残さず長さだけ）で、DB を呼ばない',
      async (badId) => {
        const response = await PUT(createRequest(createForm()), { params: Promise.resolve({ id: badId }) });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid look id' });
        expect(audits()).toEqual([
          expect.objectContaining({
            action: 'admin.look.update',
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

      const response = await PUT(createRequest(createForm()), { params: Promise.resolve({ id: 'abc' }) });

      expect(response).toBe(denied);
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
      const { client, rpc } = createClient();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({ themeDescription: null })), { params: params() });

      expect(response.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith('admin_update_look', expect.objectContaining({ _theme_description: '' }));
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

    it('DD-LOOK-064 文字のファイルを image/png と申告すると 400 で、置き場にも量の枠にも触れず、中身もファイル名も監査に残さない', async () => {
      const { client, upload } = createClient();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(
        createRequest(createForm({}, [createImage('secret-name.png', 'image/png', undefined, textAsImage())])),
        { params: params() },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Unsupported image type' });
      expect(upload).not.toHaveBeenCalled();
      expect(mockConsumeQuota).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(audits()[0]).toMatchObject({ detail: 'Unsupported image type', resourceId: '1' });
      const audited = JSON.stringify(audits().map((entry: { request?: unknown }) => ({ ...entry, request: undefined })));
      expect(audited).not.toContain('secret-name');
      expect(audited).not.toContain('plain text');
    });

    it('DD-LOOK-064 PNG の中身を image/webp と申告しても 400 になる', async () => {
      const response = await PUT(
        createRequest(createForm({}, [createImage('a.webp', 'image/webp', undefined, minimalPng())])),
        { params: params() },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Unsupported image type' });
      expect(mockConsumeQuota).not.toHaveBeenCalled();
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
    it('DD-LOOK-064 更新の今の LOOK の取り出しが DB の失敗なら 500 と監査 Failed to fetch look で、書き込まない', async () => {
      const { client, lookUpdate, upload } = createClient({
        existingLook: { data: null, error: Object.assign(new Error('boom SECRET'), { code: '57014' }) },
      });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, [createImage('a.png', 'image/png')])), {
        params: params(),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to fetch look' });
      expect(audits()).toEqual([
        expect.objectContaining({ detail: 'Failed to fetch look', resourceId: '1', outcome: 'failure' }),
      ]);
      expect(errorSpy).toHaveBeenCalledWith('Failed to fetch look:', { name: 'Error', code: '57014' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
      expect(lookUpdate).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新の今の LOOK が無い時（maybeSingle が null）は 404 と監査 Look not found で、何も上げない', async () => {
      const { client, lookUpdate, upload } = createClient({ existingLook: { data: null, error: null } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Look not found' });
      expect(audits()).toEqual([
        expect.objectContaining({ detail: 'Look not found', resourceId: '1', outcome: 'failure' }),
      ]);
      expect(lookUpdate).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
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
    it('DD-LOOK-064 更新は admin_update_look の rpc 1 回で、looks の update・look_items の delete/insert を呼ばない', async () => {
      const { client, upload, rpc, lookUpdate, lookItemsDelete, lookItemsInsert } = createClient();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(upload).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith('admin_update_look', {
        _look_id: 1,
        _season_year: 2026,
        _season_type: 'SS',
        _theme: 'Spring Light',
        _theme_description: 'Desc',
        _image_urls: null,
        _status: 'published',
        _item_ids: [1],
      });
      expect(lookUpdate).not.toHaveBeenCalled();
      expect(lookItemsDelete).not.toHaveBeenCalled();
      expect(lookItemsInsert).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新（画像なし）は _image_urls に NULL を渡し、今の画像を関数に保たせる（先に読んだ値は渡さない）', async () => {
      const { client, rpc } = createClient({
        existingLook: { data: { id: 1, status: 'private', image_urls: ['looks/read-before.jpg'] }, error: null },
      });
      mockCreateClient.mockResolvedValue(client);

      await PUT(createRequest(createForm()), { params: params() });

      expect(rpc.mock.calls[0][1]._image_urls).toBeNull();
    });

    it('DD-LOOK-064 更新（画像なし）で rpc の戻りが null でも落ちず、置き場を呼ばず、監査の枚数は 0', async () => {
      const { client, storageRemove } = createClient({ previousImages: null });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(200);
      expect(audits()[0].metadata.image_count).toBe(0);
      expect(storageRemove).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 更新（画像あり）は全部を置き場に上げ、並びを差し替える。保存名は検出した種類から作る', async () => {
      const { client, upload, rpc } = createClient();
      mockCreateClient.mockResolvedValue(client);
      const images = [createImage('a/b.html', 'image/png'), createImage('noext', 'image/webp')];

      const response = await PUT(createRequest(createForm({}, images)), { params: params() });

      expect(response.status).toBe(200);
      expect(client.storage.from).toHaveBeenCalledWith('look-images');
      expect(upload).toHaveBeenCalledTimes(2);
      const firstPath: string = upload.mock.calls[0][0];
      const secondPath: string = upload.mock.calls[1][0];
      expect(firstPath).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
      expect(secondPath).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.webp$/);
      expect(upload.mock.calls[0][2]).toEqual({ contentType: 'image/png', cacheControl: '3600', upsert: false });
      expect(upload.mock.calls[1][2]).toEqual(expect.objectContaining({ contentType: 'image/webp' }));
      const imageUrls = rpc.mock.calls[0][1]._image_urls;
      expect(imageUrls).toEqual([firstPath, secondPath]);
      expect(imageUrls).not.toContain('looks/old.jpg');
      expect(audits()[0].metadata.image_count).toBe(2);
    });

    it('DD-LOOK-064 更新の置き場の失敗は 500 Failed to upload image ちょうどと監査 Failed to upload look image', async () => {
      const { client, rpc } = createClient({ uploadError: { message: 'bucket down SECRET' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, [createImage('a.png', 'image/png')])), {
        params: params(),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to upload image' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to upload look image',
        resourceId: '1',
        metadata: { image_type: 'image/png' },
      });
      expect(JSON.stringify(audits()[0])).not.toContain('looks/');
      expect(rpc).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 rpc の失敗（P0002）は 404 Look not found と監査 Look not found', async () => {
      const { client } = createClient({ rpcError: { code: 'P0002', message: 'LOOK_NOT_FOUND' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Look not found' });
      expect(audits()[0]).toMatchObject({ detail: 'Look not found', outcome: 'failure', resourceId: '1' });
    });

    it('DD-LOOK-064 rpc の失敗（外部キー違反 23503）は 400 Some linked items do not exist と監査', async () => {
      const { client } = createClient({ rpcError: { code: '23503', message: 'insert violates foreign key' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Some linked items do not exist' });
      expect(audits()[0]).toMatchObject({
        detail: 'Some linked items do not exist',
        metadata: { status: 'published', linked_item_ids: [1] },
      });
    });

    it('DD-LOOK-064 rpc の失敗（LOOK_ITEMS_WRITE_FAILED）は 500 Failed to update linked items と監査 Failed to update look-item links', async () => {
      const { client } = createClient({ rpcError: { code: 'P0001', message: 'LOOK_ITEMS_WRITE_FAILED' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to update linked items' });
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to update look-item links',
        metadata: { linked_item_ids: [1] },
      });
      expect(errorSpy).toHaveBeenCalledWith('Failed to update look-item links:', expect.anything());
    });

    it('DD-LOOK-064 rpc のその他の失敗は 500 Failed to update look で、DB の文を応答にもログにも監査にも出さない', async () => {
      const { client } = createClient({ rpcError: { code: '57014', message: 'canceling statement SECRET' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to update look' });
      expect(audits()[0]).toMatchObject({
        detail: 'Failed to update look',
        metadata: { status: 'published', linked_item_ids: [1] },
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
      expect(JSON.stringify(audits())).not.toContain('SECRET');
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

  describe('画像の後始末', () => {
    const OLD = ['looks/2026-01-01/old1.jpg', 'looks/2026-01-01/old2.jpg'];
    const withOld = (extra: Partial<ClientOptions> = {}) =>
      createClient({
        existingLook: { data: { id: 1, status: 'private', image_urls: OLD }, error: null },
        previousImages: OLD,
        ...extra,
      });
    const newImages = () => [createImage('a.png', 'image/png'), createImage('b.jpg', 'image/jpeg')];

    it('DD-LOOK-064 更新の存在確認は id と status だけを読む（古い画像は rpc の戻りで決める）', async () => {
      const { client, select } = createClient();
      mockCreateClient.mockResolvedValue(client);

      await PUT(createRequest(createForm()), { params: params() });

      expect(select).toHaveBeenCalledWith('id,status');
    });

    it('DD-LOOK-064 画像つきの更新の成功は、rpc の戻り（更新前の画像）から古い道筋だけを一度に置き場から消す', async () => {
      const { client, upload, storageRemove } = withOld();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, newImages())), { params: params() });

      expect(response.status).toBe(200);
      expect(storageRemove).toHaveBeenCalledTimes(1);
      expect(storageRemove).toHaveBeenCalledWith(OLD);
      const newPaths = upload.mock.calls.map((call: unknown[]) => call[0]);
      for (const path of newPaths) {
        expect(storageRemove.mock.calls[0][0]).not.toContain(path);
      }
    });

    it('DD-LOOK-064 古い道筋のうち、自分の接頭辞の外（古い見本・外の URL・..）は渡さない', async () => {
      const { client, storageRemove } = createClient({
        previousImages: ['looks/a.png', 'e2e/look-1-1.png', 'https://evil.example/looks/x.png', 'looks/../y.png'],
      });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, newImages())), { params: params() });

      expect(response.status).toBe(200);
      expect(storageRemove).toHaveBeenCalledWith(['looks/a.png']);
    });

    it('DD-LOOK-064 画像なしの更新は置き場を呼ばない', async () => {
      const { client, storageRemove } = withOld();
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm()), { params: params() });

      expect(response.status).toBe(200);
      expect(storageRemove).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 rpc が失敗したら、この要求で上げた新しい画像だけを消し、古い画像は消さない', async () => {
      const { client, upload, storageRemove } = withOld({ rpcError: { code: '57014', message: 'x' } });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, newImages())), { params: params() });

      expect(response.status).toBe(500);
      expect(storageRemove).toHaveBeenCalledTimes(1);
      expect(storageRemove).toHaveBeenCalledWith(upload.mock.calls.map((call: unknown[]) => call[0]));
      for (const old of OLD) {
        expect(storageRemove.mock.calls[0][0]).not.toContain(old);
      }
    });

    it('DD-LOOK-064 関連の段の失敗（LOOK_ITEMS_WRITE_FAILED）は 1 取引で戻るので、新しい画像を消し、古い画像は消さずに 500', async () => {
      const { client, upload, storageRemove } = withOld({
        rpcError: { code: 'P0001', message: 'LOOK_ITEMS_WRITE_FAILED' },
      });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, newImages())), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to update linked items' });
      expect(storageRemove).toHaveBeenCalledTimes(1);
      expect(storageRemove).toHaveBeenCalledWith(upload.mock.calls.map((call: unknown[]) => call[0]));
      for (const old of OLD) {
        expect(storageRemove.mock.calls[0][0]).not.toContain(old);
      }
    });

    it('DD-LOOK-064 2枚目の上げが失敗したら 1枚目だけを消し、行も古い画像も触れない', async () => {
      const { client, upload, storageRemove, rpc } = withOld({
        uploadError: { message: 'bucket SECRET' },
        failUploadAt: 1,
      });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, newImages())), { params: params() });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to upload image' });
      expect(storageRemove).toHaveBeenCalledWith([upload.mock.calls[0][0]]);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('DD-LOOK-064 置き場の削除が失敗しても 200 のままで、監査 success の metadata に image_cleanup と件数を残す', async () => {
      const { client } = withOld({ storageRemove: 'fail' });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, newImages())), { params: params() });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(audits()[0]).toMatchObject({
        outcome: 'success',
        metadata: expect.objectContaining({ image_cleanup: 'failed', orphaned_count: 2 }),
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
    });

    it('DD-LOOK-064 置き場の削除が例外を投げても 200 のまま', async () => {
      const { client } = withOld({ storageRemove: 'throw' });
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(createRequest(createForm({}, newImages())), { params: params() });

      expect(response.status).toBe(200);
    });

    it('DD-LOOK-064 古い道筋の重複は 1 回だけ渡す', async () => {
      const { client, storageRemove } = createClient({ previousImages: ['looks/a.png', 'looks/a.png'] });
      mockCreateClient.mockResolvedValue(client);

      await PUT(createRequest(createForm({}, [createImage('a.png', 'image/png')])), { params: params() });

      expect(storageRemove).toHaveBeenCalledWith(['looks/a.png']);
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

    it('DD-LOOK-064 rpc が例外を投げた時は、この要求で上げた新しい画像を置き場から消して 500 を返す', async () => {
      const { client, rpc, upload, storageRemove } = createClient();
      rpc.mockRejectedValue(new Error('rpc down'));
      mockCreateClient.mockResolvedValue(client);

      const response = await PUT(
        createRequest(createForm({}, [createImage('a.png', 'image/png'), createImage('b.jpg', 'image/jpeg')])),
        { params: params() },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(storageRemove).toHaveBeenCalledTimes(1);
      expect(storageRemove).toHaveBeenCalledWith(upload.mock.calls.map((call: unknown[]) => call[0]));
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
