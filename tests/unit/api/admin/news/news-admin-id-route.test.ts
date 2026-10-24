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
  signNewsImageFields: jest.fn(),
}));

const { createClient: mockCreateClient, createServiceRoleClient: mockCreateServiceRoleClient } =
  require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { logAudit: mockLogAudit } = require('@/lib/audit');
const { signNewsImageFields: mockSign } = require('@/lib/storage/news-images');

const { GET, PUT, PATCH, DELETE } = require('@/app/api/admin/news/[id]/route');

const FIVE_MB = 5 * 1024 * 1024;

const validFields: Record<string, string> = {
  title: 'Autumn collection',
  category: 'EVENT',
  date: '2026-10-24',
  content: 'Short summary',
  detailedContent: 'Long body',
  status: 'published',
};

function makeImage(name: string, type: string, size?: number): File {
  const file = new File(['img'], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { configurable: true, value: size });
  }
  return file;
}

function makeRequest(options: {
  fields?: Record<string, unknown>;
  body?: unknown;
  jsonError?: Error;
  formDataError?: Error;
  userAgent?: string | null;
} = {}) {
  const fields = options.fields ?? { ...validFields };
  const form = { get: (key: string) => (key in fields ? fields[key] : null) };
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === 'user-agent' ? options.userAgent ?? null : null),
    },
    formData: jest.fn(async () => {
      if (options.formDataError) throw options.formDataError;
      return form;
    }),
    json: jest.fn(async () => {
      if (options.jsonError) throw options.jsonError;
      return options.body;
    }),
  } as unknown as Request;
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function setupDb(result: { data?: unknown; error: unknown }) {
  const single = jest.fn().mockResolvedValue({ data: result.data ?? null, error: result.error });
  const selectEq = jest.fn().mockReturnValue({ single });
  const select = jest.fn().mockReturnValue({ eq: selectEq });
  const updateEq = jest.fn().mockResolvedValue({ error: result.error });
  const update = jest.fn().mockReturnValue({ eq: updateEq });
  const deleteEq = jest.fn().mockResolvedValue({ error: result.error });
  const del = jest.fn().mockReturnValue({ eq: deleteEq });
  const from = jest.fn().mockReturnValue({ select, update, delete: del });
  mockCreateClient.mockResolvedValue({ from });
  return { from, select, selectEq, single, update, updateEq, del, deleteEq };
}

