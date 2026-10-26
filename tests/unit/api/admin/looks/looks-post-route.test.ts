export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
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
  enforceAdminLookMutationRateLimit: jest.fn(),
  consumeAdminLookUploadQuota: jest.fn(),
  validateLookImageBatch: jest.fn(),
}));

jest.mock('@/features/look/services/admin-audit', () => ({
  logAdminLookAudit: jest.fn(),
}));

jest.mock('@/lib/storage/look-images', () => ({
  signLookImageUrls: jest.fn(),
}));

import { POST } from '@/app/api/admin/looks/route';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import {
  consumeAdminLookUploadQuota,
  enforceAdminLookMutationRateLimit,
  validateLookImageBatch,
} from '@/features/look/services/admin-rate-limit';
import { logAdminLookAudit } from '@/features/look/services/admin-audit';
import { minimalGif, minimalJpeg, minimalPng, minimalWebp, textAsImage } from '../../../../fixtures/images';

const mockCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockAuthorize = authorizeAdminPermission as jest.Mock;
const mockMutationRateLimit = enforceAdminLookMutationRateLimit as jest.Mock;
const mockUploadQuota = consumeAdminLookUploadQuota as jest.Mock;
const mockValidateBatch = validateLookImageBatch as jest.Mock;
const mockAudit = logAdminLookAudit as jest.Mock;

type ServiceOptions = {
  itemsResult?: { data: Array<{ id: number }> | null; error: { message: string } | null };
  uploadError?: { message: string } | null;
  /** 何回目（0 始まり）の上げで失敗させるか。既定は全部 */
  failUploadAt?: number;
  removeResult?: { error: { message: string } | null } | 'throw';
  looksInsertResult?: { data: { id: number } | null; error: { message: string } | null };
  lookItemsInsertError?: { message: string } | null;
  lookDeleteError?: { message: string } | null;
};

