import { minimalGif, minimalJpeg, minimalPng, minimalWebp, textAsImage } from '../../../../fixtures/images';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/storage/news-images', () => ({
  ...jest.requireActual('@/lib/storage/news-images'),
  signNewsImageFields: jest.fn(),
}));

const { createClient: mockCreateClient, createServiceRoleClient: mockCreateServiceRoleClient } =
  require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { logAudit: mockLogAudit } = require('@/lib/audit');
const { signNewsImageFields: mockSign } = require('@/lib/storage/news-images');

const { GET, POST } = require('@/app/api/admin/news/route');

const FIVE_MB = 5 * 1024 * 1024;

const validFields: Record<string, string> = {
  title: 'Autumn collection',
  category: 'COLLECTION',
  date: '2026-10-24',
  content: 'Short summary',
  detailedContent: 'Long body',
  status: 'private',
};

const REAL_BYTES: Record<string, () => Buffer> = {
  'image/jpeg': minimalJpeg,
  'image/png': minimalPng,
  'image/webp': minimalWebp,
  'image/gif': minimalGif,
};

function makeImage(name: string, type: string, size?: number, bytes?: Buffer): File {
  const content = bytes ?? REAL_BYTES[type]?.() ?? textAsImage();
  const file = new File([new Uint8Array(content)], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => new Uint8Array(content).buffer,
  });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { configurable: true, value: size });
  }
  return file;
}

function makeRequest(options: {
  fields?: Record<string, unknown>;
  userAgent?: string | null;
  realIp?: string;
  forwardedFor?: string;
  formDataError?: Error;
} = {}) {
  const fields = options.fields ?? { ...validFields, image: makeImage('a.jpg', 'image/jpeg') };
  const form = { get: (key: string) => (key in fields ? fields[key] : null) };
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'user-agent') return options.userAgent ?? null;
        if (key === 'x-real-ip') return options.realIp ?? null;
        if (key === 'x-forwarded-for') return options.forwardedFor ?? null;
        return null;
      },
    },
    formData: jest.fn(async () => {
      if (options.formDataError) throw options.formDataError;
      return form;
    }),
  } as unknown as Request;
}

function setupPostMocks(options: {
  uploadError?: unknown;
  removeError?: unknown;
  insertResult?: { data: unknown; error: unknown };
} = {}) {
  const upload = jest.fn().mockResolvedValue({ error: options.uploadError ?? null });
  const remove = jest.fn().mockResolvedValue({ error: options.removeError ?? null });
  const storageFrom = jest.fn().mockReturnValue({ upload, remove });
  const single = jest
    .fn()
    .mockResolvedValue(options.insertResult ?? { data: { id: 42 }, error: null });
  const select = jest.fn().mockReturnValue({ single });
  const insert = jest.fn().mockReturnValue({ select });
  const from = jest.fn().mockReturnValue({ insert });
  mockCreateServiceRoleClient.mockResolvedValue({ from, storage: { from: storageFrom } });
  return { upload, remove, storageFrom, insert, select, from };
}