function setupStorage(uploadError: unknown = null) {
  const upload = jest.fn().mockResolvedValue({ error: uploadError });
  const storageFrom = jest.fn().mockReturnValue({ upload });
  const service = { storage: { from: storageFrom } };
  mockCreateServiceRoleClient.mockResolvedValue(service);
  return { upload, storageFrom, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
  mockLogAudit.mockResolvedValue(undefined);
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

describe('authorization', () => {
  it.each([
    ['GET', 'admin.news.read'],
    ['PUT', 'admin.news.manage'],
    ['PATCH', 'admin.news.manage'],
    ['DELETE', 'admin.news.manage'],
  ])('DD-NEWS-065 %s は認可が ok:false の時にその応答を返し、表を触らない（求める権限 %s）', async (method, permission) => {
    const handlers: Record<string, (req: Request, ctx: unknown) => Promise<unknown>> = { GET, PUT, PATCH, DELETE };
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });
    const request = makeRequest({ body: { status: 'private' } });

    const res = await handlers[method](request, paramsFor('7'));

    expect(res).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith(permission, request);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(request.formData).not.toHaveBeenCalled();
    expect(request.json).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/news/:id', () => {
  it('DD-NEWS-065 GET で読み出しの error がある時は 404 Article not found', async () => {
    setupDb({ data: null, error: { message: 'PGRST116' } });
    setupStorage();

    const res = await GET(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 GET で error も行も無い時は 404 Article not found', async () => {
    setupDb({ data: null, error: null });
    setupStorage();

    const res = await GET(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
  });

  it('DD-NEWS-065 GET の成功で eq(id, 道の id) で読み、signNewsImageFields の結果を 200 で返す', async () => {
    const row = { id: 7, image_url: 'news/a.jpg', status: 'private' };
    const db = setupDb({ data: row, error: null });
    const storage = setupStorage();
    mockSign.mockResolvedValue({ ...row, image_url: 'https://signed/a.jpg' });
    const request = makeRequest();

    const res = await GET(request, paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 7, image_url: 'https://signed/a.jpg', status: 'private' } });
    expect(mockCreateClient).toHaveBeenCalledWith(request);
    expect(db.from).toHaveBeenCalledWith('news_articles');
    expect(db.select).toHaveBeenCalledWith('*');
    expect(db.selectEq).toHaveBeenCalledWith('id', '7');
    expect(mockSign).toHaveBeenCalledWith(storage.service, row);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 GET で params が例外を投げた時は 500 Internal server error', async () => {
    const res = await GET(makeRequest(), { params: Promise.reject(new Error('bad params')) });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/news/:id', () => {
  it.each([
    ['題が空白だけ', { title: '   ' }],
    ['分類が BLOG', { category: 'BLOG' }],
    ['日付が 2026/10/24', { date: '2026/10/24' }],
    ['状態が draft', { status: 'draft' }],
  ])('DD-NEWS-065 PUT で欄の形が合わない時（%s）は 400 Invalid request と details', async (_label, override) => {
    setupDb({ error: null });
    setupStorage();

    const res = await PUT(makeRequest({ fields: { ...validFields, ...override } }), paramsFor('7'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
    expect(body.details).toEqual(expect.objectContaining({ fieldErrors: expect.any(Object) }));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で image が無い時は置き場を呼ばず、更新に image_url を入れない', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith({
      title: 'Autumn collection',
      category: 'EVENT',
      published_date: '2026-10-24',
      content: 'Short summary',
      detailed_content: 'Long body',
      status: 'published',
    });
    expect(db.update.mock.calls[0][0]).not.toHaveProperty('image_url');
    expect(db.updateEq).toHaveBeenCalledWith('id', '7');
  });

  it('DD-NEWS-065 PUT で種類が4つの外の画像は 400 Unsupported image type', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.svg', 'image/svg+xml') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で 5MB を超える画像は 400 Image size must be 5MB or less', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png', FIVE_MB + 1) } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Image size must be 5MB or less' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ['photo.final.PNG', 'image/png', 'PNG'],
    ['noextension', 'image/jpeg', 'jpg'],
  ])('DD-NEWS-065 PUT で名前 %s の画像は拡張子 %s の道で上げ、更新に image_url を入れる', async (name, type, ext) => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(makeRequest({ fields: { ...validFields, image: makeImage(name, type) } }), paramsFor('7'));

    const path = `news/2026-10-24/uuid-1.${ext}`;
    expect(res.status).toBe(200);
    expect(storage.storageFrom).toHaveBeenCalledWith('news-images');
    expect(storage.upload).toHaveBeenCalledWith(path, expect.any(Buffer), {
      contentType: type,
      cacheControl: '3600',
      upsert: false,
    });
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ image_url: path }));
  });

  it('DD-NEWS-065 PUT で置き場の失敗の時に監査 admin.news.update.upload_failed（resource_id が id）と 500', async () => {
    const db = setupDb({ error: null });
    setupStorage({ message: 'storage down' });

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.gif', 'image/gif') }, userAgent: 'UA/1' }),
      paramsFor('7'),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to upload image' });
    expect(db.update).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.news.update.upload_failed',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'Image upload failed',
      user_agent: 'UA/1',
      metadata: { storagePath: 'news/2026-10-24/uuid-1.gif', articleId: '7', imageType: 'image/gif' },
    });
  });

  it('DD-NEWS-065 PUT で表の失敗の時に監査 admin.news.update.failed と 500', async () => {
    setupDb({ error: { message: 'rls' } });
    setupStorage();

    const res = await PUT(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update news article' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.update.failed',
        outcome: 'failure',
        resource_id: '7',
        detail: 'News article update failed',
        metadata: { articleId: '7', status: 'published', category: 'EVENT' },
      }),
    );
  });

  it('DD-NEWS-065 PUT の成功で監査 admin.news.update と 200 success', async () => {
    setupDb({ error: null });
    setupStorage();

    const res = await PUT(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.update',
        outcome: 'success',
        resource_id: '7',
        detail: 'News article updated',
        metadata: { articleId: '7', status: 'published', category: 'EVENT' },
      }),
    );
  });

  it('DD-NEWS-065 PUT で request.formData() が例外を投げた時は 500 Internal server error', async () => {
    const res = await PUT(makeRequest({ formDataError: new Error('bad multipart') }), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/news/:id', () => {
  it('DD-NEWS-065 PATCH で本文が JSON でない時は 500 Internal server error', async () => {
    setupDb({ error: null });

    const res = await PATCH(makeRequest({ jsonError: new SyntaxError('Unexpected token') }), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PATCH で値が draft の時は 400 Invalid request と details', async () => {
    setupDb({ error: null });

    const res = await PATCH(makeRequest({ body: { status: 'draft' } }), paramsFor('7'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
    expect(body.details).toEqual(expect.objectContaining({ fieldErrors: expect.any(Object) }));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PATCH で表の失敗の時に監査 admin.news.status_update.failed と 500', async () => {
    setupDb({ error: { message: 'rls' } });

    const res = await PATCH(makeRequest({ body: { status: 'private' } }), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update status' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.status_update.failed',
        outcome: 'failure',
        resource_id: '7',
        detail: 'News article status update failed',
        metadata: { articleId: '7', status: 'private' },
      }),
    );
  });

  it('DD-NEWS-065 PATCH の成功で status だけを書き、監査 admin.news.status_update と 200', async () => {
    const db = setupDb({ error: null });

    const res = await PATCH(makeRequest({ body: { status: 'published', title: 'ignored' } }), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(db.update).toHaveBeenCalledWith({ status: 'published' });
    expect(db.updateEq).toHaveBeenCalledWith('id', '7');
    expect(db.select).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.status_update',
        outcome: 'success',
        resource_id: '7',
        detail: 'News article status updated',
        metadata: { articleId: '7', status: 'published' },
      }),
    );
  });
});