function createService(options: ServiceOptions = {}) {
  const upload = jest.fn().mockImplementation(async () => {
    const callIndex = upload.mock.calls.length - 1;
    const failing = options.uploadError && (options.failUploadAt === undefined || options.failUploadAt === callIndex);
    return { error: failing ? options.uploadError : null };
  });
  const remove = jest.fn().mockImplementation(async () => {
    if (options.removeResult === 'throw') throw new Error('storage down');
    return options.removeResult ?? { error: null };
  });
  const lookDeleteEq = jest.fn().mockResolvedValue({ error: options.lookDeleteError ?? null });
  const looksInsert = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      single: jest
        .fn()
        .mockResolvedValue(options.looksInsertResult ?? { data: { id: 77 }, error: null }),
    }),
  });
  const lookItemsInsert = jest
    .fn()
    .mockResolvedValue({ error: options.lookItemsInsertError ?? null });
  const itemsIn = jest
    .fn()
    .mockResolvedValue(options.itemsResult ?? { data: [{ id: 1 }], error: null });

  const client = {
    storage: { from: jest.fn().mockReturnValue({ upload, remove }) },
    from: jest.fn((table: string) => {
      if (table === 'items') {
        return { select: jest.fn().mockReturnValue({ in: itemsIn }) };
      }
      if (table === 'looks') {
        return { insert: looksInsert, delete: jest.fn().mockReturnValue({ eq: lookDeleteEq }) };
      }
      if (table === 'look_items') {
        return { insert: lookItemsInsert };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };

  return { client, upload, remove, looksInsert, lookItemsInsert, lookDeleteEq, itemsIn };
}

const IMAGE_BYTES: Record<string, () => Buffer> = {
  'image/jpeg': minimalJpeg,
  'image/png': minimalPng,
  'image/webp': minimalWebp,
  'image/gif': minimalGif,
};

// 申告の種類に合う本物の先頭の印を持つ画像。bytes を渡すと中身をそれにする（申告とずらす試験用）。
function imageFile(name = 'look.jpg', type = 'image/jpeg', size?: number, bytes?: Buffer) {
  const content = bytes ?? (IMAGE_BYTES[type]?.() ?? textAsImage());
  const file = new File([new Uint8Array(content)], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    value: jest.fn().mockResolvedValue(new Uint8Array(content).buffer),
  });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
}

type FormOptions = {
  omit?: string[];
  overrides?: Record<string, string>;
  images?: File[];
};

function buildForm(options: FormOptions = {}) {
  const fields: Record<string, string> = {
    seasonYear: '2026',
    seasonType: 'SS',
    theme: 'Spring Light',
    themeDescription: 'Desc',
    status: 'published',
    linkedItemIds: JSON.stringify([1]),
    ...options.overrides,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (!options.omit?.includes(key)) {
      formData.set(key, value);
    }
  }
  for (const image of options.images ?? [imageFile()]) {
    formData.append('images', image);
  }
  return formData;
}

function buildRequest(formData: FormData | (() => Promise<FormData>)) {
  const request = new Request('http://localhost/api/admin/looks', {
    method: 'POST',
    headers: { 'user-agent': 'jest-test' },
  });
  Object.defineProperty(request, 'formData', {
    value: typeof formData === 'function' ? jest.fn(formData) : jest.fn().mockResolvedValue(formData),
  });
  return request;
}

// 戻り値は NextResponse のモック（status と body を持つ）か、認可・回数の部品が返した応答。
async function callPost(request: Request) {
  return (await POST(request)) as unknown as { status: number; body: unknown };
}

const failureAudit = (detail: string, extra: Record<string, unknown> = {}) =>
  expect.objectContaining({
    action: 'admin.look.create',
    outcome: 'failure',
    detail,
    actorId: 'admin-user',
    actorEmail: 'admin@example.com',
    ...extra,
  });

describe('POST /api/admin/looks', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthorize.mockResolvedValue({
      ok: true,
      userId: 'admin-user',
      actorEmail: 'admin@example.com',
    });
    mockMutationRateLimit.mockResolvedValue(null);
    mockUploadQuota.mockResolvedValue(null);
    mockValidateBatch.mockReturnValue(null);
    mockAudit.mockResolvedValue(undefined);
    mockCreateServiceRoleClient.mockResolvedValue(createService().client);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('DD-LOOK-063 作成の認可が通らない時は認可の応答を返し、回数も監査も動かさない', async () => {
    const denied = { status: 403, body: { error: 'Forbidden' } };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await callPost(buildRequest(buildForm()));

    expect(response).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.looks.manage', expect.any(Request));
    expect(mockMutationRateLimit).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 作成の回数が超過なら 429 の応答を返し、監査を残さない', async () => {
    const limited = { status: 429, body: { error: 'Too many requests' } };
    mockMutationRateLimit.mockResolvedValue(limited);
    const request = buildRequest(buildForm());

    const response = await callPost(request);

    expect(response).toBe(limited);
    expect(mockMutationRateLimit).toHaveBeenCalledWith({
      request,
      actorId: 'admin-user',
      kind: 'create',
    });
    expect(request.formData).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 linkedItemIds の欄が無い時は 400 で、例外の道で Invalid create payload を監査する', async () => {
    const response = await callPost(buildRequest(buildForm({ omit: ['linkedItemIds'] })));

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'Invalid request', details: expect.anything() }),
    );
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Invalid create payload', { metadata: { invalid_fields: [] } }),
    );
  });

  test('DD-LOOK-063 linkedItemIds が JSON として読めない時は 400 で同じ監査を残す', async () => {
    const response = await callPost(
      buildRequest(buildForm({ overrides: { linkedItemIds: '[1,' } })),
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({ error: 'Invalid request' }));
    expect(mockAudit).toHaveBeenCalledWith(failureAudit('Invalid create payload'));
  });

  test('DD-LOOK-063 linkedItemIds が数の配列でない時は 400 で同じ監査を残す', async () => {
    const response = await callPost(
      buildRequest(buildForm({ overrides: { linkedItemIds: '["a"]' } })),
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({ error: 'Invalid request' }));
    expect(mockAudit).toHaveBeenCalledWith(failureAudit('Invalid create payload'));
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 欄の形の誤りは 400 と誤りの欄の名前を返し、監査にも欄の名前を残す', async () => {
    const response = await callPost(buildRequest(buildForm({ overrides: { seasonType: 'FW' } })));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Invalid request',
      details: expect.objectContaining({
        fieldErrors: expect.objectContaining({ seasonType: expect.any(Array) }),
      }),
    });
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Invalid create payload', { metadata: { invalid_fields: ['seasonType'] } }),
    );
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 linkedItemIds が空の配列なら 400 になる', async () => {
    const response = await callPost(buildRequest(buildForm({ overrides: { linkedItemIds: '[]' } })));

    expect(response.status).toBe(400);
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Invalid create payload', { metadata: { invalid_fields: ['linkedItemIds'] } }),
    );
  });

  test('DD-LOOK-063 themeDescription の欄が無い時は空の文字として通り、保存される', async () => {
    const service = createService();
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(buildRequest(buildForm({ omit: ['themeDescription'] })));

    expect(response.status).toBe(201);
    expect(service.looksInsert).toHaveBeenCalledWith([
      expect.objectContaining({ theme_description: '' }),
    ]);
  });

  test('DD-LOOK-063 画像が0枚なら 400 At least one image is required と No image files provided の監査', async () => {
    const response = await callPost(buildRequest(buildForm({ images: [] })));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'At least one image is required' });
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('No image files provided', {
        metadata: { linked_item_ids: [1], status: 'published' },
      }),
    );
    expect(mockValidateBatch).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 images の欄にファイルでない値だけがある時も 0 枚として断る', async () => {
    const formData = buildForm({ images: [] });
    formData.append('images', 'not-a-file');

    const response = await callPost(buildRequest(formData));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'At least one image is required' });
  });

  test('DD-LOOK-063 枚数や合計の上限の文が返る時は 400 でその文を監査に残す', async () => {
    mockValidateBatch.mockReturnValue('You can upload up to 6 images at once');
    const images = Array.from({ length: 7 }, (_, index) => imageFile(`look-${index}.jpg`));

    const response = await callPost(buildRequest(buildForm({ images })));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'You can upload up to 6 images at once' });
    expect(mockValidateBatch).toHaveBeenCalledWith(expect.arrayContaining([expect.any(File)]));
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('You can upload up to 6 images at once', {
        metadata: { image_count: 7, linked_item_ids: [1], status: 'published' },
      }),
    );
  });

  test('DD-LOOK-063 申告の種類が4つ以外なら 400 Unsupported image type', async () => {
    const response = await callPost(
      buildRequest(buildForm({ images: [imageFile('note.txt', 'text/plain')] })),
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Unsupported image type' });
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Unsupported image type', {
        metadata: { image_type: 'text/plain', image_count: 1 },
      }),
    );
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 1枚が 5MB を超えたら 400 Image size must be 5MB or less', async () => {
    const tooBig = 5 * 1024 * 1024 + 1;

    const response = await callPost(
      buildRequest(buildForm({ images: [imageFile('big.png', 'image/png', tooBig)] })),
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Image size must be 5MB or less' });
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Image size limit exceeded', {
        metadata: { image_size: tooBig, image_type: 'image/png' },
      }),
    );
  });

  test('DD-LOOK-063 ちょうど 5MB の画像は大きさの検査を通る', async () => {
    const service = createService();
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(
      buildRequest(buildForm({ images: [imageFile('edge.webp', 'image/webp', 5 * 1024 * 1024)] })),
    );

    expect(response.status).toBe(201);
  });

  test('DD-LOOK-063 商品の照らしに失敗したら 500 Failed to validate linked items', async () => {
    const service = createService({ itemsResult: { data: null, error: { message: 'db down' } } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to validate linked items' });
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Failed to validate linked items', {
        metadata: { linked_item_ids: [1], status: 'published' },
      }),
    );
    expect(mockUploadQuota).not.toHaveBeenCalled();
    expect(service.upload).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 商品の数が合わない時は 400 Some linked items do not exist', async () => {
    const service = createService({ itemsResult: { data: [{ id: 1 }], error: null } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(
      buildRequest(buildForm({ overrides: { linkedItemIds: JSON.stringify([1, 2]) } })),
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Some linked items do not exist' });
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Some linked items do not exist', {
        metadata: { linked_item_ids: [1, 2], status: 'published' },
      }),
    );
    expect(service.itemsIn).toHaveBeenCalledWith('id', [1, 2]);
  });

  test('DD-LOOK-063 商品の data が空（null）の時も 400 Some linked items do not exist', async () => {
    const service = createService({ itemsResult: { data: null, error: null } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Some linked items do not exist' });
  });

  test('DD-LOOK-063 1時間の画像の量が超過なら 429 の応答を返し、上げも監査もしない', async () => {
    const limited = { status: 429, body: { error: 'Too many uploads' } };
    mockUploadQuota.mockResolvedValue(limited);
    const service = createService();
    mockCreateServiceRoleClient.mockResolvedValue(service.client);
    const images = [imageFile('a.jpg', 'image/jpeg', 100), imageFile('b.jpg', 'image/jpeg', 250)];

    const response = await callPost(buildRequest(buildForm({ images })));

    expect(response).toBe(limited);
    expect(mockUploadQuota).toHaveBeenCalledWith({
      actorId: 'admin-user',
      kind: 'create',
      totalBytes: 350,
    });
    expect(service.upload).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 置き場への上げに失敗したら 500 Failed to upload image ちょうどで、置き場の文を応答にも記録にも出さない', async () => {
    const service = createService({ uploadError: { message: 'bucket details SECRET' } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to upload image' });
    expect(JSON.stringify(response.body)).not.toContain('SECRET');
    expect(mockAudit).toHaveBeenCalledWith(failureAudit('Failed to upload look image'));
    expect(service.looksInsert).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('SECRET');
  });

  test('DD-LOOK-063 保存名は検出した種類から作り、送られた名前は使わず、設定つきで上げる', async () => {
    const service = createService();
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(
      buildRequest(
        buildForm({
          images: [imageFile('a/b.html', 'image/png'), imageFile('noext', 'image/gif')],
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(service.client.storage.from).toHaveBeenCalledWith('look-images');
    expect(service.upload).toHaveBeenCalledTimes(2);
    const [firstPath, firstBuffer, firstOptions] = service.upload.mock.calls[0];
    const [secondPath, , secondOptions] = service.upload.mock.calls[1];
    expect(firstPath).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(secondPath).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.gif$/);
    expect(Buffer.isBuffer(firstBuffer)).toBe(true);
    expect(firstOptions).toEqual({ contentType: 'image/png', cacheControl: '3600', upsert: false });
    expect(secondOptions).toEqual({ contentType: 'image/gif', cacheControl: '3600', upsert: false });
    expect(service.looksInsert).toHaveBeenCalledWith([
      expect.objectContaining({ image_urls: [firstPath, secondPath] }),
    ]);
  });

  test('DD-LOOK-063 looks の保存に失敗したら 500 Failed to save look と監査', async () => {
    const service = createService({
      looksInsertResult: { data: null, error: { message: 'insert failed' } },
    });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to save look' });
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Failed to insert look', {
        metadata: { status: 'published', linked_item_ids: [1], image_count: 1 },
      }),
    );
    expect(service.lookItemsInsert).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 looks の保存で id が返らない時も 500 Failed to save look', async () => {
    const service = createService({ looksInsertResult: { data: null, error: null } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to save look' });
    expect(service.lookItemsInsert).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 look_items の保存に失敗したら作った looks の行を消して 500 Failed to save linked items', async () => {
    const service = createService({ lookItemsInsertError: { message: 'fk violation' } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to save linked items' });
    expect(service.lookDeleteEq).toHaveBeenCalledWith('id', 77);
    expect(mockAudit).toHaveBeenCalledWith(
      failureAudit('Failed to create look-item links', {
        resourceId: 77,
        metadata: { status: 'published', linked_item_ids: [1] },
      }),
    );
  });

  test('DD-LOOK-063 正しい欄と画像なら 201 で id を返し、関連を保存して success を監査する', async () => {
    const service = createService({ itemsResult: { data: [{ id: 1 }, { id: 2 }], error: null } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callPost(
      buildRequest(
        buildForm({
          overrides: {
            seasonYear: '2027',
            seasonType: 'AW',
            theme: '  Night  ',
            linkedItemIds: JSON.stringify([1, 2]),
            status: 'private',
          },
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ success: true, id: 77 });
    expect(service.looksInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        season_year: 2027,
        season_type: 'AW',
        theme: 'Night',
        status: 'private',
      }),
    ]);
    expect(service.lookItemsInsert).toHaveBeenCalledWith([
      { look_id: 77, item_id: 1 },
      { look_id: 77, item_id: 2 },
    ]);
    expect(service.lookDeleteEq).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.look.create',
        outcome: 'success',
        detail: 'Look created',
        resourceId: 77,
        metadata: {
          status: 'private',
          linked_item_ids: [1, 2],
          image_count: 1,
          season_year: 2027,
          season_type: 'AW',
        },
      }),
    );
  });

  describe('画像の中身と後始末', () => {
    test('DD-LOOK-063 文字のファイルを image/png と申告すると 400 で、置き場にも量の枠にも触れず、中身もファイル名も監査に残さない', async () => {
      const service = createService();
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(
        buildRequest(buildForm({ images: [imageFile('secret-name.png', 'image/png', undefined, textAsImage())] })),
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Unsupported image type' });
      expect(service.upload).not.toHaveBeenCalled();
      expect(mockUploadQuota).not.toHaveBeenCalled();
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockAudit).toHaveBeenCalledWith(failureAudit('Unsupported image type'));
      const audited = JSON.stringify(mockAudit.mock.calls);
      expect(audited).not.toContain('secret-name');
      expect(audited).not.toContain('plain text');
    });

    test('DD-LOOK-063 PNG の中身を image/jpeg と申告しても 400 になる', async () => {
      const response = await callPost(
        buildRequest(buildForm({ images: [imageFile('a.jpg', 'image/jpeg', undefined, minimalPng())] })),
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Unsupported image type' });
      expect(mockUploadQuota).not.toHaveBeenCalled();
    });

    test('DD-LOOK-063 名前が a/b.html の本物の PNG は検出した png の保存名で上げ、行も同じ道筋を持つ', async () => {
      const service = createService();
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm({ images: [imageFile('a/b.html', 'image/png')] })));

      expect(response.status).toBe(201);
      const [path, , options] = service.upload.mock.calls[0];
      expect(path).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
      expect(options).toEqual(expect.objectContaining({ contentType: 'image/png' }));
      expect(service.looksInsert).toHaveBeenCalledWith([expect.objectContaining({ image_urls: [path] })]);
      expect(service.remove).not.toHaveBeenCalled();
    });

    test('DD-LOOK-063 2枚目の上げが失敗したら 500 Failed to upload image ちょうどで、1枚目だけを置き場から消し、記録は名前と符号だけ', async () => {
      const service = createService({ uploadError: { message: 'bucket details SECRET' }, failUploadAt: 1 });
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(
        buildRequest(buildForm({ images: [imageFile('a.png', 'image/png'), imageFile('b.png', 'image/png')] })),
      );

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to upload image' });
      expect(service.remove).toHaveBeenCalledTimes(1);
      expect(service.remove).toHaveBeenCalledWith([service.upload.mock.calls[0][0]]);
      expect(service.looksInsert).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to upload look image:', { name: 'UnknownError', code: null });
    });

    test('DD-LOOK-063 looks の保存が失敗したら、上げた全部の道筋を置き場から消す', async () => {
      const service = createService({ looksInsertResult: { data: null, error: { message: 'insert failed' } } });
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(
        buildRequest(buildForm({ images: [imageFile('a.png', 'image/png'), imageFile('b.jpg', 'image/jpeg')] })),
      );

      expect(response.status).toBe(500);
      expect(service.remove).toHaveBeenCalledTimes(1);
      expect(service.remove).toHaveBeenCalledWith([
        service.upload.mock.calls[0][0],
        service.upload.mock.calls[1][0],
      ]);
    });

    test('DD-LOOK-063 look_items の保存が失敗したら、作った行を消し、上げた画像も置き場から消す', async () => {
      const service = createService({ lookItemsInsertError: { message: 'fk violation' } });
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm()));

      expect(response.status).toBe(500);
      expect(service.lookDeleteEq).toHaveBeenCalledWith('id', 77);
      expect(service.remove).toHaveBeenCalledWith([service.upload.mock.calls[0][0]]);
    });

    test('DD-LOOK-063 look_items の保存も looks の行の削除も失敗したら、行が残るので画像は消さず、監査に row_cleanup を残す', async () => {
      const service = createService({
        lookItemsInsertError: { message: 'fk violation' },
        lookDeleteError: { message: 'delete SECRET' },
      });
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm()));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to save linked items' });
      expect(service.lookDeleteEq).toHaveBeenCalledWith('id', 77);
      expect(service.remove).not.toHaveBeenCalled();
      expect(mockAudit).toHaveBeenCalledWith(
        failureAudit('Failed to create look-item links', {
          resourceId: 77,
          metadata: expect.objectContaining({ row_cleanup: 'failed' }),
        }),
      );
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('SECRET');
    });

    test('DD-LOOK-063 置き場の削除が失敗しても応答の状態は変わらず、監査の metadata に orphaned_count を残す', async () => {
      const service = createService({
        looksInsertResult: { data: null, error: { message: 'insert failed' } },
        removeResult: { error: { message: 'storage SECRET' } },
      });
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm({ images: [imageFile('a.png', 'image/png')] })));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to save look' });
      expect(mockAudit).toHaveBeenCalledWith(
        failureAudit('Failed to insert look', {
          metadata: expect.objectContaining({ orphaned_count: 1, image_cleanup: 'failed' }),
        }),
      );
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('SECRET');
    });

    test('DD-LOOK-063 置き場の削除が例外を投げても応答は同じ（投げ直さない）', async () => {
      const service = createService({
        looksInsertResult: { data: null, error: { message: 'insert failed' } },
        removeResult: 'throw',
      });
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm()));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to save look' });
    });

    test('DD-LOOK-063 行を作った後の例外（関連の保存が投げる）では、行が指している画像を消さない', async () => {
      const service = createService();
      service.lookItemsInsert.mockRejectedValue(new Error('network down'));
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm()));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
      expect(service.remove).not.toHaveBeenCalled();
    });

    test('DD-LOOK-063 行を作る前の例外（行の保存が投げる）では、上げた画像を消す', async () => {
      const service = createService();
      service.looksInsert.mockImplementation(() => {
        throw new Error('client exploded');
      });
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm()));

      expect(response.status).toBe(500);
      expect(service.remove).toHaveBeenCalledWith([service.upload.mock.calls[0][0]]);
    });

    test('DD-LOOK-063 成功した作成では置き場から何も消さない', async () => {
      const service = createService();
      mockCreateServiceRoleClient.mockResolvedValue(service.client);

      const response = await callPost(buildRequest(buildForm()));

      expect(response.status).toBe(201);
      expect(service.remove).not.toHaveBeenCalled();
    });
  });

  test('DD-LOOK-063 操作者が分かった後の例外は 500 Internal server error で Unexpected create error を監査する', async () => {
    mockMutationRateLimit.mockRejectedValue(new Error('counter exploded'));

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-user',
        actorEmail: 'admin@example.com',
        outcome: 'failure',
        detail: 'Unexpected create error',
        metadata: undefined,
      }),
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('DD-LOOK-063 multipart として読めない要求は 500 Internal server error になる', async () => {
    const request = buildRequest(async () => {
      throw new TypeError('not multipart');
    });

    const response = await callPost(request);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'Unexpected create error' }),
    );
  });

  test('DD-LOOK-063 認可の前の例外は 500 を返すが、操作者が分からないので監査を残さない', async () => {
    mockAuthorize.mockRejectedValue(new Error('rbac exploded'));

    const response = await callPost(buildRequest(buildForm()));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(mockAudit).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