function setupGetMocks(result: { data: unknown; error: unknown }) {
  const order = jest.fn().mockResolvedValue(result);
  const select = jest.fn().mockReturnValue({ order });
  const from = jest.fn().mockReturnValue({ select });
  const service = { storage: {} };
  mockCreateClient.mockResolvedValue({ from });
  mockCreateServiceRoleClient.mockResolvedValue(service);
  return { from, select, order, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: jest.fn(() => 'uuid-1'),
  });
  jest.useFakeTimers({ now: new Date('2026-10-24T15:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('POST /api/admin/news', () => {
  it('DD-NEWS-064 POST は認可が ok:false の時にその応答をそのまま返し、表も置き場も触らない', async () => {
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });
    const request = makeRequest();

    const res = await POST(request);

    expect(res).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.news.manage', request);
    expect(request.formData).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it.each([
    ['題が空白だけ', { title: '   ' }],
    ['題が201字', { title: 'a'.repeat(201) }],
    ['分類が BLOG', { category: 'BLOG' }],
    ['日付が 2026/10/24', { date: '2026/10/24' }],
    ['状態が draft', { status: 'draft' }],
    ['本文が2001字', { content: 'a'.repeat(2001) }],
    ['詳しい本文が10001字', { detailedContent: 'a'.repeat(10001) }],
    ['欄が無い', { title: null }],
  ])('DD-NEWS-064 POST で欄の形が合わない時（%s）は 400 Invalid request と details を返す', async (_label, override) => {
    const mocks = setupPostMocks();
    const res = await POST(
      makeRequest({ fields: { ...validFields, ...override, image: makeImage('a.jpg', 'image/jpeg') } }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
    expect(body.details).toEqual(expect.objectContaining({ fieldErrors: expect.any(Object) }));
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['無い', undefined],
    ['文字', 'not-a-file'],
  ])('DD-NEWS-064 POST で image が%sの時は 400 Image file is required', async (_label, image) => {
    const mocks = setupPostMocks();
    const fields: Record<string, unknown> = { ...validFields };
    if (image !== undefined) fields.image = image;

    const res = await POST(makeRequest({ fields }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Image file is required' });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 POST で image/svg+xml の時は 400 Unsupported image type', async () => {
    const mocks = setupPostMocks();
    const res = await POST(
      makeRequest({ fields: { ...validFields, image: makeImage('a.svg', 'image/svg+xml') } }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 POST で HTML を image/png と申告した画像は 400 Unsupported image type で、置き場に書かず service role の client も作らない（SEC-NEWS-017）', async () => {
    const mocks = setupPostMocks();
    const res = await POST(
      makeRequest({
        fields: { ...validFields, image: makeImage('a.png', 'image/png', undefined, Buffer.from('<html><script>alert(1)</script></html>')) },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 POST で PNG の中身を image/jpeg と申告した画像は 400 Unsupported image type（申告と検出が違う）', async () => {
    const mocks = setupPostMocks();
    const res = await POST(
      makeRequest({ fields: { ...validFields, image: makeImage('a.jpg', 'image/jpeg', undefined, minimalPng()) } }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 POST で 5MB を1バイト超える画像は 400 Image size must be 5MB or less', async () => {
    const mocks = setupPostMocks();
    const res = await POST(
      makeRequest({ fields: { ...validFields, image: makeImage('a.jpg', 'image/jpeg', FIVE_MB + 1) } }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Image size must be 5MB or less' });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 POST でちょうど 5MB の画像は通って 201 を返す', async () => {
    const mocks = setupPostMocks();
    const res = await POST(
      makeRequest({ fields: { ...validFields, image: makeImage('a.jpg', 'image/jpeg', FIVE_MB) } }),
    );

    expect(res.status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ])('DD-NEWS-064 POST で %s は種類から決めた拡張子 %s の道に upsert:false・cacheControl 3600 で上げる', async (type, ext) => {
    const mocks = setupPostMocks();
    const res = await POST(
      makeRequest({ fields: { ...validFields, image: makeImage('photo.PNG', type) } }),
    );

    expect(res.status).toBe(201);
    expect(mocks.storageFrom).toHaveBeenCalledWith('news-images');
    expect(mocks.upload).toHaveBeenCalledWith(
      `news/2026-10-24/uuid-1.${ext}`,
      expect.any(Buffer),
      { contentType: type, cacheControl: '3600', upsert: false },
    );
  });

  it('DD-NEWS-064 POST で置き場の失敗の時に監査 admin.news.create.upload_failed と 500 を返し、insert を呼ばない', async () => {
    const mocks = setupPostMocks({ uploadError: { message: 'storage down' } });

    const res = await POST(makeRequest({ userAgent: 'UA/1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to upload image' });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.news.create.upload_failed',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: null,
      outcome: 'failure',
      detail: 'Image upload failed',
      ip: null,
      user_agent: 'UA/1',
      metadata: { storagePath: 'news/2026-10-24/uuid-1.jpg', status: 'private', imageType: 'image/jpeg' },
    });
  });

  it('DD-NEWS-064 POST で insert の失敗の時に監査 admin.news.create.db_insert_failed と 500 を返す', async () => {
    setupPostMocks({ insertResult: { data: null, error: { message: 'rls' } } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save news article' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.create.db_insert_failed',
        outcome: 'failure',
        resource_id: null,
        detail: 'News article insert failed',
        metadata: { storagePath: 'news/2026-10-24/uuid-1.jpg', status: 'private', category: 'COLLECTION', imageCleanup: 'ok' },
      }),
    );
  });

  it('DD-NEWS-064 POST で insert が失敗したら、上げた道筋を news-images から 1 回だけ remove し、service role の client が受ける（SEC-NEWS-018）', async () => {
    const mocks = setupPostMocks({ insertResult: { data: null, error: { message: 'rls' } } });

    await POST(makeRequest());

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(['news/2026-10-24/uuid-1.jpg']);
    expect(mocks.storageFrom).toHaveBeenLastCalledWith('news-images');
  });

  it('DD-NEWS-064 POST で insert の失敗の後の remove も失敗しても、応答は 500 Failed to save news article のままで、監査に imageCleanup:failed を残す', async () => {
    setupPostMocks({
      insertResult: { data: null, error: { message: 'rls' } },
      removeError: { name: 'StorageApiError', code: '500', message: 'secret bucket detail' },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save news article' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.create.db_insert_failed',
        metadata: expect.objectContaining({ imageCleanup: 'failed' }),
      }),
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('DD-NEWS-064 POST の成功では置き場から何も remove しない', async () => {
    const mocks = setupPostMocks();

    await POST(makeRequest());

    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 POST の成功で insert の image_url が署名前の道、監査の resource_id が新しい id の文字、201 success と id を返す', async () => {
    const mocks = setupPostMocks({ insertResult: { data: { id: 42 }, error: null } });
    const request = makeRequest({ fields: { ...validFields, title: '  Autumn collection  ', status: 'published', image: makeImage('a.webp', 'image/webp') } });

    const res = await POST(request);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, id: 42 });
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledWith('news_articles');
    expect(mocks.insert).toHaveBeenCalledWith([
      {
        title: 'Autumn collection',
        category: 'COLLECTION',
        published_date: '2026-10-24',
        image_url: 'news/2026-10-24/uuid-1.webp',
        content: 'Short summary',
        detailed_content: 'Long body',
        status: 'published',
      },
    ]);
    expect(mocks.select).toHaveBeenCalledWith('id');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.create',
        outcome: 'success',
        resource_id: '42',
        detail: 'News article created',
        metadata: { storagePath: 'news/2026-10-24/uuid-1.webp', status: 'published', category: 'COLLECTION' },
      }),
    );
  });

  it('DD-NEWS-064 POST の insert の結果の id が null の時は監査の resource_id を null にして 201 を返す', async () => {
    setupPostMocks({ insertResult: { data: { id: null }, error: null } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, id: null });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.news.create', resource_id: null }),
    );
  });

  it('DD-NEWS-064 POST の insert が error も data も返さない時は、監査の resource_id を null で成功に残した後に 500 Internal server error になる', async () => {
    setupPostMocks({ insertResult: { data: null, error: null } });

    const res = await POST(makeRequest());

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.news.create', outcome: 'success', resource_id: null }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('DD-NEWS-064 監査の user_agent は見出し user-agent がある時はその値、無い時は null', async () => {
    setupPostMocks();
    await POST(makeRequest({ userAgent: 'Mozilla/5.0' }));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ user_agent: 'Mozilla/5.0' }));

    setupPostMocks();
    await POST(makeRequest({ userAgent: null }));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ user_agent: null }));
  });

  it('DD-NEWS-064 監査の ip は信頼する見出し x-real-ip の値で、偽の x-forwarded-for は入れず、見出しが無ければ null（SEC-NEWS-016-AC-03）', async () => {
    setupPostMocks();
    await POST(makeRequest({ realIp: '203.0.113.9', forwardedFor: '198.51.100.7' }));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ ip: '203.0.113.9' }));
    expect(JSON.stringify(mockLogAudit.mock.calls.at(-1))).not.toContain('198.51.100.7');

    setupPostMocks();
    await POST(makeRequest({ forwardedFor: '198.51.100.7' }));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ ip: null }));
  });

  it('DD-NEWS-064 POST で request.formData() が例外を投げた時は 500 Internal server error', async () => {
    setupPostMocks();

    const res = await POST(makeRequest({ formDataError: new Error('bad multipart') }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 POST で insert が例外を投げた時も、上げた画像を remove して 500 Internal server error を返す', async () => {
    const mocks = setupPostMocks();
    mocks.insert.mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(mocks.remove).toHaveBeenCalledWith(['news/2026-10-24/uuid-1.jpg']);
  });
});

describe('GET /api/admin/news', () => {
  it('DD-NEWS-064 GET は認可が ok:false の時にその応答をそのまま返し、表を触らない', async () => {
    const denied = { status: 401, json: async () => ({ error: 'Unauthorized' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });
    const request = makeRequest();

    const res = await GET(request);

    expect(res).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.news.read', request);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 GET の成功で published_date の降順で読み、行ごとに signNewsImageFields を呼んで 200 で返す', async () => {
    const rows = [
      { id: 2, image_url: 'news/b.jpg' },
      { id: 1, image_url: 'news/a.jpg' },
    ];
    const mocks = setupGetMocks({ data: rows, error: null });
    mockSign.mockImplementation(async (_client: unknown, row: { id: number }) => ({ ...row, image_url: `signed-${row.id}` }));
    const request = makeRequest();

    const res = await GET(request);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { id: 2, image_url: 'signed-2' },
        { id: 1, image_url: 'signed-1' },
      ],
    });
    expect(mockCreateClient).toHaveBeenCalledWith(request);
    expect(mocks.from).toHaveBeenCalledWith('news_articles');
    expect(mocks.select).toHaveBeenCalledWith('*');
    expect(mocks.order).toHaveBeenCalledWith('published_date', { ascending: false });
    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(mockSign).toHaveBeenNthCalledWith(1, mocks.service, rows[0]);
    expect(mockSign).toHaveBeenNthCalledWith(2, mocks.service, rows[1]);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 GET で data が null の時は 200 で空の配列を返す', async () => {
    setupGetMocks({ data: null, error: null });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('DD-NEWS-064 GET で表の失敗の時は 500 Failed to fetch news articles で、誤りの文を記録に出さない（SEC-NEWS-020）', async () => {
    setupGetMocks({ data: null, error: Object.assign(new Error('db down secret'), { code: 'XX000' }) });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch news articles' });
    expect(mockSign).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Failed to fetch news articles:', { name: 'Error', code: 'XX000' });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('DD-NEWS-064 GET で例外の時は 500 Internal server error', async () => {
    setupGetMocks({ data: [{ id: 1 }], error: null });
    mockSign.mockRejectedValue(new Error('sign boom'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