describe('DELETE /api/admin/news/:id', () => {
  it('DD-NEWS-065 DELETE で表の失敗の時に監査 admin.news.delete.failed と 500', async () => {
    setupDb({ error: { message: 'rls' } });

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete article' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.delete.failed',
        outcome: 'failure',
        resource_id: '7',
        detail: 'News article delete failed',
        metadata: { articleId: '7' },
      }),
    );
  });

  it('DD-NEWS-065 DELETE の成功で delete().eq(id) を呼び、監査 admin.news.delete と 200', async () => {
    const db = setupDb({ error: null });

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(db.del).toHaveBeenCalled();
    expect(db.deleteEq).toHaveBeenCalledWith('id', '7');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.delete',
        outcome: 'success',
        resource_id: '7',
        detail: 'News article deleted',
        metadata: { articleId: '7' },
      }),
    );
  });

  it('DD-NEWS-065 DELETE で createClient が例外を投げた時は 500 Internal server error', async () => {
    mockCreateClient.mockRejectedValue(new Error('client boom'));

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('shared audit and zero-row behaviour', () => {
  it('DD-NEWS-065 監査の user_agent は見出しがある時はその値、無い時は null', async () => {
    setupDb({ error: null });
    await DELETE(makeRequest({ userAgent: 'Mozilla/5.0' }), paramsFor('7'));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ user_agent: 'Mozilla/5.0' }));

    setupDb({ error: null });
    await DELETE(makeRequest({ userAgent: null }), paramsFor('7'));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ user_agent: null }));
  });

  it('DD-NEWS-065 対象の行が0件でも PUT・PATCH・DELETE が 200 を返し成功として監査に残す（今の動きの記録）', async () => {
    // 表の模型は行数を返さない。窓口が行数を見ないことを、error なしの結果だけで 200 になることで示す
    setupDb({ error: null });
    setupStorage();
    const putRes = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.jpg', 'image/jpeg') } }),
      paramsFor('missing'),
    );
    const patchRes = await PATCH(makeRequest({ body: { status: 'private' } }), paramsFor('missing'));
    const deleteRes = await DELETE(makeRequest(), paramsFor('missing'));

    expect([putRes.status, patchRes.status, deleteRes.status]).toEqual([200, 200, 200]);
    expect(mockLogAudit.mock.calls.map(([entry]: [{ action: string; outcome: string; resource_id: string }]) => [
      entry.action,
      entry.outcome,
      entry.resource_id,
    ])).toEqual([
      ['admin.news.update', 'success', 'missing'],
      ['admin.news.status_update', 'success', 'missing'],
      ['admin.news.delete', 'success', 'missing'],
    ]);
  });
});
